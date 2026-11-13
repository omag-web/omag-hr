import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library, tokenize } from '../src/library.mjs';

const lib = Library.load();

test('library loads with both jurisdictions', () => {
  assert.ok(lib.sections.length > 1000);
  assert.ok(lib.sections.some((s) => s.jurisdiction === 'OK'));
  assert.ok(lib.sections.some((s) => s.jurisdiction === 'US'));
});

test('get() accepts ids and human citations', () => {
  assert.equal(lib.get('11-12-106')?.cite, '11 O.S. § 12-106');
  assert.equal(lib.get('11 O.S. § 12-106')?.id, '11-12-106');
  assert.equal(lib.get('29 CFR 825.110')?.id, '29-CFR-825.110');
  assert.equal(lib.get('29 C.F.R. § 825.110')?.id, '29-CFR-825.110');
  assert.equal(lib.get('nope'), null);
});

test('every form-of-government starting point exists in the library', async () => {
  const { FORMS } = await import('../src/prompt.mjs');
  for (const [form, f] of Object.entries(FORMS)) {
    for (const id of f.authority) assert.ok(lib.get(id), `${form}: ${id} missing from library`);
  }
});

const top = (q, opts) => lib.search(q, { limit: 5, ...opts }).map((s) => s.id);

test('search finds the right sections for typical questions', () => {
  assert.ok(top('statutory town board of trustees appoint remove employees', { jurisdiction: 'OK' }).includes('11-12-106'));
  assert.ok(top('city manager suspend remove employees', { jurisdiction: 'OK' }).includes('11-10-113'));
  assert.ok(top('executive session discuss employment of employee', { jurisdiction: 'OK' }).includes('25-307'));
  assert.ok(top('FMLA eligible employee 1,250 hours 50 employees 75 miles', { jurisdiction: 'US' }).includes('29-CFR-825.110'));
  assert.ok(top('final paycheck wages termination next regular payday', { jurisdiction: 'OK' }).includes('40-165.3'));
  assert.ok(top('personnel records confidential open records', { jurisdiction: 'OK' }).includes('51-24A.7'));
});

test('a citation in the query ranks that section first', () => {
  assert.equal(lib.search('what does 11 O.S. § 9-105 say')[0].id, '11-9-105');
  assert.equal(lib.search('29 CFR 825.300 notice')[0].id, '29-CFR-825.300');
});

test('jurisdiction filter', () => {
  assert.ok(lib.search('employee leave', { jurisdiction: 'US' }).every((s) => s.jurisdiction === 'US'));
  assert.ok(lib.search('employee leave', { jurisdiction: 'OK' }).every((s) => s.jurisdiction === 'OK'));
});

test('tokenizer keeps section numbers and matches word forms', () => {
  const same = (a, b) => assert.deepEqual(tokenize(a), tokenize(b), `${a} vs ${b}`);
  same('employees', 'employee'); same('appointment', 'appoint'); same('terminated', 'terminate'); same('termination', 'terminate'); same('policies', 'policy');
  assert.deepEqual(tokenize('Employees 825.110 hiring suspended'), ['employe', '825.110', 'hiring', 'suspend']);
});
