#!/usr/bin/env node
// Runs eval/questions.json against a Pip API and reports which expected
// citations each answer included. Use it before launch and after any change to
// the prompt, the statute library or the model.
//
//   PIP_API=https://xxxx.lambda-url.us-east-1.on.aws npm run eval
//   PIP_API=http://localhost:8787 npm run eval        # against npm run dev
//
// "expect" = all of these ids should be cited; with "any": true, at least one.

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const API = (process.env.PIP_API || 'http://localhost:8787').replace(/\/$/, '');
const only = process.argv[2] ? Number(process.argv[2]) : null;
const cases = JSON.parse(await readFile(new URL('../eval/questions.json', import.meta.url), 'utf8'));

let pass = 0;
for (const [i, c] of cases.entries()) {
  if (only !== null && i !== only) continue;
  const started = Date.now();
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'eval_' + randomUUID().slice(0, 12), browserId: 'eval', form: c.form, messages: [{ role: 'user', text: c.q }] })
  });
  if (!res.ok) { console.log(`✗ ${i} HTTP ${res.status}: ${await res.text()}`); continue; }
  let text = '';
  let done = null;
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'reset') text = '';
    if (ev.type === 'done' || ev.type === 'error') done = ev;
  }
  const cited = (done?.citations || []).map((x) => x.id);
  const ok = c.any ? c.expect.some((e) => cited.includes(e)) : c.expect.every((e) => cited.includes(e));
  if (ok) pass++;
  console.log(`${ok ? '✓' : '✗'} ${i} [${c.form}] ${c.q}`);
  console.log(`    cited: ${cited.join(', ') || '(none)'}${done?.unread?.length ? `   ⚠ uncited/unread: ${done.unread.join(', ')}` : ''}   ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!ok || process.env.VERBOSE) console.log('    ' + text.replace(/\n/g, '\n    ').slice(0, 1500));
}
console.log(`\n${pass}/${only !== null ? 1 : cases.length} passed`);
