#!/usr/bin/env node
// Runs eval/questions.json against a Pip API and reports which expected
// citations each answer included. Use it before launch and after any change to
// the prompt, the statute library or the model. GitHub runs it weekly
// (.github/workflows/eval.yml) against a private copy of Pip, not the live site.
//
//   PIP_API=http://localhost:8787 npm run eval        # against npm run dev
//   npm run eval -- 5                                  # just question 5
//   EVAL_MIN=0.8 npm run eval                          # exit with an error below 80%
//
// Each question can have:
//   "expect":      ids that should all be cited; with "any": true, at least one.
//                  An entry that is itself a list means "any one of these".
//   "mustInclude": patterns the answer must match (case-insensitive)
//   "mustNot":     patterns the answer must NOT match, e.g. a Social Security number

import { readFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const API = (process.env.PIP_API || 'http://localhost:8787').replace(/\/$/, '');
const only = process.argv[2] ? Number(process.argv[2]) : null;
const MIN = Number(process.env.EVAL_MIN || 0);
const cases = JSON.parse(await readFile(new URL('../eval/questions.json', import.meta.url), 'utf8'));

async function ask(c) {
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'eval_' + randomUUID().slice(0, 12), browserId: 'eval', form: c.form, messages: [{ role: 'user', text: c.q }] })
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  let text = '';
  let done = null;
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'reset') text = '';
    if (ev.type === 'done' || ev.type === 'error') done = ev;
  }
  if (done?.type === 'error') return { error: done.message, text };
  return { text, done };
}

let pass = 0;
let run = 0;
const rows = [];
for (const [i, c] of cases.entries()) {
  if (only !== null && i !== only) continue;
  run++;
  const started = Date.now();
  let r = await ask(c);
  if (r.error && /busy|HTTP 5/.test(r.error)) { await new Promise((ok) => setTimeout(ok, 20000)); r = await ask(c); }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const problems = [];
  const cited = (r.done?.citations || []).map((x) => x.id);
  if (r.error) problems.push(r.error);
  else {
    const hit = (e) => (Array.isArray(e) ? e.some((x) => cited.includes(x)) : cited.includes(e));
    const expect = c.expect || [];
    const citedOk = !expect.length || (c.any ? expect.some(hit) : expect.every(hit));
    if (!citedOk) problems.push(`missing citation: ${expect.filter((e) => !hit(e)).map((e) => [].concat(e).join(' or ')).join(', ')}`);
    for (const p of c.mustInclude || []) if (!new RegExp(p, 'i').test(r.text)) problems.push(`should mention /${p}/`);
    for (const p of c.mustNot || []) if (new RegExp(p, 'i').test(r.text)) problems.push(`must not say /${p}/`);
  }
  const ok = !problems.length;
  if (ok) pass++;
  rows.push({ i, c, ok, cited, secs, problems });
  console.log(`${ok ? '✓' : '✗'} ${i} [${c.form}] ${c.q}`);
  console.log(`    cited: ${cited.join(', ') || '(none)'}${r.done?.unread?.length ? `   ⚠ uncited/unread: ${r.done.unread.join(', ')}` : ''}   ${secs}s`);
  if (!ok) console.log('    ' + problems.join('; '));
  if (!ok || process.env.VERBOSE) console.log('    ' + String(r.text || '').replace(/\n/g, '\n    ').slice(0, 1500));
}

const share = run ? pass / run : 0;
console.log(`\n${pass}/${run} passed (${Math.round(share * 100)}%)`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `## Pip answer check: ${pass}/${run} passed (${Math.round(share * 100)}%)`,
    MIN ? `Required: ${Math.round(MIN * 100)}%` : '',
    '',
    '| # | Result | Question | Cited | Problem | Seconds |',
    '|---|---|---|---|---|---|',
    ...rows.map(({ i, c, ok, cited, secs, problems }) => `| ${i} | ${ok ? '✅' : '❌'} | ${c.q.replace(/\|/g, '/')} (${c.form}) | ${cited.join(', ')} | ${problems.join('; ').replace(/\|/g, '/')} | ${secs} |`)
  ];
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

if (MIN && share < MIN) {
  console.error(`Below the required ${Math.round(MIN * 100)}%.`);
  process.exit(1);
}
