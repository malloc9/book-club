// Build-time data fetcher: books.yaml -> Wikidata + Wikipedia (+ Open Library) -> JSON cache + WebP images.
// Failures never break the build: a book that can't be fetched keeps its previous cached entry.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import sharp from 'sharp';

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
// Prefer Hungarian labels; fall back to English only if none of the values has a Hungarian label.
async function itemLabels(e, p, max = 3) {
  const ids = [...new Set(itemIds(e, p))].slice(0, 8);
  if (!ids.length) return [];
  const ents = await getEntities(ids);
  const hu = ents.map((x) => x?.labels?.hu?.value).filter(Boolean);
  const labels = hu.length ? hu : ents.map(label).filter(Boolean);
  return [...new Set(labels)].slice(0, max);
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

// explaintext + exsectionformat=wiki → "== Heading ==" markers. Level 1 = "==", 2 = "===", ...
function parseExtract(text) {
  const sections = [];
  let current = { level: 0, heading: null, paras: [] };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(={2,})\s*(.+?)\s*\1$/.exec(line);
    if (h) {
      sections.push(current);
      current = { level: h[1].length - 1, heading: h[2], paras: [] };
    } else {
      current.paras.push(line);
    }
  }
  sections.push(current);
  return { intro: sections[0].paras, sections: sections.slice(1) };
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

function plotOf(sections) {
  const s = sections.find((x) => x.level <= 2 && PLOT_RE.test(x.heading));
  return s?.paras.length ? s.paras : null;
}

function biographyOf(sections) {
  const out = [];
  let count = 0;
  for (const s of sections) {
    if (s.level === 1 && BIO_STOP_RE.test(s.heading)) break;
    if (count >= MAX_BIO_PARAS) break;
    const paras = s.paras.slice(0, MAX_BIO_PARAS - count);
    count += paras.length;
    out.push({ level: s.level, heading: s.heading, paras });
  }
  // Drop trailing headings with no content of their own or below them.
  while (out.length && !out.at(-1).paras.length) out.pop();
  return out;
}

function huEditionsOf(sections) {
  const group = sectionGroup(sections, HU_EDITIONS_RE);
  if (!group) return null;
  const lines = group.flatMap((s, i) => (i === 0 ? s.paras : [`${s.heading}:`, ...s.paras]));
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
      prop: 'extracts|pageimages|info',
      explaintext: '1',
      exsectionformat: 'wiki',
      piprop: 'name',
      inprop: 'url',
      titles: title,
      redirects: '1',
    });
    const page = data.query?.pages?.[0];
    if (!page?.extract) continue;
    const { intro, sections } = parseExtract(page.extract);
    return {
      lang,
      title: page.title,
      url: page.fullurl,
      intro,
      plot: kind === 'book' ? plotOf(sections) : null,
      biography: kind === 'author' ? biographyOf(sections) : null,
      huEditions: kind === 'author' ? huEditionsOf(sections) : null,
      pageImage: page.pageimage ? { lang, file: page.pageimage } : null,
    };
  }
  return null;
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
       (SAMPLE(?typeHu) AS ?type) (SAMPLE(?huWiki) AS ?huUrl) (SAMPLE(?enWiki) AS ?enUrl) (MAX(?links) AS ?n)
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
  OPTIONAL { ?w wdt:P7937 ?form. ?form rdfs:label ?typeHu FILTER(LANG(?typeHu) = "hu") }
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
          type: b.type?.value ?? null,
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

  const bookArticle = await getArticle(bookEnt, { kind: 'book' });
  const authorArticle = await getArticle(authorEnt, { kind: 'author' });

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
      article: bookArticle && { lang: bookArticle.lang, title: bookArticle.title, url: bookArticle.url },
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
      article: authorArticle && { lang: authorArticle.lang, title: authorArticle.title, url: authorArticle.url },
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

async function main() {
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
  console.log(`\nKész: ${out.length} könyv${failures ? `, ${failures} hibával (figyelmeztetés)` : ''}.`);
}

main().catch((err) => {
  // Never fail the build because of the network; the committed cache is still usable.
  console.warn(`Váratlan hiba, a meglévő gyorsítótár marad: ${err.stack ?? err}`);
});
