// Build-time data fetcher: books.yaml -> Wikidata + Wikipedia (+ Open Library) -> JSON cache + WebP images.
// Failures never break the build: a book that can't be fetched keeps its previous cached entry.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import sharp from 'sharp';
import { parse } from 'node-html-parser';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOKS_YAML = path.join(ROOT, 'src/data/books.yaml');
const OUT_JSON = path.join(ROOT, 'src/data/generated/books.json');
const IMG_DIR = path.join(ROOT, 'public/images');
const UA = 'BeriOlvasokor/1.0 (https://github.com/malloc9/book-club)';
const LANGS = ['hu', 'en'];

// ---------- HTTP helpers ----------
async function getJson(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(u, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
    if (res.ok) return res.json();
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`HTTP ${res.status} for ${u}`);
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}
async function getBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
const wd = (params) => getJson('https://www.wikidata.org/w/api.php', { format: 'json', ...params });
const wp = (lang, params) =>
  getJson(`https://${lang}.wikipedia.org/w/api.php`, { format: 'json', formatversion: '2', ...params });

// ---------- small utils ----------
export function slugify(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
const stripHtml = (s) =>
  (s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

// Commons sometimes renders the artist twice ("Unknown authorUnknown author").
const dedupeRepeat = (s) => {
  const h = s.length / 2;
  return Number.isInteger(h) && s.slice(0, h) === s.slice(h) ? s.slice(0, h) : s;
};

const HU_MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július',
  'augusztus', 'szeptember', 'október', 'november', 'december'];
function formatWdTime(v) {
  if (!v) return null;
  const m = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(v.time);
  if (!m) return null;
  const [, , y, mo, d] = m;
  const year = String(Number(y));
  if (v.precision <= 9 || mo === '00') return `${year}`;
  if (v.precision === 10 || d === '00') return `${year}. ${HU_MONTHS[Number(mo) - 1]}`;
  return `${year}. ${HU_MONTHS[Number(mo) - 1]} ${Number(d)}.`;
}

// ---------- Wikidata ----------
const entityCache = new Map();
async function getEntities(ids) {
  const missing = ids.filter((id) => !entityCache.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const data = await wd({
      action: 'wbgetentities',
      ids: chunk.join('|'),
      props: 'labels|claims|sitelinks',
      languages: 'hu|en',
      sitefilter: 'huwiki|enwiki',
    });
    for (const [id, e] of Object.entries(data.entities ?? {})) entityCache.set(id, e);
  }
  return ids.map((id) => entityCache.get(id));
}
const label = (e) => e?.labels?.hu?.value ?? e?.labels?.en?.value ?? null;
const claimValues = (e, p) =>
  (e?.claims?.[p] ?? [])
    .filter((c) => c.rank !== 'deprecated' && c.mainsnak?.datavalue)
    .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'))
    .map((c) => c.mainsnak.datavalue.value);
const itemIds = (e, p) => claimValues(e, p).map((v) => v.id).filter(Boolean);
// Hungarian names for common literary terms that often lack a Hungarian label on Wikidata.
// Keys are the lowercase English labels. Missing ones are reported during the fetch.
const HU_TERMS = {
  'modernist literature': 'modernista irodalom',
  modernism: 'modernizmus',
  'psychological fiction': 'lélektani próza',
  'psychological novel': 'lélektani regény',
  autofiction: 'autofikció',
  'roman à clef': 'kulcsregény',
  'autobiographical novel': 'önéletrajzi regény',
  'semi-autobiographical novel': 'önéletrajzi ihletésű regény',
  novel: 'regény',
  novella: 'kisregény',
  'short story': 'novella',
  'short story collection': 'novellagyűjtemény',
  poem: 'vers',
  poetry: 'költészet',
  'poetry collection': 'verseskötet',
  essay: 'esszé',
  'essay collection': 'esszégyűjtemény',
  play: 'színmű',
  drama: 'dráma',
  memoir: 'memoár',
  biography: 'életrajz',
  autobiography: 'önéletrajz',
  diary: 'napló',
  'literary fiction': 'szépirodalom',
  fiction: 'fikció',
  'stream of consciousness': 'tudatfolyam',
  'feminist literature': 'feminista irodalom',
  bildungsroman: 'fejlődésregény',
  'coming-of-age story': 'felnövéstörténet',
  'coming-of-age fiction': 'felnövéstörténet',
  'historical novel': 'történelmi regény',
  'historical fiction': 'történelmi regény',
  'war novel': 'háborús regény',
  'philosophical fiction': 'filozófiai regény',
  'philosophical novel': 'filozófiai regény',
  'adventure novel': 'kalandregény',
  'epistolary novel': 'levélregény',
  'gothic novel': 'gótikus regény',
  'gothic fiction': 'gótikus irodalom',
  'romance novel': 'romantikus regény',
  'crime novel': 'bűnügyi regény',
  'crime fiction': 'bűnügyi irodalom',
  'detective fiction': 'detektívtörténet',
  'mystery fiction': 'rejtélyes történet',
  'science fiction': 'sci-fi',
  'fantasy': 'fantasy',
  'dystopian novel': 'disztópia',
  'dystopian fiction': 'disztópia',
  'utopian and dystopian fiction': 'utópia és disztópia',
  satire: 'szatíra',
  'satirical novel': 'szatirikus regény',
  'magic realism': 'mágikus realizmus',
  'magical realism': 'mágikus realizmus',
  "children's literature": 'gyermekirodalom',
  "children's book": 'gyermekkönyv',
  'family saga': 'családregény',
  'campus novel': 'egyetemi regény',
  tragedy: 'tragédia',
  comedy: 'komédia',
  realism: 'realizmus',
  'literary realism': 'irodalmi realizmus',
  'social novel': 'társadalmi regény',
  'existentialist novel': 'egzisztencialista regény',
  'confessional poetry': 'konfesszionális költészet',
};
const missingTerms = new Set();
function huLabel(e, report = true) {
  const hu = e?.labels?.hu?.value;
  if (hu) return hu;
  const en = e?.labels?.en?.value;
  if (!en) return null;
  const t = HU_TERMS[en.toLowerCase()];
  if (t) return t;
  if (report) missingTerms.add(en);
  return en;
}

// Hungarian label per value (Wikidata hu label → HU_TERMS → English), deduplicated.
// Only genre-like properties report missing translations (places, countries are proper names).
async function itemLabels(e, p, max = 3) {
  const ids = [...new Set(itemIds(e, p))].slice(0, 8);
  if (!ids.length) return [];
  const ents = await getEntities(ids);
  const report = p === 'P136' || p === 'P106';
  return [...new Set(ents.map((x) => huLabel(x, report)).filter(Boolean))].slice(0, max);
}

async function findHuman(name) {
  const data = await wd({ action: 'wbsearchentities', search: name, language: 'hu', type: 'item', limit: '7' });
  const ids = (data.search ?? []).map((r) => r.id);
  const ents = await getEntities(ids);
  const human = ents.find((e) => itemIds(e, 'P31').includes('Q5'));
  if (!human) throw new Error(`Nem található szerző a Wikidatában: ${name}`);
  return human.id;
}

async function resolveWikiOverride(wiki) {
  if (/^Q\d+$/.test(wiki)) return wiki;
  const m = /^(hu|en):(.+)$/.exec(wiki);
  if (!m) throw new Error(`Érvénytelen wiki mező: ${wiki}`);
  const data = await wp(m[1], { action: 'query', prop: 'pageprops', ppprop: 'wikibase_item', titles: m[2], redirects: '1' });
  const qid = data.query?.pages?.[0]?.pageprops?.wikibase_item;
  if (!qid) throw new Error(`A cikknek nincs Wikidata elemre mutató hivatkozása: ${wiki}`);
  return qid;
}

async function findBook(book, authorQid) {
  const queries = [book.title, book.originalTitle].filter(Boolean);
  for (const q of queries) {
    const data = await wd({
      action: 'query',
      list: 'search',
      srsearch: `${q} haswbstatement:P50=${authorQid}`,
      srlimit: '5',
    });
    const hit = data.query?.search?.[0];
    if (hit) return hit.title;
  }
  throw new Error(`Nem található a könyv a Wikidatában: ${book.title}`);
}

// ---------- Wikipedia ----------
const PLOT_RE = /^(cselekmény|történet|a regény cselekménye|tartalom|tartalma|plot|plot summary|synopsis|summary)$/i;

// Biography stops at the first top-level section that is bibliography / references / etc.
const BIO_STOP_RE =
  /^(bibliográfia|művei|műveinek|főbb művei|magyarul|fordítás|források|jegyzetek|hivatkozások|irodalom|további információk|kapcsolódó szócikkek|lásd még|díjai|works|bibliography|selected works|notes|references|sources|further reading|external links|see also|citations|awards)/i;
const HU_EDITIONS_RE = /^magyarul/i;
const MAX_BIO_PARAS = 40;

// Article HTML (action=parse) → sections of blocks. Level 1 = <h2>, 2 = <h3>, ...
// A block is a paragraph string, { type: 'quote', text, source } or { type: 'list', items }.
// HTML is used instead of TextExtracts because extracts drop quote templates and tables.
const SKIP_SEL = [
  'style', 'script', 'sup.reference', 'sup.noprint', '.mw-editsection', '.mw-cite-backlink',
  '.noprint', '.navbox', '.infobox', '.metadata', '.ambox', '.hatnote', '.dablink', '.mw-empty-elt',
  'figure', '.thumb', '.reflist', '.references', '.mbox-small', '.sistersitebox', 'table.wikitable',
].join(',');

const cleanText = (el) =>
  el.textContent
    .replace(/\[\d+\]|\[[a-z]\]|\[forrás\?\]|\[citation needed\]/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?”])/g, '$1')
    .replace(/([„(])\s+/g, '$1')
    .trim();

function listItems(listEl) {
  const items = [];
  for (const li of listEl.childNodes.filter((n) => n.tagName === 'LI')) {
    const nested = li.querySelectorAll(':scope > ul, :scope > ol');
    nested.forEach((n) => n.remove());
    const t = cleanText(li);
    if (t) items.push(t);
    for (const n of nested) items.push(...listItems(n).map((x) => `– ${x}`));
  }
  return items;
}

function quoteBlock(el) {
  const sourceEl = el.querySelector('.idezet-2-forras, cite, .templatequotecite, .cquotecite');
  const source = sourceEl ? cleanText(sourceEl).replace(/^[—–-]\s*/, '') : null;
  sourceEl?.remove();
  const text = cleanText(el.querySelector('blockquote') ?? el);
  return text ? { type: 'quote', text, source: source || null } : null;
}

function parseArticleHtml(html) {
  const root = parse(html);
  root.querySelectorAll(SKIP_SEL).forEach((n) => n.remove());
  const container = root.querySelector('.mw-parser-output') ?? root;
  const links = collectLinks(container);
  const sections = [];
  let current = { level: 0, heading: null, paras: [] };
  const push = (b) => b && current.paras.push(b);
  for (const el of container.childNodes) {
    if (!el.tagName) continue;
    const tag = el.tagName;
    const heading = el.classList?.contains('mw-heading') ? el.querySelector('h2,h3,h4,h5,h6') : /^H[2-6]$/.test(tag) ? el : null;
    if (heading) {
      sections.push(current);
      current = { level: Number(heading.tagName[1]) - 1, heading: cleanText(heading), paras: [] };
    } else if (tag === 'P') {
      const t = cleanText(el);
      if (t) push(t);
    } else if (tag === 'UL' || tag === 'OL') {
      const items = listItems(el);
      if (items.length) push({ type: 'list', items });
    } else if (tag === 'DL') {
      const t = cleanText(el);
      if (t) push(t);
    } else if (tag === 'BLOCKQUOTE' || el.querySelector?.('blockquote') || /cquote|quotebox|idezet/.test(el.classNames ?? '')) {
      push(quoteBlock(el));
    }
  }
  sections.push(current);
  return { intro: sections[0].paras, sections: sections.slice(1), links };
}

// Editor-placed article links: [{ text, title }]. Skips red links, other namespaces
// (File:, Category:...), anchors and pure dates/years ("1940", "március 28.").
const DATE_RE = /^(\d{1,4}(\.|-ban|-ben|-as|-es|-os|-ös)?|\d{1,4}-?\w{0,4}|(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s+\d{1,2}\.?|(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}|\d{1,2}\.?\s+(January|February|March|April|May|June|July|August|September|October|November|December)|\d{4}s?|\d{1,2}(st|nd|rd|th) century)$/i;
function collectLinks(container) {
  const out = [];
  for (const a of container.querySelectorAll('a[href^="/wiki/"]')) {
    if (a.classList.contains('new') || a.classList.contains('mw-selflink')) continue;
    const href = a.getAttribute('href');
    let title = decodeURIComponent(href.slice(6).split('#')[0]).replace(/_/g, ' ');
    if (!title || title.includes(':')) continue;
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 3 || DATE_RE.test(text) || DATE_RE.test(title)) continue;
    // Keep the important ones: names, places, works, events. Drop decades/centuries ("1910-es évek",
    // "20. század") and single lowercase common words ("költő", "méhek", "depressziós").
    if (/^\d/.test(text) || /^\p{Ll}[\p{L}-]*$/u.test(text)) continue;
    out.push({ text, title });
  }
  return out;
}

// Warn when a paragraph announces something (ends with ':') but nothing follows it.
function checkDanglingColons(label, blocks) {
  blocks.forEach((b, i) => {
    if (typeof b === 'string' && b.endsWith(':') && (i === blocks.length - 1 || typeof blocks[i + 1] === 'string')) {
      console.warn(`  ! ${label}: kettősponttal végződő bekezdés után hiányzik a tartalom: "…${b.slice(-60)}"`);
    }
  });
}

// Top-level section matching `re`, plus its subsections.
function sectionGroup(sections, re) {
  const i = sections.findIndex((s) => s.level === 1 && re.test(s.heading));
  if (i < 0) return null;
  const out = [sections[i]];
  for (const s of sections.slice(i + 1)) {
    if (s.level <= 1) break;
    out.push(s);
  }
  return out;
}

// Plot section including its subsections; subheadings become { type: 'heading' } blocks.
function plotOf(sections) {
  const i = sections.findIndex((x) => x.level <= 2 && PLOT_RE.test(x.heading));
  if (i < 0) return null;
  const blocks = [...sections[i].paras];
  for (const sub of sections.slice(i + 1)) {
    if (sub.level <= sections[i].level) break;
    blocks.push({ type: 'heading', text: sub.heading }, ...sub.paras);
  }
  return blocks.some((b) => b.type !== 'heading') ? blocks : null;
}
const blockSize = (b) => (typeof b === 'string' ? 1 : b.type === 'list' ? Math.ceil(b.items.length / 3) : 1);

function biographyOf(sections) {
  const out = [];
  let count = 0;
  for (const s of sections) {
    if (s.level === 1 && BIO_STOP_RE.test(s.heading)) break;
    if (count >= MAX_BIO_PARAS) break;
    const paras = [];
    for (const b of s.paras) {
      if (count >= MAX_BIO_PARAS) break;
      paras.push(b);
      count += blockSize(b);
    }
    out.push({ level: s.level, heading: s.heading, paras });
  }
  // Drop trailing headings with no content of their own or below them.
  while (out.length && !out.at(-1).paras.length) out.pop();
  return out;
}

function huEditionsOf(sections) {
  const group = sectionGroup(sections, HU_EDITIONS_RE);
  if (!group) return null;
  const flat = (blocks) => blocks.flatMap((b) => (typeof b === 'string' ? [b] : b.type === 'list' ? b.items : [b.text]));
  const lines = group.flatMap((s, i) => (i === 0 ? flat(s.paras) : [`${s.heading}:`, ...flat(s.paras)]));
  // Parenthetical continuation lines ("(Mrs. Dalloway címen is)") belong to the previous entry.
  const items = [];
  for (const l of lines) {
    if (/^\(.*\)$/.test(l) && items.length) items[items.length - 1] += ` ${l}`;
    else items.push(l);
  }
  return items.length ? items : null;
}

async function getArticle(entity, { kind }) {
  for (const lang of LANGS) {
    const title = entity.sitelinks?.[`${lang}wiki`]?.title;
    if (!title) continue;
    const data = await wp(lang, {
      action: 'query',
      prop: 'pageimages|info',
      piprop: 'name',
      inprop: 'url',
      titles: title,
      redirects: '1',
    });
    const page = data.query?.pages?.[0];
    if (!page || page.missing) continue;
    const parsed = await wp(lang, {
      action: 'parse',
      page: page.title,
      prop: 'text',
      disableeditsection: '1',
      disablelimitreport: '1',
      disabletoc: '1',
    });
    if (!parsed.parse?.text) continue;
    const { intro, sections, links } = parseArticleHtml(parsed.parse.text);
    for (const sec of [{ heading: 'bevezető', paras: intro }, ...sections]) checkDanglingColons(`${page.title} / ${sec.heading}`, sec.paras);
    return {
      lang,
      title: page.title,
      url: page.fullurl,
      intro,
      plot: kind === 'book' ? plotOf(sections) : null,
      biography: kind === 'author' ? biographyOf(sections) : null,
      huEditions: kind === 'author' ? huEditionsOf(sections) : null,
      pageImage: page.pageimage ? { lang, file: page.pageimage } : null,
      links: await resolveLinks(lang, links, page.title),
    };
  }
  return null;
}

// Link targets → [{ match: [anchor texts], url }]. For non-Hungarian articles the Hungarian
// Wikipedia page is preferred when it exists (its title is also matched in translated text).
async function resolveLinks(lang, links, selfTitle) {
  const byTitle = new Map();
  for (const l of links) {
    if (l.title === selfTitle) continue;
    const e = byTitle.get(l.title) ?? { title: l.title, texts: new Set() };
    e.texts.add(l.text);
    byTitle.set(l.title, e);
  }
  const wikiUrl = (lg, t) => `https://${lg}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_')).replace(/%2F/g, '/')}`;
  const huTitles = new Map();
  if (lang !== 'hu') {
    const titles = [...byTitle.keys()];
    for (let i = 0; i < titles.length; i += 50) {
      try {
        const data = await wp(lang, {
          action: 'query', prop: 'langlinks', lllang: 'hu', lllimit: 'max', redirects: '1',
          titles: titles.slice(i, i + 50).join('|'),
        });
        const redirect = new Map((data.query?.redirects ?? []).map((r) => [r.to, r.from]));
        const normalized = new Map((data.query?.normalized ?? []).map((r) => [r.to, r.from]));
        for (const p of data.query?.pages ?? []) {
          const hu = p.langlinks?.[0]?.title;
          if (!hu) continue;
          let orig = p.title;
          orig = redirect.get(orig) ?? orig;
          orig = normalized.get(orig) ?? orig;
          huTitles.set(orig, hu);
        }
      } catch (err) {
        console.warn(`  ! magyar megfelelők lekérése sikertelen: ${err.message}`);
      }
    }
  }
  return [...byTitle.values()].map(({ title, texts }) => {
    const hu = huTitles.get(title);
    const match = [...texts];
    if (hu) match.push(hu.replace(/\s*\(.*\)$/, ''));
    return { match: [...new Set(match)].filter((m) => m.length >= 3), url: hu ? wikiUrl('hu', hu) : wikiUrl(lang, title) };
  });
}

async function imageInfo(lang, file) {
  // Query via the wiki itself so both local and Commons files resolve.
  const api = lang === 'commons' ? 'https://commons.wikimedia.org/w/api.php' : `https://${lang}.wikipedia.org/w/api.php`;
  const data = await getJson(api, {
    format: 'json',
    formatversion: '2',
    action: 'query',
    titles: `File:${file}`,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '800',
  });
  const ii = data.query?.pages?.[0]?.imageinfo?.[0];
  if (!ii) return null;
  const md = ii.extmetadata ?? {};
  return {
    url: ii.thumburl ?? ii.url,
    credit: {
      artist: dedupeRepeat(stripHtml(md.Artist?.value)) || null,
      license: stripHtml(md.LicenseShortName?.value) || null,
      licenseUrl: md.LicenseUrl?.value ?? null,
      source: ii.descriptionurl,
      sourceName: 'Wikimedia',
    },
  };
}

// ---------- Author's works (Wikidata SPARQL) ----------
// Literary works by the author that have at least one Wikipedia/Wikisource page (keeps the list notable).
async function authorWorks(authorQid) {
  const query = `
SELECT ?w (SAMPLE(?huL) AS ?hu) (SAMPLE(?enL) AS ?en) (SAMPLE(?origT) AS ?orig) (MIN(?date) AS ?d)
       (SAMPLE(?typeHu) AS ?type) (SAMPLE(?typeEn) AS ?typeEnL) (SAMPLE(?huWiki) AS ?huUrl) (SAMPLE(?enWiki) AS ?enUrl) (MAX(?links) AS ?n)
WHERE {
  ?w wdt:P50 wd:${authorQid};
     wdt:P31/wdt:P279* wd:Q7725634;
     wikibase:sitelinks ?links.
  FILTER(?links > 0)
  OPTIONAL { ?w wdt:P577 ?date }
  OPTIONAL { ?w rdfs:label ?huL FILTER(LANG(?huL) = "hu") }
  OPTIONAL { ?w rdfs:label ?enL FILTER(LANG(?enL) = "en") }
  OPTIONAL { ?w wdt:P1476 ?origT }
  FILTER NOT EXISTS { ?w wdt:P31 wd:Q3331189 }
  OPTIONAL {
    ?w wdt:P7937 ?form.
    OPTIONAL { ?form rdfs:label ?typeHu FILTER(LANG(?typeHu) = "hu") }
    OPTIONAL { ?form rdfs:label ?typeEn FILTER(LANG(?typeEn) = "en") }
  }
  OPTIONAL { ?huWiki schema:about ?w; schema:isPartOf <https://hu.wikipedia.org/> }
  OPTIONAL { ?enWiki schema:about ?w; schema:isPartOf <https://en.wikipedia.org/> }
}
GROUP BY ?w`;
  try {
    const data = await getJson('https://query.wikidata.org/sparql', { query, format: 'json' });
    const works = data.results.bindings
      .map((b) => {
        const original = b.orig?.value ?? b.en?.value ?? null;
        const hu = b.hu?.value ?? null;
        return {
          wikidataId: b.w.value.split('/').pop(),
          title: hu ?? original,
          originalTitle: hu && original && original !== hu ? original : null,
          year: b.d?.value ? Number(b.d.value.slice(0, 4)) || null : null,
          type: b.type?.value ?? (b.typeEnL ? huLabel({ labels: { en: { value: b.typeEnL.value } } }) : null),
          url: b.huUrl?.value ?? b.enUrl?.value ?? null,
          urlLang: b.huUrl ? 'hu' : b.enUrl ? 'en' : null,
        };
      })
      .filter((w) => w.title && !/^Q\d+$/.test(w.title));
    works.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title, 'hu'));
    return works;
  } catch (err) {
    console.warn(`  ! művek lekérése sikertelen (${authorQid}): ${err.message}`);
    return [];
  }
}

// ---------- Open Library ----------
async function openLibraryCover(book) {
  const titles = [book.originalTitle, book.title].filter(Boolean);
  for (const title of titles) {
    const data = await getJson('https://openlibrary.org/search.json', {
      title,
      author: book.author,
      limit: '10',
      fields: 'key,title,cover_i',
    });
    const doc = (data.docs ?? []).find((d) => d.cover_i);
    if (doc) {
      return {
        url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg?default=false`,
        credit: {
          artist: null,
          license: null,
          licenseUrl: null,
          source: `https://openlibrary.org${doc.key}`,
          sourceName: 'Open Library',
        },
      };
    }
  }
  return null;
}

// ---------- images ----------
async function saveImage(input, relPath, width) {
  const buf = typeof input === 'string' && /^https?:/.test(input) ? await getBuffer(input) : await fs.readFile(input);
  const out = path.join(IMG_DIR, relPath);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const info = await sharp(buf).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out);
  return { src: `images/${relPath.replace(/\\/g, '/')}`, width: info.width, height: info.height };
}

async function bookCover(book, slug, article, entity) {
  if (book.cover) {
    const img = await saveImage(path.join(ROOT, book.cover), `books/${slug}.webp`, 600);
    return { ...img, credit: null };
  }
  const candidates = [];
  if (article?.pageImage) candidates.push(() => imageInfo(article.pageImage.lang, article.pageImage.file));
  const p18 = claimValues(entity, 'P18')[0];
  if (p18) candidates.push(() => imageInfo('commons', p18));
  candidates.push(() => openLibraryCover(book));
  for (const get of candidates) {
    try {
      const info = await get();
      if (!info) continue;
      const img = await saveImage(info.url, `books/${slug}.webp`, 600);
      return { ...img, credit: info.credit };
    } catch (err) {
      console.warn(`  ! borító hiba (${slug}): ${err.message}`);
    }
  }
  return null;
}

async function authorPortrait(entity, article) {
  const candidates = [];
  const p18 = claimValues(entity, 'P18')[0];
  if (p18) candidates.push(() => imageInfo('commons', p18));
  if (article?.pageImage) candidates.push(() => imageInfo(article.pageImage.lang, article.pageImage.file));
  for (const get of candidates) {
    try {
      const info = await get();
      if (!info) continue;
      const img = await saveImage(info.url, `authors/${entity.id}.webp`, 480);
      return { ...img, credit: info.credit };
    } catch (err) {
      console.warn(`  ! portré hiba (${entity.id}): ${err.message}`);
    }
  }
  return null;
}

// ---------- main per-book ----------
async function fetchBook(book) {
  const slug = slugify(book.title);
  const authorQid = await findHuman(book.author);
  const bookQid = book.wiki ? await resolveWikiOverride(book.wiki) : await findBook(book, authorQid);
  const [bookEnt, authorEnt] = await getEntities([bookQid, authorQid]);

  // Keep titles consistent in machine translation: original title → Hungarian title.
  const origTitle = claimValues(bookEnt, 'P1476')[0]?.text ?? book.originalTitle;
  const glossary = [...(origTitle && origTitle !== book.title ? [[origTitle, book.title]] : []), ...GLOBAL_GLOSSARY];
  const bookArticle = linkifyArticle(await translateArticle(await getArticle(bookEnt, { kind: 'book' }), glossary));
  const authorArticle = linkifyArticle(await translateArticle(await getArticle(authorEnt, { kind: 'author' }), glossary));

  const originalTitle = claimValues(bookEnt, 'P1476')[0]?.text ?? book.originalTitle ?? null;
  const published = formatWdTime(claimValues(bookEnt, 'P577').sort((a, b) => a.time.localeCompare(b.time))[0]);

  const birth = formatWdTime(claimValues(authorEnt, 'P569')[0]);
  const death = formatWdTime(claimValues(authorEnt, 'P570')[0]);

  return {
    slug,
    title: book.title,
    authorName: book.author,
    fetchedAt: new Date().toISOString(),
    book: {
      wikidataId: bookQid,
      article: bookArticle && { lang: bookArticle.lang, title: bookArticle.title, url: bookArticle.url, translated: !!bookArticle.translated },
      intro: bookArticle?.intro ?? [],
      plot: bookArticle?.plot ?? null,
      facts: {
        originalTitle,
        published,
        language: (await itemLabels(bookEnt, 'P407', 1))[0] ?? null,
        genres: await itemLabels(bookEnt, 'P136', 3),
        country: (await itemLabels(bookEnt, 'P495', 1))[0] ?? null,
      },
      cover: await bookCover(book, slug, bookArticle, bookEnt),
    },
    author: {
      wikidataId: authorQid,
      name: label(authorEnt) ?? book.author,
      article: authorArticle && { lang: authorArticle.lang, title: authorArticle.title, url: authorArticle.url, translated: !!authorArticle.translated },
      intro: authorArticle?.intro ?? [],
      biography: authorArticle?.biography ?? [],
      huEditions: authorArticle?.huEditions ?? null,
      works: await authorWorks(authorQid),
      facts: {
        birth,
        birthPlace: (await itemLabels(authorEnt, 'P19', 1))[0] ?? null,
        death,
        deathPlace: (await itemLabels(authorEnt, 'P20', 1))[0] ?? null,
        nationality: await itemLabels(authorEnt, 'P27', 1),
        occupations: await itemLabels(authorEnt, 'P106', 4),
      },
      portrait: await authorPortrait(authorEnt, authorArticle),
    },
  };
}

// ---------- Machine translation (non-Hungarian articles → Hungarian) ----------
// Free Google Translate endpoint; results are cached in the repo keyed by source text hash,
// so only new/changed paragraphs are sent and CI works from the cache.
const TRANSLATIONS_JSON = path.join(ROOT, 'src/data/generated/translations.json');
let translationCache = {};
let translationFailures = 0;
const hashText = (lang, t) => createHash('sha1').update(`${lang}\n${t}`).digest('hex').slice(0, 16);

async function translate(text, from, glossary = []) {
  let src = text;
  for (const [orig, hu] of glossary) src = src.split(orig).join(hu);
  const key = hashText(from, src);
  if (translationCache[key]) return translationCache[key];
  if (translationFailures >= 3) return null; // endpoint looks down/blocked: stop trying this run
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=hu&dt=t`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: src }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = (data[0] ?? []).map((seg) => seg[0] ?? '').join('').trim();
    if (!out) throw new Error('üres válasz');
    translationCache[key] = out.replace(/"([^"]+)"/g, '„$1”');
    await new Promise((r) => setTimeout(r, 250));
    return translationCache[key];
  } catch (err) {
    translationFailures++;
    console.warn(`  ! fordítási hiba: ${err.message}`);
    return null;
  }
}

// Terms Google translates literally; replaced with the Hungarian term before translation.
const GLOBAL_GLOSSARY = [
  ['roman à clef', 'kulcsregény'],
  ['roman a clef', 'kulcsregény'],
  ['Bildungsroman', 'fejlődésregény'],
  ['bildungsroman', 'fejlődésregény'],
];

// Translates every text in the blocks; returns null if anything failed (caller keeps the original).
async function translateBlocks(blocks, from, glossary) {
  if (!blocks) return blocks;
  const out = [];
  for (const b of blocks) {
    if (typeof b === 'string') out.push(await translate(b, from, glossary));
    else if (b.type === 'list') {
      const items = [];
      for (const i of b.items) items.push(await translate(i, from, glossary));
      out.push(items.includes(null) ? null : { ...b, items });
    } else {
      const text = await translate(b.text, from, glossary);
      out.push(text ? { ...b, text } : null);
    }
  }
  return out.includes(null) ? null : out;
}

// Translates a non-Hungarian article in place. Marks article.translated = true only if all parts succeeded.
async function translateArticle(article, glossary) {
  if (!article || article.lang === 'hu') return article;
  const from = article.lang;
  const intro = await translateBlocks(article.intro, from, glossary);
  const plot = await translateBlocks(article.plot, from, glossary);
  let biography = article.biography;
  if (biography) {
    const tr = [];
    for (const s of biography) {
      const heading = await translate(s.heading, from, glossary);
      const paras = await translateBlocks(s.paras, from, glossary);
      tr.push(heading && paras ? { ...s, heading, paras } : null);
    }
    biography = tr.includes(null) ? null : tr;
  }
  const ok = intro && (article.plot ? plot : true) && (article.biography ? biography : true);
  if (!ok) {
    console.warn(`  ! ${article.title}: a fordítás nem sikerült, az eredeti (${from}) szöveg marad`);
    return { ...article, translated: false };
  }
  return { ...article, intro, plot, biography, translated: true };
}

// ---------- Linkify: plain text → rich text with Wikipedia links ----------
// A paragraph becomes { type: 'rich', parts: [string | { text, href }] }; list items become part arrays.
// Each target is linked at its first occurrence per section (like Wikipedia itself).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function makeLinker(links) {
  // Longer anchors first so "Ted Hughes" wins over "Hughes".
  const entries = links.flatMap((l) => l.match.map((m) => ({ m, url: l.url }))).sort((a, b) => b.m.length - a.m.length);
  if (!entries.length) return null;
  // Left word boundary; on the right Hungarian suffixes may follow ("Bostonban" → link "Bostonban").
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${entries.map((e) => escRe(e.m)).join('|')})(\\p{Ll}{0,6})(?![\\p{L}\\p{N}])`, 'gu');
  const urlOf = new Map(entries.map((e) => [e.m, e.url]));
  return (text, used) => {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      const url = urlOf.get(m[1]);
      if (used.has(url)) continue;
      used.add(url);
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push({ text: m[0], href: url });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };
}

function linkifyBlocks(blocks, link) {
  if (!blocks) return blocks;
  const used = new Set();
  return blocks.map((b) => {
    if (typeof b === 'string') return { type: 'rich', parts: link(b, used) };
    if (b.type === 'list') return { ...b, items: b.items.map((i) => link(i, used)) };
    if (b.type === 'heading') used.clear(); // plot subsections link afresh
    return b;
  });
}

function linkifyArticle(article) {
  if (!article) return article;
  const link = makeLinker(article.links ?? []);
  if (!link) return article;
  return {
    ...article,
    intro: linkifyBlocks(article.intro, link),
    plot: linkifyBlocks(article.plot, link),
    biography: article.biography?.map((s) => ({ ...s, paras: linkifyBlocks(s.paras, link) })) ?? null,
  };
}

async function main() {
  try {
    translationCache = JSON.parse(await fs.readFile(TRANSLATIONS_JSON, 'utf8'));
  } catch {}
  const books = YAML.parse(await fs.readFile(BOOKS_YAML, 'utf8')) ?? [];
  let previous = [];
  try {
    previous = JSON.parse(await fs.readFile(OUT_JSON, 'utf8'));
  } catch {}
  const prevBySlug = new Map(previous.map((b) => [b.slug, b]));

  const out = [];
  let failures = 0;
  for (const book of books) {
    const slug = slugify(book.title);
    console.log(`→ ${book.author}: ${book.title}`);
    try {
      const data = await fetchBook(book);
      console.log(
        `  ✓ ${data.book.article ? `${data.book.article.lang}: ${data.book.article.title}` : 'nincs cikk'}` +
          `, borító: ${data.book.cover ? (data.book.cover.credit?.sourceName ?? 'saját') : 'nincs'}` +
          `, portré: ${data.author.portrait ? 'van' : 'nincs'}`,
      );
      out.push(data);
    } catch (err) {
      failures++;
      console.warn(`  ! HIBA: ${err.message}`);
      const prev = prevBySlug.get(slug);
      if (prev) {
        console.warn('    → az előző (gyorsítótárazott) adatot használom');
        out.push(prev);
      } else {
        out.push({ slug, title: book.title, authorName: book.author, fetchedAt: null, book: null, author: null });
      }
    }
  }
  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true });
  await fs.writeFile(OUT_JSON, JSON.stringify(out, null, 2) + '\n');
  await fs.writeFile(TRANSLATIONS_JSON, JSON.stringify(translationCache, null, 2) + '\n');
  if (missingTerms.size) {
    console.warn(`\nMagyar fordítás nélküli címkék (add hozzá a HU_TERMS táblához): ${[...missingTerms].join(', ')}`);
  }
  console.log(`\nKész: ${out.length} könyv${failures ? `, ${failures} hibával (figyelmeztetés)` : ''}.`);
}

main().catch((err) => {
  // Never fail the build because of the network; the committed cache is still usable.
  console.warn(`Váratlan hiba, a meglévő gyorsítótár marad: ${err.stack ?? err}`);
});
