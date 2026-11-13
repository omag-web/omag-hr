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
