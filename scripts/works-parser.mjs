// Parses an author's bibliography ("Művei" / "Works" sections) from Wikipedia article HTML and
// merges it with the Wikidata works list. Wikipedia lists are far more complete for Hungarian
// authors; Wikidata adds identifiers, forms and works missing from the article.
import { parse } from 'node-html-parser';

const WORKS_HEAD_RE =
  /^(művei|főbb művei|művek|munkái|művei \(válogatás\)|bibliográfia|regényei|könyvei|works|bibliography|selected works|selected bibliography|novels|publications|werke|werke \(auswahl\)|œuvres)$/i;
// Subsections that are not the author's own books.
const WORKS_SKIP_RE =
  /(film|cd|hangoskönyv|idegen nyelv|fordít|interjú|róla|folyóirat|média|díj|magyarul|adaptation|translat|about|on |forgatókönyv|szerkesztett|levelezés)/i;

// Known work types (Hungarian) found in parentheses or subtitles: "(regény, 1979)", "Színek és évek. Regény".
const TYPES = {
  regény: 'regény', regénye: 'regény', kisregény: 'kisregény', kisregények: 'kisregény',
  elbeszélés: 'elbeszélés', elbeszélések: 'elbeszélések', novella: 'novella', novellák: 'novellák',
  halálnovellák: 'novellák', karcolatok: 'karcolatok', tárcák: 'tárcák', mese: 'mese', mesék: 'mesék',
  versek: 'versek', vers: 'vers', verseskötet: 'versek', költemények: 'versek',
  esszé: 'esszé', esszék: 'esszék', tanulmány: 'tanulmány', tanulmányok: 'tanulmányok',
  publicisztika: 'publicisztika', publicisztikák: 'publicisztika', orációk: 'orációk',
  színmű: 'színmű', dráma: 'dráma', drámák: 'drámák', színdarab: 'színmű', librettó: 'librettó',
  napló: 'napló', naplók: 'napló', emlékirat: 'emlékirat', memoár: 'memoár',
  beszélgetések: 'beszélgetések', interjúkötet: 'beszélgetések', önéletrajz: 'önéletrajz',
  ifjúsági: 'ifjúsági regény', gyermekkönyv: 'gyermekkönyv', meseregény: 'meseregény',
};
const typeOf = (word) => TYPES[word?.toLowerCase().replace(/[„”"'“]/g, '').trim()] ?? null;
function typeFromHeading(h) {
  const s = (h ?? '').toLowerCase();
  // Mixed headings ("Regények, elbeszélések") say nothing about a single item.
  if (/[,;]| és | and /.test(s)) return null;
  if (/regény|novel/.test(s)) return 'regény';
  if (/novell|elbeszél|short stor|stories/.test(s)) return 'novellák';
  if (/vers|költ|poe/.test(s)) return 'versek';
  if (/dráma|színm|play|drama/.test(s)) return 'dráma';
  if (/esszé|essay|tanulm/.test(s)) return 'esszék';
  if (/gyermek|children|ifjúsági/.test(s)) return 'gyermekkönyv';
  return null;
}

const YEAR_RE = /\b(1[5-9]\d\d|20\d\d)\b/;
const clean = (t) => t.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
// Key for matching: main title without subtitle ("Herscht 07769. Florian Herscht Bach-regénye" → "herscht 07769").
export const baseKey = (t) => normTitle((t ?? '').split(/\.\s+|\s+[–—-]\s+/)[0]);
export const normTitle = (t) =>
  (t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function ownNodes(li) {
  return li.childNodes.filter((n) => !(n.tagName === 'UL' || n.tagName === 'OL'));
}

function parseItem(li, ctx) {
  const nodes = ownNodes(li);
  const ownText = clean(nodes.map((n) => n.textContent).join(''));
  if (!ownText) return { yearOnly: null };
  // "1985" alone → year bullet for nested items (Krasznahorkai style)
  if (/^(1[5-9]\d\d|20\d\d)\.?$/.test(ownText)) return { yearOnly: Number(ownText.slice(0, 4)) };

  // Title element: the first meaningful node if it is <i>/<a>/<b> (ignoring a leading year),
  // otherwise the first <i>; otherwise text before the first delimiter.
  let titleEl = null;
  let leadingYear = null;
  for (const n of nodes) {
    if (!n.tagName) {
      const t = n.textContent.trim();
      if (!t) continue;
      const m = /^(1[5-9]\d\d|20\d\d)\b[\s.:–-]*$/.exec(t);
      if (m && leadingYear === null) {
        leadingYear = Number(m[1]);
        continue;
      }
      break;
    }
    if (['I', 'A', 'B', 'CITE', 'SPAN'].includes(n.tagName) && clean(n.textContent)) titleEl = n;
    break;
  }
  // A leading name followed by ":" or a dash is an author/co-author prefix, not the title.
  if (titleEl) {
    const after = nodes.slice(nodes.indexOf(titleEl) + 1).map((n) => n.textContent).join('');
    if (/^\s*([:–—-]|és)/.test(after) && /:/.test(after.split(/[(]/)[0])) {
      titleEl = nodes.slice(nodes.indexOf(titleEl) + 1).find((n) => (n.tagName === 'I' || n.tagName === 'A') && clean(n.textContent)) ?? null;
    }
  }
  // Plain-text co-author list before a colon ("Irene Dische, …: [[Title]]"): take the element after the colon.
  if (!titleEl) {
    const i = nodes.findIndex((n) => (n.tagName === 'I' || n.tagName === 'A') && clean(n.textContent));
    if (i > 0 && /:\s*$/.test(nodes.slice(0, i).map((n) => n.textContent).join(''))) titleEl = nodes[i];
  }
  if (!titleEl) titleEl = nodes.find((n) => n.tagName === 'I' && clean(n.textContent)) ?? null;

  let title = titleEl ? clean(titleEl.textContent) : clean(ownText.replace(/^(1[5-9]\d\d|20\d\d)\s*/, '')).split(/\s*[.;(,–]\s/)[0];
  title = title.replace(/^[„"']|[”"']$/g, '').replace(/[.,:;]$/, '');
  if (!title || title.length > 120) return {};

  // Subtitle type: "Színek és évek. Regény" → title "Színek és évek", type "regény"
  let type = null;
  const sub = /^(.*?)\.\s+([^.]+)$/.exec(title);
  if (sub && typeOf(sub[2].split(/[\s,]/)[0])) {
    type = typeOf(sub[2].split(/[\s,]/)[0]);
    title = sub[1];
  }
  // Parenthetical type: "(regény, 1979)" / "(elbeszélések, Magvető)"
  if (!type) {
    for (const m of ownText.matchAll(/\(([^()]+)\)/g)) {
      const t = typeOf(m[1].split(/[,;]/)[0]);
      if (t) {
        type = t;
        break;
      }
    }
  }
  type ??= ctx.type;

  // Original title: an <i> after the title whose text appears in parentheses, e.g. "Nagyonkék (The Bluest Eye)"
  let originalTitle = null;
  for (const n of nodes) {
    if (n === titleEl || n.tagName !== 'I') continue;
    const t = clean(n.textContent);
    if (t && !/\d/.test(t) && ownText.includes(`(${t})`) && normTitle(t) !== normTitle(title)) {
      originalTitle = t;
      break;
    }
  }

  const withoutIsbn = ownText.replace(/ISBN[\s:]*[\d\-X ]+/gi, '');
  // A parent year bullet ("* 1985" → nested items) beats later edition years in the text.
  const y = leadingYear ?? ctx.yearBullet ?? (YEAR_RE.exec(withoutIsbn) ? Number(YEAR_RE.exec(withoutIsbn)[1]) : null) ?? ctx.year;

  const a = titleEl?.tagName === 'A' ? titleEl : titleEl?.querySelector?.('a');
  const href = a && !a.classList.contains('new') ? a.getAttribute('href') : null;
  const url = href?.startsWith('/wiki/') && !href.slice(6).includes(':') ? `https://${ctx.lang}.wikipedia.org${href.split('#')[0]}` : null;

  return { work: { title, originalTitle, year: y ?? null, type, url, urlLang: url ? ctx.lang : null, wikidataId: null } };
}

function walkList(listEl, ctx, out) {
  for (const li of listEl.childNodes.filter((n) => n.tagName === 'LI')) {
    const { work, yearOnly } = parseItem(li, ctx);
    if (work) out.push(work);
    const nested = li.childNodes.filter((n) => n.tagName === 'UL' || n.tagName === 'OL');
    for (const n of nested) walkList(n, { ...ctx, yearBullet: yearOnly ?? ctx.yearBullet ?? null, year: work?.year ?? ctx.year }, out);
  }
}

export function worksFromHtml(html, lang, skipSel) {
  const root = parse(html);
  root.querySelectorAll(skipSel).forEach((n) => n.remove());
  const container = root.querySelector('.mw-parser-output') ?? root;
  const out = [];
  let inWorks = false;
  let skip = false;
  let headingType = null;
  for (const el of container.childNodes) {
    if (!el.tagName) continue;
    const h = el.classList?.contains('mw-heading') ? el.querySelector('h2,h3,h4,h5,h6') : /^H[2-6]$/.test(el.tagName) ? el : null;
    if (h) {
      const level = Number(h.tagName[1]) - 1;
      const text = clean(h.textContent);
      if (level === 1) {
        inWorks = WORKS_HEAD_RE.test(text);
        skip = false;
        headingType = typeFromHeading(text);
      } else if (inWorks) {
        skip = WORKS_SKIP_RE.test(text);
        headingType = typeFromHeading(text);
      }
      continue;
    }
    if (!inWorks || skip) continue;
    if (el.tagName === 'UL' || el.tagName === 'OL') walkList(el, { lang, type: headingType, year: null }, out);
  }
  // De-duplicate by main title; the first occurrence wins but borrows missing fields from later ones.
  const byKey = new Map();
  for (const w of out) {
    const k = baseKey(w.title);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, w);
    else {
      prev.year ??= w.year;
      prev.type ??= w.type;
      prev.url ??= w.url;
      prev.urlLang ??= w.urlLang;
      prev.originalTitle ??= w.originalTitle;
    }
  }
  return [...byKey.values()];
}

// Wikipedia list is the base (complete, Hungarian titles); Wikidata entries fill in missing
// fields when they match, and are appended when they don't.
export function mergeWorks(wikiWorks, wdWorks) {
  const out = wikiWorks.map((w) => ({ ...w }));
  const keysOf = (w) => [w.title, w.originalTitle].filter(Boolean).flatMap((t) => [normTitle(t), baseKey(t)]);
  for (const wd of wdWorks) {
    const keys = keysOf(wd);
    const match = out.find((w) => keysOf(w).some((k) => keys.includes(k)));
    if (match) {
      match.wikidataId ??= wd.wikidataId;
      // Wikidata's publication date (P577) is more reliable than years parsed from list text.
      if (wd.year) match.year = wd.year;
      match.type ??= wd.type;
      match.originalTitle ??= wd.originalTitle && normTitle(wd.originalTitle) !== normTitle(match.title) ? wd.originalTitle : null;
      if (!match.url && wd.url) {
        match.url = wd.url;
        match.urlLang = wd.urlLang;
      }
    } else {
      out.push({ ...wd });
    }
  }
  out.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title, 'hu'));
  return out;
}
