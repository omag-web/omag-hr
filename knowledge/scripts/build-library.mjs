#!/usr/bin/env node
// Builds Pip's statute library from official sources.
//
//   node knowledge/scripts/build-library.mjs
//
// Needs network access to oklegislature.gov and ecfr.gov, and `pdftotext`
// (poppler-utils) on the PATH. Writes backend/data/library.json, which the
// backend loads at startup. Run by .github/workflows/library.yml.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOklahomaText, parseEcfrXml, included } from './parse.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const OUT = join(root, 'backend', 'data', 'library.json');
const UA = { 'User-Agent': 'OMAG-Pip-library-builder/1.0 (+https://github.com/omag-web/omag-hr)' };

async function fetchBuf(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw new Error(`GET ${url} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function oklahoma(src) {
  const pdf = join(tmpdir(), `os${src.title}.pdf`);
  await writeFile(pdf, await fetchBuf(src.url));
  const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { maxBuffer: 1 << 28 });
  const all = parseOklahomaText(stdout, src);
  const kept = all.filter((s) => included(s.id, src.include));
  console.log(`OK Title ${src.title}: ${all.length} sections parsed, ${kept.length} kept`);
  if (!kept.length) throw new Error(`Title ${src.title}: nothing matched — check the include patterns or the PDF format`);
  return kept;
}

async function federal(src, date) {
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${src.title}.xml?part=${encodeURIComponent(src.part)}`;
  const xml = (await fetchBuf(url)).toString('utf8');
  const secs = parseEcfrXml(xml, src);
  console.log(`${src.title} CFR Part ${src.part}: ${secs.length} sections`);
  if (!secs.length) throw new Error(`${src.title} CFR ${src.part}: no sections parsed`);
  return secs;
}

async function ecfrDates() {
  const j = JSON.parse((await fetchBuf('https://www.ecfr.gov/api/versioner/v1/titles.json')).toString('utf8'));
  return Object.fromEntries(j.titles.map((t) => [t.number, t.up_to_date_as_of]));
}

const cfg = JSON.parse(await readFile(join(root, 'knowledge', 'sources.json'), 'utf8'));
const sections = [];
for (const src of cfg.oklahoma) sections.push(...(await oklahoma(src)));
const dates = await ecfrDates();
for (const src of cfg.federal) sections.push(...(await federal(src, dates[src.title])));

// De-duplicate ids (keep first).
const seen = new Set();
const unique = sections.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));

const library = {
  builtAt: new Date().toISOString(),
  sources: {
    oklahoma: 'Oklahoma Statutes (unannotated), Oklahoma Legislature complete titles',
    federal: Object.fromEntries(cfg.federal.map((f) => [`${f.title} CFR ${f.part}`, `eCFR, current as of ${dates[f.title]}`]))
  },
  count: unique.length,
  sections: unique
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(library));
console.log(`Wrote ${unique.length} sections to ${OUT} (${(JSON.stringify(library).length / 1e6).toFixed(1)} MB)`);
