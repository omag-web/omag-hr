import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPersonal, redact } from '../src/privacy.mjs';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

test('finds personal details, and leaves legal citations and ordinary numbers alone', () => {
  const t = (s) => findPersonal(s).map((f) => f.type);
  assert.deepEqual(t('SSN 123-45-6789'), ['ssn']);
  assert.deepEqual(t('social security number 123456789'), ['ssn']);
  assert.deepEqual(t('card 4111 1111 1111 1111'), ['card']);
  assert.deepEqual(t('card 4111 1111 1111 1112'), [], 'not a valid card number');
  assert.deepEqual(t('account number 0012345678'), ['account']);
  assert.deepEqual(t('DOB 03/04/1980'), ['dob']);
  assert.deepEqual(t('born on March 4, 1980'), ['dob']);
  assert.deepEqual(t('CDL # D12345678'), ['license']);
  assert.deepEqual(t('clerk@town.gov or 405-555-1234'), ['email', 'phone']);
  for (const ok of ['29 CFR 825.200 and 11 O.S. § 12-106', 'Ordinance 12345678 passed 11/13/2026', '1,250 hours, 50 employees within 75 miles', 'Resolution 2026-114', 'FY 2026-2027 budget of $1,234,567']) {
    assert.deepEqual(t(ok), [], ok);
  }
});

test('redacts hard details only (unless asked), keeping the sentence readable', () => {
  assert.equal(redact('Jane, DOB 03/04/1980, SSN 123-45-6789, needs FMLA').text, 'Jane, DOB [date of birth removed], SSN [Social Security number removed], needs FMLA');
  assert.equal(redact('Call 405-555-1234').text, 'Call 405-555-1234', 'phone numbers are only flagged on the member page');
  assert.equal(redact('Call 405-555-1234', { all: true }).text, 'Call [phone number removed]');
  assert.deepEqual(redact('nothing here').removed, []);
});

test('the member page uses the same rules as the server', () => {
  const page = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/privacy.mjs', import.meta.url), 'utf8');
  const res = (src) => [...src.matchAll(/re: (\/.*?\/[gi]+|new RegExp\(.*?\))[,\s]/g)].map((m) => m[1]);
  assert.deepEqual(res(page.slice(page.indexOf('const PRIVACY'))).slice(0, 7), res(server).slice(0, 7));
});

test('chat: ID numbers never reach the model or the conversation log', async () => {
  process.env.MODEL_MODE = 'mock';
  installShim();
  const { handler } = await import('../src/handler.mjs');
  const { kv } = await import('../src/storage.mjs');
  const s = makeResponseStream();
  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify({ conversationId: 'conv_priv_1', form: 'town', messages: [{ role: 'user', text: 'Employee SSN 123-45-6789 wants FMLA leave' }] }), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.20' } } }, s);
  await s.done;
  const turns = await kv.query('CONV#conv_priv_1');
  assert.equal(turns.length, 1);
  assert.match(turns[0].question, /SSN \[Social Security number removed\] wants FMLA leave/);
  assert.ok(!JSON.stringify(turns).includes('6789'));
});

test('privacy notice: default text, editable in settings, reset by saving the default', async () => {
  installShim();
  const { handler } = await import('../src/handler.mjs');
  const call = async (method, path, body) => {
    const s = makeResponseStream();
    await handler({ rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.30' } } }, s);
    await s.done; return JSON.parse(s.result().body);
  };
  const { invalidateConfig } = await import('../src/config.mjs');
  let c = await call('GET', '/config');
  assert.match(c.privacyNotice, /## What we keep/);
  assert.match(c.privacyNotice, /\{retention\}/);
  assert.equal(c.retentionDays, 730);
  const a = await call('GET', '/admin/settings');
  assert.equal(a.privacyDefault, c.privacyNotice);
  await call('PUT', '/admin/settings', { privacyNotice: '## Privacy\nCustom notice.' });
  invalidateConfig();
  c = await call('GET', '/config');
  assert.equal(c.privacyNotice, '## Privacy\nCustom notice.');
  const saved = await call('PUT', '/admin/settings', { privacyNotice: a.privacyDefault });
  assert.equal(saved.settings.privacyNotice, '', 'saving the default text stores "use the default"');
});
