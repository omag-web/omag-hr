// Pip's statute library: loads backend/data/library.json and searches it with BM25.
// Small enough (a few MB) to hold in memory, so no vector database is needed.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getConfig, bumpVersion } from './config.mjs';
import { kv, blobs } from './storage.mjs';
import { enabledSections } from './docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(here, '..', 'data', 'library.json');

const STOP = new Set(('a an and are as at be been by can could did do does for from had has have how i if in into is it its may me my no not of on or our shall should so such than that the their them then there these they this to under upon us was we were what when where which who whom why will with would you your section sections title chapter part').split(' '));

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9.]+/)
    .flatMap((t) => (/^\d+(\.\d+)+$/.test(t) ? [t] : t.split('.')))
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

// Light stemmer so "employees"/"employee", "appointment"/"appoint", "terminated"/"termination" match.
function stem(t) {
  if (/^\d/.test(t) || t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) t = t.slice(0, -3) + 'y';
  else if (/(ss|us|is)$/.test(t)) { /* keep: business, bonus, basis */ }
  else if (/(s|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s')) t = t.slice(0, -1);
  for (const suf of ['ing', 'ed', 'ment', 'ion']) {
    if (t.endsWith(suf) && t.length - suf.length >= 4) { t = t.slice(0, -suf.length); break; }
  }
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

export class Library {
  constructor(data) {
    this.builtAt = data.builtAt;
    this.sources = data.sources;
    this.sections = data.sections;
    this.byId = new Map(this.sections.map((s) => [s.id, s]));
    // "51-24A.5" → its newest published version ("51-24A.5v2").
    this.latest = new Map();
    for (const s of this.sections) {
      if (!s.baseId) continue;
      const cur = this.latest.get(s.baseId);
      if (!cur || s.version > this.byId.get(cur).version) this.latest.set(s.baseId, s.id);
    }
    this.#index();
  }

  static load(path = process.env.LIBRARY_PATH || DEFAULT_PATH) {
    if (!existsSync(path)) {
      throw new Error(`Statute library not found at ${path}. Run the "Refresh statute library" GitHub Action or node knowledge/scripts/build-library.mjs.`);
    }
    return new Library(JSON.parse(readFileSync(path, 'utf8')));
  }

  #index() {
    this.k1 = 1.4; this.b = 0.75;
    this.postings = new Map();
    this.len = new Float64Array(this.sections.length);
    let total = 0;
    this.sections.forEach((s, i) => {
      const tf = new Map();
      const add = (tokens, w) => tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + w));
      add(tokenize(s.heading), 3);
      add(tokenize(s.cite + ' ' + s.id), 2);
      add(tokenize(s.text), 1);
      let n = 0; for (const v of tf.values()) n += v;
      this.len[i] = n; total += n;
      for (const [t, f] of tf) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = []));
        p.push(i, f);
      }
    });
    this.avg = total / Math.max(1, this.sections.length);
  }

  /** Find sections. `jurisdiction`: 'OK' | 'US' | undefined (both). */
  search(query, { jurisdiction, limit = 8 } = {}) {
    const N = this.sections.length;
    const scores = new Map();
    const terms = [...new Set(tokenize(query))];
    for (const t of terms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let j = 0; j < p.length; j += 2) {
        const i = p[j], f = p[j + 1];
        const s = idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg));
        scores.set(i, (scores.get(i) || 0) + s);
      }
    }
    // Exact citations in the query go to the top.
    for (const id of this.citedIds(query)) {
      const i = this.sections.findIndex((s) => s.id === id);
      if (i >= 0) scores.set(i, (scores.get(i) || 0) + 1000);
    }
    return [...scores.entries()]
      .filter(([i]) => !jurisdiction || this.sections[i].jurisdiction === jurisdiction)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([i]) => this.sections[i]);
  }

  get(id) { return this.byId.get(this.normalizeId(id)) || null; }

  /** Accepts library ids or human citations ("11 O.S. § 12-106", "29 CFR 825.110"). */
  normalizeId(raw) {
    const s = String(raw).trim();
    if (this.byId.has(s)) return s;
    if (this.latest.has(s)) return this.latest.get(s);
    const found = this.citedIds(s);
    return found[0] || s;
  }

  /** Library ids mentioned in free text as citations. */
  citedIds(text) {
    const ids = [];
    const t = String(text);
    for (const m of t.matchAll(/\b(\d{1,2}[A-Z]?)\s*O\.?\s*S\.?\s*(?:§+\s*)?([0-9][0-9A-Za-z.\-]*[0-9A-Za-z])/g)) ids.push(`${m[1]}-${m[2]}`);
    for (const m of t.matchAll(/\b(\d{1,2})\s*C\.?\s*F\.?\s*R\.?\s*(?:§+\s*|Part\s+)?(\d+(?:\.\d+)?)/gi)) ids.push(`${m[1]}-CFR-${m[2]}`);
    for (const m of t.matchAll(/\b(\d{1,2}[A-Z]?-\d+[A-Z]?(?:-\d+)?(?:\.\d+)?)\b/g)) ids.push(m[1]);
    for (const m of t.matchAll(/§+\s*(\d{2,4}\.\d+[a-z]?)/g)) ids.push(`29-CFR-${m[1]}`, `49-CFR-${m[1]}`);
    return [...new Set(ids.map((id) => this.latest.get(id) || id))].filter((id) => this.byId.has(id));
  }
}

/* ---------- the live library: statutes + enabled OMAG documents ---------- */

const LIBRARY_KEY = 'library/library.json';
// The "Refresh statute library" GitHub Action uploads its build here (and the source list beside it).
const PUBLISHED_KEY = 'published/library.json';
const PUBLISHED_SOURCES_KEY = 'published/sources.json';
const DEFAULT_LIBRARY_URL = 'https://omag-web.github.io/omag-hr/backend/data/library.json';
let bundled = null;
let current = { key: null, lib: null };
let pending = null;

function bundledLibrary() {
  return (bundled ||= JSON.parse(readFileSync(process.env.LIBRARY_PATH || DEFAULT_PATH, 'utf8')));
}

async function statuteLibrary() {
  const buf = await blobs.get(LIBRARY_KEY).catch(() => null);
  if (buf) {
    const fromStore = JSON.parse(buf.toString('utf8'));
    // A redeploy can ship a newer library than the stored copy; use whichever is newer.
    if (String(fromStore.builtAt) >= String(bundledLibrary().builtAt)) return { ...fromStore, origin: 'refreshed' };
  }
  return { ...bundledLibrary(), origin: 'bundled' };
}

/** The library Pip searches. Rebuilt when the statutes or OMAG documents change. */
export async function getLibrary() {
  const { versions } = await getConfig();
  const key = `${versions.library}:${versions.docs}`;
  if (current.lib && current.key === key) return current.lib;
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    const base = await statuteLibrary();
    const docs = await enabledSections().catch((e) => { console.error('loading OMAG documents failed', e); return { titles: [], sections: [] }; });
    const lib = new Library({ ...base, sections: [...base.sections, ...docs.sections] });
    lib.origin = base.origin;
    lib.statuteCount = base.sections.length;
    lib.omagTitles = docs.titles;
    current = { key, lib };
    return lib;
  })().finally(() => { if (pending?.key === key) pending = null; });
  pending = { key, promise };
  return promise;
}

/** The newest library the GitHub Action published: the copy in the data bucket, or (older setup) the web address. */
async function publishedLibrary() {
  const buf = await blobs.get(PUBLISHED_KEY).catch(() => null);
  if (buf) return JSON.parse(buf.toString('utf8'));
  const url = process.env.LIBRARY_URL || DEFAULT_LIBRARY_URL;
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60000) }).catch((e) => {
    console.error('library download failed', e);
    throw new Error('Couldn’t reach the published library. Pip keeps using the current library; try again later.');
  });
  if (!r.ok) throw new Error(`Couldn’t download the published library (HTTP ${r.status}). Pip keeps using the current library.`);
  return r.json();
}

/**
 * Picks up the latest statute library published by the "Refresh statute library"
 * GitHub Action and makes it live if it's newer.
 * Runs daily on a schedule and from the admin panel.
 */
export async function refreshLibrary({ force = false } = {}) {
  const now = new Date().toISOString();
  let result;
  try {
    const data = await publishedLibrary();
    if (!Array.isArray(data.sections) || data.sections.length < 500 || !data.sections.every((s) => s.id && s.text && s.cite)) {
      throw new Error('The downloaded library looks incomplete, so it was not used.');
    }
    const live = await statuteLibrary();
    if (!force && String(data.builtAt) <= String(live.builtAt)) {
      result = { changed: false, builtAt: live.builtAt, count: live.sections.length, message: 'Already up to date.' };
    } else {
      await blobs.put(LIBRARY_KEY, JSON.stringify(data), 'application/json');
      await bumpVersion('library');
      result = { changed: true, builtAt: data.builtAt, count: data.sections.length, message: `Updated to the library built ${String(data.builtAt).slice(0, 10)}.` };
    }
  } catch (e) {
    result = { changed: false, error: true, message: e instanceof SyntaxError ? 'The published library file couldn’t be read, so it was not used.' : e.message };
  }
  await kv.put({ pk: 'CONFIG', sk: 'library', lastCheckAt: now, ...result });
  return result;
}

export async function libraryStatus() {
  const [lib, last] = await Promise.all([getLibrary(), kv.get('CONFIG', 'library')]);
  return {
    builtAt: lib.builtAt,
    origin: lib.origin,
    statuteSections: lib.statuteCount,
    omagSections: lib.sections.length - lib.statuteCount,
    sources: lib.sources,
    lastCheck: last ? { at: last.lastCheckAt, message: last.message, error: !!last.error } : null
  };
}

/* ---------- where the statute library comes from ---------- */
const SOURCES_URL = () => process.env.SOURCES_URL || 'https://omag-web.github.io/omag-hr/knowledge/sources.json';
export const SOURCES_EDIT_URL = 'https://github.com/omag-web/omag-hr/edit/main/knowledge/sources.json';
export const LIBRARY_WORKFLOW_URL = 'https://github.com/omag-web/omag-hr/actions/workflows/library.yml';

/** knowledge/sources.json: the repo copy when running locally, otherwise the copy the library workflow published. */
async function loadSourcesFile() {
  const local = fileURLToPath(new URL('../../knowledge/sources.json', import.meta.url));
  try { return JSON.parse(readFileSync(local, 'utf8')); } catch { /* not in the Lambda package */ }
  const buf = await blobs.get(PUBLISHED_SOURCES_KEY).catch(() => null);
  if (buf) return JSON.parse(buf.toString('utf8'));
  const r = await fetch(SOURCES_URL(), { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error(`Couldn’t load the source list (HTTP ${r.status}).`), { status: 502 });
  return r.json();
}

const ecfrPage = (t, p) => `https://www.ecfr.gov/current/title-${t}/part-${p}`;

/** Every source the library is built from, with how many sections each contributes to the live library. */
export async function librarySources() {
  const [cfg, lib] = await Promise.all([loadSourcesFile(), getLibrary()]);
  const ok = (cfg.oklahoma || []).map((s) => ({
    kind: 'oklahoma',
    label: `Title ${s.title} O.S.`,
    name: s.name,
    url: s.url,
    why: s._why || '',
    include: (s.include || []).join('  '),
    sections: lib.sections.filter((x) => x.jurisdiction === 'OK' && x.url === s.url).length
  }));
  const fed = (cfg.federal || []).map((s) => ({
    kind: 'federal',
    label: `${s.title} C.F.R. Part ${s.part}`,
    name: s.name,
    url: ecfrPage(s.title, s.part),
    title: String(s.title), part: String(s.part),
    why: s._why || '',
    sections: lib.sections.filter((x) => x.id.startsWith(`${s.title}-CFR-${s.part}.`)).length
  }));
  return { sources: [...ok, ...fed], editUrl: SOURCES_EDIT_URL, workflowUrl: LIBRARY_WORKFLOW_URL, builtAt: lib.builtAt };
}

/** Checks that each source address still answers. Oklahoma PDFs directly; federal parts through the eCFR API. */
export async function checkSources() {
  const { fetchPublic } = await import('./web.mjs');
  const { sources } = await librarySources();
  let ecfrDates = null;
  const check = async (s) => {
    try {
      if (s.kind === 'oklahoma') {
        let r;
        try { r = await fetchPublic(s.url, { method: 'HEAD' }); } catch (e) {
          if (![403, 405, 501].includes(e.httpStatus)) throw e;
          r = await fetchPublic(s.url); // some servers refuse HEAD
        }
        const pdf = r.contentType.includes('pdf') || /\.pdf$/i.test(r.url);
        return { url: s.url, ok: pdf, message: pdf ? 'Working' : 'Answers, but isn’t a PDF any more' };
      }
      if (!ecfrDates) {
        const j = JSON.parse((await fetchPublic('https://www.ecfr.gov/api/versioner/v1/titles.json')).body.toString('utf8'));
        ecfrDates = Object.fromEntries(j.titles.map((t) => [String(t.number), t.up_to_date_as_of]));
      }
      const date = ecfrDates[s.title];
      if (!date) return { url: s.url, ok: false, message: `eCFR has no Title ${s.title}` };
      await fetchPublic(`https://www.ecfr.gov/api/versioner/v1/ancestry/${date}/title-${s.title}.json?part=${encodeURIComponent(s.part)}`);
      return { url: s.url, ok: true, message: `Working (current as of ${date})` };
    } catch (e) {
      return { url: s.url, ok: false, message: e.httpStatus === 404 ? 'Not found (404). The address may have moved.' : e.message };
    }
  };
  const results = [];
  for (const s of sources) results.push(await check(s)); // one at a time, to be polite to the Legislature's server
  return { results, checkedAt: new Date().toISOString() };
}
