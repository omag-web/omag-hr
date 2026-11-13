// Pip's statute library: loads backend/data/library.json and searches it with BM25.
// Small enough (a few MB) to hold in memory, so no vector database is needed.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

let cached;
export function getLibrary() {
  if (!cached) cached = Library.load();
  return cached;
}
