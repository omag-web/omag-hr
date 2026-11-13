import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
const { handler } = await import('../src/handler.mjs');
const { blobs } = await import('../src/storage.mjs');
const { numberWords } = await import('../src/templates.mjs');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const docText = (b64) => {
  const zip = new PizZip(Buffer.from(b64, 'base64'));
  return zip.file('word/document.xml').asText().replace(/<w:p[ >][^]*?<\/w:p>/g, (p) => p.replace(/<[^>]+>/g, '') + '\n').replace(/<[^>]+>/g, '');
};

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  const [rawPath, qs] = path.split('?');
  await handler({ rawPath, queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.7' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}
async function upload(id, variant, file) {
  const buf = fixture(file);
  const u = await call('POST', `/admin/templates/${id}/upload`, { body: { variant, filename: file, size: buf.length } });
  assert.equal(u.statusCode, 200, JSON.stringify(u.json));
  await blobs.put(u.json.key, buf);
  return call('POST', `/admin/templates/${id}/attach`, { body: { variant, key: u.json.key, filename: file } });
}

test('numbers print as words', () => {
  assert.equal(numberWords(3), 'three');
  assert.equal(numberWords(21), 'twenty-one');
  assert.equal(numberWords(480), 'four hundred eighty');
  assert.equal(numberWords(1.5), '1.5');
});

let id;
test('admin: create a template, upload Word files, questions are found automatically', async () => {
  const c = await call('POST', '/admin/templates', { body: { title: 'Test Personnel Policy', description: 'A test.' } });
  id = c.json.template.id;
  assert.equal(c.json.template.enabled, false);
  assert.equal((await call('PUT', `/admin/templates/${id}`, { body: { enabled: true } })).statusCode, 400, 'no file yet → can’t turn on');

  const a = await upload(id, 'all', 'template-city.docx');
  assert.equal(a.statusCode, 200, JSON.stringify(a.json));
  assert.deepEqual(a.json.tags, ['approval_date', 'municipality_name', 'offers_comp_time', 'pay_day', 'pay_period', 'sick_wait_months'], 'built-in fields (form_label, governing_body) aren’t questions');
  const comp = a.json.template.fields.find((f) => f.key === 'offers_comp_time');
  assert.equal(comp.type, 'yesno', '{{#sections}} become yes/no questions');

  const t = await upload(id, 'town', 'template-town.docx');
  assert.deepEqual(t.json.added, ['harassment_report_to']);

  const broken = await upload(id, 'cm', 'template-broken.docx');
  assert.equal(broken.statusCode, 400);
  assert.match(broken.json.error, /isn’t written correctly/);
  const bad = await upload(id, 'cm', 'template-badname.docx');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json.error, /lowercase letters/);
  assert.equal((await call('POST', `/admin/templates/${id}/upload`, { body: { variant: 'all', filename: 'old.doc', size: 10 } })).statusCode, 400, '.doc is refused with a hint');
});

test('admin: edit questions, then members see only the questions their version uses', async () => {
  const cur = (await call('GET', `/admin/templates/${id}`)).json.template;
  const fields = cur.fields.map((f) => ({
    ...f,
    ...(f.key === 'municipality_name' ? { label: 'Official name', required: true, prefill: 'municipality' } : {}),
    ...(f.key === 'pay_period' ? { type: 'select', default: 'biweekly', options: [{ value: 'biweekly', label: 'Every two weeks', text: 'biweekly' }, { value: 'monthly', label: 'Monthly', text: 'monthly' }] } : {}),
    ...(f.key === 'sick_wait_months' ? { type: 'number' } : {}),
    ...(f.key === 'approval_date' ? { type: 'date' } : {})
  }));
  const u = await call('PUT', `/admin/templates/${id}`, { body: { fields, notes: ['Have your attorney review it.'], enabled: true } });
  assert.equal(u.statusCode, 200, JSON.stringify(u.json));
  assert.equal((await call('PUT', `/admin/templates/${id}`, { body: { fields: [{ key: 'Bad Key' }] } })).statusCode, 400);
  assert.equal((await call('PUT', `/admin/templates/${id}`, { body: { fields: [{ key: 'x', type: 'select', options: [] }] } })).statusCode, 400, 'choices need options');

  const town = (await call('GET', '/templates?form=town')).json.templates.find((t) => t.id === id);
  assert.equal(town.variant, 'town');
  assert.ok(town.fields.some((f) => f.key === 'harassment_report_to'));
  const city = (await call('GET', '/templates?form=strong')).json.templates.find((t) => t.id === id);
  assert.equal(city.variant, 'all');
  assert.ok(!city.fields.some((f) => f.key === 'harassment_report_to'), 'town-only question hidden from cities');
  assert.deepEqual(town.notes, ['Have your attorney review it.']);
});

test('members: fill a document; blanks print as lines; sections follow yes/no answers', async () => {
  const r = await call('POST', '/templates/fill', { body: { templateId: id, form: 'cm', municipality: 'City of Ada', browserId: 'b_test', values: { municipality_name: 'City of Ada', pay_period: 'monthly', sick_wait_months: 3, approval_date: '2026-12-08', offers_comp_time: true, not_a_field: 'ignored' } } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.filename, 'Test Personnel Policy - City of Ada.docx');
  const text = docText(r.json.data);
  assert.match(text, /employees of the City of Ada \(“City”\), a Council-Manager City\./);
  assert.match(text, /Employees are paid monthly on ________\./, 'unanswered → blank line');
  assert.match(text, /after three \(3\) months/);
  assert.match(text, /Compensatory time is offered/);
  assert.match(text, /Approved by the City Council on December 8, 2026\./);
  assert.ok(!/\{\{|ignored/.test(text));
  assert.deepEqual(r.json.blanks, ['Pay day']);

  const no = docText((await call('POST', '/templates/fill', { body: { templateId: id, form: 'town', values: { municipality_name: 'Town of Bly', offers_comp_time: false } } })).json.data);
  assert.ok(!/Compensatory time/.test(no), 'section removed when the answer is no');
  assert.match(no, /Board of Trustees/);
  assert.match(no, /report harassment to the ________/);

  assert.equal((await call('POST', '/templates/fill', { body: { templateId: 'nope-0000' } })).statusCode, 404);
});

test('charter cities fall back to the Council-Manager file; disabled templates are hidden', async () => {
  const c = await call('POST', '/admin/templates', { body: { title: 'CM Only' } });
  const cmId = c.json.template.id;
  await upload(cmId, 'cm', 'template-city.docx');
  await call('PUT', `/admin/templates/${cmId}`, { body: { enabled: true } });
  const charter = (await call('GET', '/templates?form=charter')).json.templates.find((t) => t.id === cmId);
  assert.equal(charter.variant, 'cm');
  assert.match(charter.fallback, /Charter/);
  assert.ok(!(await call('GET', '/templates?form=town')).json.templates.some((t) => t.id === cmId), 'no file for towns → not listed');
  await call('PUT', `/admin/templates/${cmId}`, { body: { enabled: false } });
  assert.ok(!(await call('GET', '/templates?form=cm')).json.templates.some((t) => t.id === cmId));
  const test = await call('POST', `/admin/templates/${cmId}/test`, { body: { form: 'cm', values: { municipality_name: 'City of Test' } } });
  assert.equal(test.statusCode, 200, 'admins can test a template before turning it on');
  await call('DELETE', `/admin/templates/${cmId}`);
});

test('template packs export and import', async () => {
  const ex = (await call('GET', '/admin/templates-export')).json;
  const zip = new PizZip(Buffer.from(ex.data, 'base64'));
  const manifest = JSON.parse(zip.file('manifest.json').asText());
  assert.ok(manifest.templates.some((t) => t.id === id && Object.keys(t.variants).length === 2));
  await call('DELETE', `/admin/templates/${id}`);
  assert.ok(!(await call('GET', '/templates?form=town')).json.templates.some((t) => t.id === id));
  const up = (await call('POST', '/admin/templates-import/upload')).json;
  await blobs.put(up.key, Buffer.from(ex.data, 'base64'));
  const im = await call('POST', '/admin/templates-import', { body: { key: up.key } });
  assert.equal(im.statusCode, 200, JSON.stringify(im.json));
  const back = (await call('GET', '/templates?form=town')).json.templates.find((t) => t.id === id);
  assert.ok(back && back.fields.find((f) => f.key === 'pay_period').options.length === 2, 'questions survive the round trip');
});

test('Pip offers a document in chat, with answers the member gave', async () => {
  process.env.MODEL_MODE = 'mock';
  const s = makeResponseStream();
  // Use the real personnel template id the mock picks for "handbook".
  const c = await call('POST', '/admin/templates', { body: { title: 'Employee Personnel Policy' } });
  const ppId = c.json.template.id;
  const { kv } = await import('../src/storage.mjs');
  const t = await kv.get('TEMPLATE', ppId);
  await kv.del('TEMPLATE', ppId);
  await kv.put({ ...t, sk: 'personnel-policies', id: 'personnel-policies' });
  await upload('personnel-policies', 'all', 'template-city.docx');
  await call('PUT', '/admin/templates/personnel-policies', { body: { enabled: true } });

  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify({ conversationId: 'conv_doc_1', form: 'cm', messages: [{ role: 'user', text: 'Can you build our personnel handbook for the City of Ada?' }] }), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.8' } } }, s);
  await s.done;
  const events = s.result().body.trim().split('\n').map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.documents.length, 1);
  assert.equal(done.documents[0].templateId, 'personnel-policies');
  assert.deepEqual(done.documents[0].prefill, { municipality_name: 'City of Ada' });
});

test('analytics count documents built', async () => {
  const a = (await call('GET', '/admin/analytics', { body: undefined })).json;
  assert.ok(a.totals.documents >= 2, JSON.stringify(a.totals));
  assert.ok(a.documents.some((d) => d.name === 'Test Personnel Policy'));
});
