import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOklahomaText, parseEcfrXml, included } from './parse.mjs';

const OK_SAMPLE = `OKLAHOMA STATUTES
TITLE 11. CITIES AND TOWNS

§11-12-105.  Duties of mayor - Acting mayor......................................................................212
§11-12-106.  Designated powers vested in board of trustees................................................212

Oklahoma Statutes - Title 11. Cities and Towns Page 1

§11-12-105.  Duties of mayor - Acting mayor.
The mayor shall preside at meetings of the board and shall certify to the correct enrollment of all
ordinances and resolutions passed by it.

Laws 1977, c. 256, § 12-105, eff. July 1, 1978.

§11-12-106.  Designated powers vested in board of trustees.
All powers of a statutory town board of trustees, including the determination of matters of policy,
shall be vested in the board of trustees. Without limitation of the foregoing, the board may:
1.  Appoint and remove, and confirm appointments of, designated town officers and employees as
provided by law or ordinance;
2.  Enact municipal legislation subject to the limitations provided by law;
Oklahoma Statutes - Title 11. Cities and Towns Page 212
3.  Raise revenue, make appropriations, regulate salaries and wages and all other fiscal affairs of the
town.

Laws 1977, c. 256, § 12-106, eff. July 1, 1978; Laws 2002, c. 22, § 3.

§11-12-107.  Repealed by Laws 1980, c. 12, § 4.

§51-24A.5.  Inspection, copying and/or mechanical reproduction of
records - Exemptions.
All records of public bodies and public officials shall be open to any person for inspection.

Added by Laws 1985, c. 355, § 5.
`;

test('parses Oklahoma sections, skips TOC, headers and repealed sections', () => {
  const secs = parseOklahomaText(OK_SAMPLE, { title: '11', name: 'Cities and Towns', url: 'https://example/os11.pdf' });
  assert.deepEqual(secs.map((s) => s.id), ['11-12-105', '11-12-106', '51-24A.5']);
  const s106 = secs[1];
  assert.equal(s106.cite, '11 O.S. § 12-106');
  assert.equal(s106.heading, 'Designated powers vested in board of trustees');
  assert.match(s106.text, /^All powers of a statutory town board/);
  assert.match(s106.text, /1\. Appoint and remove, and confirm appointments of, designated town officers and employees as provided by law or ordinance;/);
  assert.match(s106.text, /3\. Raise revenue/);
  assert.doesNotMatch(s106.text, /Page 212/);
  assert.equal(s106.history, 'Laws 1977, c. 256, § 12-106, eff. July 1, 1978; Laws 2002, c. 22, § 3.');
  assert.equal(secs[2].heading, 'Inspection, copying and/or mechanical reproduction of records - Exemptions');
});

const OK_REAL_SHAPES = `§11-10-116.  Vice-mayor - Duties. ............................................................
.............................................................................................. 67
Oklahoma Statutes - Title 11. Cities and Towns

§11-1-102.  Definitions.
As used in the Oklahoma Municipal Code:
1.  "Charter municipality" means any municipality which has adopted a charter in accordance with the provisions of the Constitution and laws of
Oklahoma Statutes - Title 11. Cities and Towns

Page 3
Oklahoma and at the time of adoption of the charter had a population of two thousand (2,000) or more;
2.  "City" means a municipality which has incorporated as a city.
Laws 1977, c. 256, § 1-102, eff. July 1, 1978; Laws 2015, c. 47, § 1.

§11-10-116.  Vice-mayor - Duties.
The vice-mayor shall perform the duties of mayor during the absence of the mayor.
Laws 1977, c. 256, § 10-116, eff. July 1, 1978.

§51-24A.5.  See the following versions:
OS 51-24A.5v1 (HB 1, Laws 2025, c. 1, § 1)

§51-24A.5v2.  Inspection, copying and/or mechanical reproduction of records - Exemptions.
All records of public bodies shall be open to any person for inspection.
`;

test('handles wrapped TOC lines, bare page headers, inline history and versions', () => {
  const secs = parseOklahomaText(OK_REAL_SHAPES, { title: '11', name: 'Cities and Towns', url: 'u' });
  const byId = Object.fromEntries(secs.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['11-1-102', '11-10-116', '51-24A.5v2']);
  assert.equal(byId['11-10-116'].text, 'The vice-mayor shall perform the duties of mayor during the absence of the mayor.');
  assert.equal(byId['11-10-116'].history, 'Laws 1977, c. 256, § 10-116, eff. July 1, 1978.');
  const def = byId['11-1-102'];
  assert.doesNotMatch(def.text, /Oklahoma Statutes - Title|Page 3/);
  assert.match(def.text, /laws of Oklahoma and at the time of adoption/);
  assert.equal(def.history, 'Laws 1977, c. 256, § 1-102, eff. July 1, 1978; Laws 2015, c. 47, § 1.');
  assert.match(def.text, /2\. "City" means a municipality which has incorporated as a city\.$/);
  const v = byId['51-24A.5v2'];
  assert.equal(v.baseId, '51-24A.5');
  assert.equal(v.version, 2);
  assert.equal(v.cite, '11 O.S. § 24A.5 (version 2)'.replace('11 O.S.', '11 O.S.'));
});

test('include patterns', () => {
  assert.ok(included('11-12-106', ['^11-12-']));
  assert.ok(included('25-307', ['^25-3(0[1-9]|1[0-4])(\\.|$)']));
  assert.ok(included('25-307.1', ['^25-3(0[1-9]|1[0-4])(\\.|$)']));
  assert.ok(!included('25-3', ['^25-3(0[1-9]|1[0-4])(\\.|$)']));
  assert.ok(included('51-155', ['^51-1(5[1-9]|[6-9][0-9])(\\.|$)']));
  assert.ok(!included('51-24', ['^51-24A\\.']));
  assert.ok(included('51-24A.7', ['^51-24A\\.']));
});

const CFR_SAMPLE = `<?xml version="1.0"?><DIV5 N="825" TYPE="PART"><HEAD>PART 825—THE FAMILY AND MEDICAL LEAVE ACT OF 1993</HEAD>
<DIV8 N="825.110" TYPE="SECTION" VOLUME="3">
<HEAD>§ 825.110 Eligible employee.</HEAD>
<P>(a) An <I>eligible employee</I> is an employee of a covered employer who:</P>
<P>(1) Has been employed by the employer for at least 12 months, and</P>
<P>(3) Is employed at a worksite where 50 or more employees are employed by the employer within 75 miles of that worksite. See &#167; 825.105(b) &amp; 825.111.</P>
</DIV8>
<DIV8 N="825.111" TYPE="SECTION"><HEAD>§ 825.111 [Reserved]</HEAD></DIV8>
</DIV5>`;

test('parses eCFR XML sections', () => {
  const secs = parseEcfrXml(CFR_SAMPLE, { title: 29, part: '825', name: 'FMLA' });
  assert.equal(secs.length, 1);
  const s = secs[0];
  assert.equal(s.id, '29-CFR-825.110');
  assert.equal(s.cite, '29 C.F.R. § 825.110');
  assert.equal(s.heading, 'Eligible employee');
  assert.equal(s.url, 'https://www.ecfr.gov/current/title-29/section-825.110');
  assert.match(s.text, /\(a\) An eligible employee is an employee/);
  assert.match(s.text, /See § 825\.105\(b\) & 825\.111\./);
});

test('a heading that starts mid-line after a history note becomes its own section', () => {
  const text = [
    '§11-22-101. Corporate powers of municipalities.',
    'All municipalities shall have the powers listed here, and may exercise such other powers as are conferred by law.',
    'Laws 1977, c. 256, § 22-101, eff. July 1, 1978. §11-22-101.1. Political activities by municipal employees - Restrictions.',
    'Municipal employees may attend and express their views at city council meetings, or any other public meetings.',
    'Added by Laws 1985, c. 107, § 1. §11-22-101.2. Employer coercion prohibited.',
    'No employer shall coerce an employee, as provided in §11-22-101.1 of this title.',
    'Laws 1990, c. 1, § 1.'
  ].join('\n');
  const secs = parseOklahomaText(text, { title: '11', name: 'Cities and Towns', url: 'x' });
  const ids = secs.map((s) => s.id).sort();
  assert.deepEqual(ids, ['11-22-101', '11-22-101.1', '11-22-101.2']);
  const pol = secs.find((s) => s.id === '11-22-101.1');
  assert.match(pol.heading, /^Political activities/);
  assert.match(pol.text, /may attend and express their views/);
  assert.ok(!secs.find((s) => s.id === '11-22-101').text.includes('Political activities'), 'not glued onto the previous section');
  assert.match(secs.find((s) => s.id === '11-22-101.2').text, /as provided in §11-22-101\.1 of this title/, 'cross-references in the body are left alone');
});

test('a section number alone on its line takes the next line as its heading', () => {
  const text = [
    '§11-8-105. Bonds.',
    'The governing body shall pay the premiums on such bonds.',
    'Laws 1977, c. 256, § 8-105, eff. July 1, 1978; Laws 1992, c. 371, § 1, eff. July 1, 1992.',
    '§11-8-106.',
    '',
    'Nepotism - Dual office holding.',
    '',
    'No elected or appointed official or other person shall appoint a relative.',
    'See §11-8-106.1 and §11-8-106 of this title.',
    'Laws 1977, c. 256, § 8-106.',
    'Laws 1977, c. 256, § 8-107.§11-9-108.',
    'Powers vested in council - Designated powers.',
    'Except as otherwise provided, the council has the powers listed.'
  ].join('\n');
  const secs = parseOklahomaText(text, { title: '11', name: 'Cities and Towns', url: 'x' });
  assert.deepEqual(secs.map((s) => s.id).sort(), ['11-8-105', '11-8-106', '11-9-108']);
  const nep = secs.find((s) => s.id === '11-8-106');
  assert.equal(nep.heading, 'Nepotism - Dual office holding');
  assert.match(nep.text, /shall appoint a relative/);
  assert.match(nep.text, /See §11-8-106\.1 and §11-8-106 of this title/, 'cross-references stay in the body');
  assert.ok(!secs.find((s) => s.id === '11-8-105').text.includes('Nepotism'));
  assert.equal(secs.find((s) => s.id === '11-9-108').heading, 'Powers vested in council - Designated powers');
});
