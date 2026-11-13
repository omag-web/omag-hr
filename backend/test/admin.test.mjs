import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'pip-test-'));
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID;
const { handler } = await import('../src/handler.mjs');
const { blobs } = await import('../src/storage.mjs');
const { buildSystemPrompt } = await import('../src/prompt.mjs');
const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

async function call(method, path, { body, query, headers } = {}) {
  const stream = makeResponseStream();
  await handler({ rawPath: path, queryStringParameters: query, headers: headers || {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.5' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}

test('admin routes are open locally but closed in Lambda without Cognito', async () => {
  assert.equal((await call('GET', '/admin/me')).json.dev, true);
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'pip';
  try {
    const r = await call('GET', '/admin/me');
    assert.equal(r.statusCode, 401);
  } finally { delete process.env.AWS_LAMBDA_FUNCTION_NAME; }
});

test('guidance: draft, publish, history, restore', async () => {
  let g = (await call('GET', '/admin/guidance')).json;
  assert.equal(g.live.isDefault, true);
  assert.equal(g.draft, null);
  assert.match(g.live.text, /FMLA: all Oklahoma municipalities are covered/);

  g = (await call('PUT', '/admin/guidance/draft', { body: { text: g.live.text + '\n- Always mention OMAG’s HR hotline.' } })).json;
  assert.equal(g.draft.differs, true);
  assert.equal((await call('PUT', '/admin/guidance/draft', { body: { text: '   ' } })).statusCode, 400);

  g = (await call('POST', '/admin/guidance/publish', { body: { note: 'Add hotline' } })).json;
  assert.equal(g.draft, null);
  assert.match(g.live.text, /HR hotline/);
  assert.equal(g.history.length, 1);
  assert.equal(g.history[0].note, 'Add hotline');

  g = (await call('POST', '/admin/guidance/restore', { body: { id: 'default' } })).json;
  assert.doesNotMatch(g.draft.text, /HR hotline/);
  assert.equal(g.draft.differs, true);
  g = (await call('DELETE', '/admin/guidance/draft')).json;
  assert.equal(g.draft, null);
});

test('system prompt keeps locked rules and adds editable guidance and OMAG documents', () => {
  const p = buildSystemPrompt({ form: 'town', guidance: 'CUSTOM GUIDANCE LINE', omagDocs: ['Drug Testing Guidance'] });
  assert.match(p, /Only cite ids that your tools returned/);
  assert.match(p, /never present yourself as legal counsel/);
  assert.match(p, /CUSTOM GUIDANCE LINE/);
  assert.match(p, /"Drug Testing Guidance"/);
});

test('settings: saved, validated, and exposed publicly', async () => {
  const r = await call('PUT', '/admin/settings', { body: { starters: [{ kicker: 'Pay', text: 'When is final pay due?' }], disclaimer: 'Custom disclaimer.', dailyLimitPerIp: 25 } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json.settings.dailyLimitPerIp, 25);
  const pub = (await call('GET', '/config')).json;
  assert.deepEqual(pub.starters, [{ kicker: 'Pay', text: 'When is final pay due?' }]);
  assert.equal(pub.disclaimer, 'Custom disclaimer.');
  assert.equal(pub.dailyLimitPerIp, undefined, 'limits are not public');
  assert.equal((await call('PUT', '/admin/settings', { body: { dailyLimitGlobal: -5 } })).statusCode, 400);
  assert.equal((await call('PUT', '/admin/settings', { body: { modelId: 'not a model!' } })).statusCode, 400);
});

async function uploadDoc(filename, buf, title) {
  const up = await call('POST', '/admin/docs', { body: { filename, size: buf.length, title } });
  assert.equal(up.statusCode, 200, up.body);
  assert.match(up.json.uploadUrl, /^\/dev-upload\//);
  await blobs.put(decodeURIComponent(up.json.uploadUrl.replace('/dev-upload/', '')), buf); // what the browser does
  const p = await call('POST', `/admin/docs/${up.json.id}/process`);
  return { id: up.json.id, process: p };
}

test('documents: Word and PDF become searchable, citable sections; toggle and delete work', async () => {
  const before = (await call('GET', '/health')).json.library;
  assert.equal(before.omag, 0);

  const w = await uploadDoc('drug-testing.docx', fixture('sample-guidance.docx'), 'Drug Testing Guidance');
  assert.equal(w.process.statusCode, 200, w.process.body);
  const pdf = await uploadDoc('investigations.pdf', fixture('sample-guidance.pdf'), 'Workplace Investigations');
  assert.equal(pdf.process.statusCode, 200, pdf.process.body);

  const docs = (await call('GET', '/admin/docs')).json.docs;
  assert.equal(docs.length, 2);
  assert.ok(docs.every((d) => d.status === 'ready' && d.enabled && d.sections >= 1));

  const health = (await call('GET', '/health')).json.library;
  assert.ok(health.omag >= 2);

  const hits = (await call('POST', '/admin/library/search', { body: { query: 'reasonable suspicion supervisors document observations', jurisdiction: 'OMAG' } })).json.results;
  assert.ok(hits.length && hits[0].id.startsWith(`omag-${w.id}-`), JSON.stringify(hits));
  const src = (await call('GET', '/source', { query: { id: hits[0].id } })).json;
  assert.match(src.cite, /^OMAG: Drug Testing Guidance/);
  assert.match(src.text, /contemporaneous observations/);

  const pdfHits = (await call('POST', '/admin/library/search', { body: { query: 'harassment complaint investigation interview notes', jurisdiction: 'OMAG' } })).json.results;
  assert.ok(pdfHits[0].id.startsWith(`omag-${pdf.id}-`));

  await call('PUT', `/admin/docs/${w.id}`, { body: { enabled: false } });
  assert.equal((await call('POST', '/admin/library/search', { body: { query: 'reasonable suspicion supervisors', jurisdiction: 'OMAG' } })).json.results.filter((r) => r.id.startsWith(`omag-${w.id}`)).length, 0);

  await call('DELETE', `/admin/docs/${pdf.id}`);
  assert.equal((await call('GET', '/admin/docs')).json.docs.length, 1);
});

test('documents: rejects unsupported and unreadable files', async () => {
  assert.equal((await call('POST', '/admin/docs', { body: { filename: 'old.doc', size: 100 } })).statusCode, 400);
  const bad = await uploadDoc('empty.txt', Buffer.from('hi'), 'Empty');
  assert.equal(bad.process.statusCode, 400);
  assert.match(bad.process.json.error, /No readable text/);
  const d = (await call('GET', '/admin/docs')).json.docs.find((x) => x.id === bad.id);
  assert.equal(d.status, 'error');
});

test('conversations and contacts show up for admins; previews are kept separate', async () => {
  await call('POST', '/chat', { body: { conversationId: 'conv_admin_1', browserId: 'b', form: 'cm', city: 'City of Test', messages: [{ role: 'user', text: 'city manager remove employees' }] } });
  await call('POST', '/admin/preview', { body: { conversationId: 'conv_prev_1', form: 'town', messages: [{ role: 'user', text: 'board of trustees' }] } });
  await call('POST', '/contact', { body: { conversationId: 'conv_admin_1', note: 'Please call me' } });
  const turns = (await call('GET', '/admin/conversations')).json.turns;
  assert.ok(turns.some((t) => t.conversationId === 'conv_admin_1' && t.city === 'City of Test'));
  assert.ok(!turns.some((t) => t.conversationId === 'conv_prev_1'), 'admin previews are not member conversations');
  const conv = (await call('GET', '/admin/conversations/conv_admin_1')).json.turns;
  assert.equal(conv.length, 1);
  assert.equal((await call('GET', '/admin/contacts')).json.contacts[0].note, 'Please call me');
  const ov = (await call('GET', '/admin/overview')).json;
  assert.ok(ov.stats.questions >= 1);
});

test('library refresh: newer library goes live, older or broken ones are ignored', async () => {
  const realFetch = globalThis.fetch;
  const base = JSON.parse(readFileSync(new URL('../data/library.json', import.meta.url)));
  const serve = (data) => { globalThis.fetch = async () => new Response(JSON.stringify(data), { status: 200 }); };
  try {
    serve({ ...base, builtAt: '2000-01-01T00:00:00Z' });
    let r = (await call('POST', '/admin/library/refresh')).json;
    assert.equal(r.result.changed, false);

    serve({ ...base, builtAt: '2099-01-01T00:00:00Z', sections: base.sections.slice(0, 10) });
    r = (await call('POST', '/admin/library/refresh')).json;
    assert.equal(r.result.error, true);

    const marker = { id: '11-99-999', cite: '11 O.S. § 99-999', heading: 'Test section', jurisdiction: 'OK', source: 'test', text: 'zebra quokka test text' };
    serve({ ...base, builtAt: '2099-01-01T00:00:00Z', sections: [...base.sections, marker] });
    r = (await call('POST', '/admin/library/refresh')).json;
    assert.equal(r.result.changed, true);
    assert.equal((await call('GET', '/source', { query: { id: '11-99-999' } })).statusCode, 200);
    assert.equal(r.status.origin, 'refreshed');

    // the scheduled event uses the same path
    const stream = makeResponseStream();
    await handler({ pipTask: 'refresh-library' }, stream);
    await stream.done;
    assert.match(stream.result().body, /up to date/);
  } finally { globalThis.fetch = realFetch; }
});

test('analytics: totals, topics, cited sections, cities and comparison period', async () => {
  for (const [i, city] of ['Edmond', ' edmond ', 'Guthrie'].entries()) {
    await call('POST', '/chat', { body: { conversationId: `conv_an_${i}`, browserId: `b${i % 2}`, form: 'cm', city, messages: [{ role: 'user', text: 'city manager remove employees' }] } });
  }
  const a = (await call('GET', '/admin/analytics', { query: { days: '7' } })).json;
  assert.equal(a.days, 7);
  assert.ok(a.totals.questions >= 3);
  assert.ok(a.totals.people >= 2);
  assert.equal(a.series.length, 7);
  assert.equal(a.byHour.length, 24);
  assert.equal(a.byHour.reduce((x, y) => x + y, 0), a.totals.questions);
  const edmond = a.cities.find((c) => c.name.toLowerCase() === 'edmond');
  assert.equal(edmond.name, 'Edmond', 'prefers the capitalized spelling');
  assert.ok(edmond && edmond.n >= 2, 'city names are grouped ignoring case and spaces');
  assert.ok(a.topics.length >= 1);
  assert.ok(a.sections.every((s) => s.cite && s.n >= 1));
  assert.equal(a.totals.estimatedCost, null, 'no cost estimate until prices are set');
  await call('PUT', '/admin/settings', { body: { priceInputPerM: 1.5, priceOutputPerM: 6 } });
  const b = (await call('GET', '/admin/analytics', { query: { days: '30' } })).json;
  assert.equal(b.series.length, 30);
  assert.equal(typeof b.totals.estimatedCost, 'number');
  const y = (await call('GET', '/admin/analytics', { query: { days: '365' } })).json;
  assert.equal(y.bucket, 'week');
  const ex = (await call('GET', '/admin/analytics/export', { query: { days: '7' } })).json;
  assert.ok(ex.turns.length >= 3 && ex.turns.every((t) => !('browser' in t)));
});

test('topicOf groups sections into plain-language topics', async () => {
  const { topicOf } = await import('../src/analytics.mjs');
  assert.equal(topicOf('29-CFR-825.104'), 'FMLA leave');
  assert.equal(topicOf('29-CFR-541.100'), 'Wages & hours (FLSA)');
  assert.equal(topicOf('25-307'), 'Open meetings');
  assert.equal(topicOf('51-24A.5'), 'Open records');
  assert.equal(topicOf('51-155'), 'Tort claims & liability');
  assert.equal(topicOf('11-51-102'), 'Police & fire bargaining');
  assert.equal(topicOf('11-12-106'), 'Municipal authority (Title 11)');
  assert.equal(topicOf('omag-memo-ab12-0'), 'OMAG guidance');
});

test('documents from other publishers are cited under that publisher, not OMAG', async () => {
  const { readFileSync: rf } = await import('node:fs');
  const { blobs } = await import('../src/storage.mjs');
  const buf = rf(new URL('./fixtures/sample-guidance.pdf', import.meta.url));
  const up = (await call('POST', '/admin/docs', { body: { filename: 'handbook.pdf', size: buf.length, title: 'Handbook for City and Town Officials 2025', publisher: 'OML' } })).json;
  await blobs.put(`docs/${up.id}/original.pdf`, buf);
  assert.equal((await call('POST', `/admin/docs/${up.id}/process`)).statusCode, 200);
  let sec = (await call('GET', `/admin/docs/${up.id}/sections`)).json.sections[0];
  assert.match(sec.cite, /^OML: Handbook for City and Town Officials 2025/);
  await call('PUT', `/admin/docs/${up.id}`, { body: { publisher: 'Oklahoma Municipal League' } });
  sec = (await call('GET', `/admin/docs/${up.id}/sections`)).json.sections[0];
  assert.match(sec.cite, /^Oklahoma Municipal League: Handbook/);
  const plain = (await call('POST', '/admin/docs', { body: { filename: 'memo.pdf', size: buf.length, title: 'Memo' } })).json;
  await blobs.put(`docs/${plain.id}/original.pdf`, buf);
  await call('POST', `/admin/docs/${plain.id}/process`);
  assert.match((await call('GET', `/admin/docs/${plain.id}/sections`)).json.sections[0].cite, /^OMAG: Memo/, 'OMAG is the default');
});

test('PDF pages: footers dropped, printed page numbers kept, headings found, index lines skipped', async () => {
  const { pdfParagraphs, toSections } = await import('../src/docs.mjs');
  const footer = '© 2025 Oklahoma Municipal League, Inc.';
  const pages = [
    `${footer}\nB - 8\nNEPOTISM\nNo officer may appoint a relative within the third degree to any position in the\nmunicipality. This is a long line of ordinary body text that keeps going for a while.\nShort end.\nAnother paragraph starts here and it is long enough to look like body text in the PDF and`,
    `B - 9\n${footer}\ncontinues onto the next page without a break, as PDFs do.\nVACANCIES\nVacancies occur by death, resignation or removal of the officer from office, which is set out.`,
    `${footer}\nB - 10\nIndex\nNepotism ............................ B-8\nVacancies ........................... B-9`,
    `${footer}\nB - 11\nThe end of the chapter has some closing text that is plain and ordinary for the test.`
  ];
  const paras = pdfParagraphs(pages);
  const texts = paras.map((p) => p.text);
  assert.ok(!texts.some((t) => /Oklahoma Municipal League|^B - \d/.test(t)), 'footers and page numbers are not content');
  assert.ok(!texts.some((t) => /\.\.\.\.\./.test(t)), 'index lines are skipped');
  assert.deepEqual(paras.filter((p) => p.heading).map((p) => p.text), ['NEPOTISM', 'VACANCIES']);
  const joined = paras.find((p) => p.text.startsWith('Another paragraph'));
  assert.match(joined.text, /in the PDF and continues onto the next page/, 'a paragraph split across pages is rejoined');
  assert.equal(joined.page, 'B-8');
  const secs = toSections({ paras }, { id: 'hb', title: 'Handbook', publisher: 'OML' });
  assert.match(secs[0].cite, /^OML: Handbook, p\. B-8/);
  assert.equal(secs[0].heading.startsWith('NEPOTISM'), true);
});
