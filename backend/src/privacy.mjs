// Personal information that should never be stored or sent to the AI model.
// The member page runs the same checks before sending (web/index.html → PRIVACY), so this is the
// second line of defense: it catches anything that reaches the server anyway.
//
// "Hard" items are replaced on the server. "Soft" items (an email address or phone number) are only
// flagged on the member page, because questions often mention an office's own contact details.

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|${MONTH}\\.? \\d{1,2},? \\d{4}|\\d{4}-\\d{2}-\\d{2})`;

export const RULES = [
  { type: 'ssn', label: 'a Social Security number', hard: true,
    re: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b|\b(?:ssn|ss#|social security(?: number| no\.?| #)?)\W{0,6}\d{9}\b/gi },
  { type: 'card', label: 'a card number', hard: true,
    re: /\b(?:\d[ -]?){12,18}\d\b/g, check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  { type: 'account', label: 'a bank account or routing number', hard: true,
    re: /\b(?:bank |checking |savings )?(?:account|acct|routing|aba)(?: number| no\.?| #)?\W{0,4}\d{6,17}\b/gi },
  { type: 'dob', label: 'a date of birth', hard: true,
    re: new RegExp(`\\b(?:date of birth|dob|d\\.o\\.b\\.|birth ?date|birthday|born(?: on)?)\\W{0,6}${DATE}`, 'gi') },
  { type: 'license', label: "a driver's license number", hard: true,
    re: /\b(?:driver'?s? licen[cs]e|dl|cdl)(?: number| no\.?| #)?\W{0,4}[a-z]?\d{6,10}\b/gi },
  { type: 'email', label: 'an email address', hard: false,
    re: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi },
  { type: 'phone', label: 'a phone number', hard: false,
    re: /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g }
];

/** Everything that looks personal: [{ type, label, hard, text, index }]. */
export function findPersonal(text) {
  const out = [];
  const s = String(text || '');
  for (const r of RULES) {
    for (const m of s.matchAll(r.re)) {
      if (r.check && !r.check(m[0])) continue;
      if (out.some((o) => m.index < o.index + o.text.length && o.index < m.index + m[0].length)) continue; // overlaps an earlier find
      out.push({ type: r.type, label: r.label, hard: r.hard, text: m[0], index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Replaces hard items (or all items with { all: true }) with "[… removed]". Returns { text, removed: [types] }. */
export function redact(text, { all = false } = {}) {
  let s = String(text ?? '');
  const finds = findPersonal(s).filter((f) => all || f.hard);
  for (const f of [...finds].reverse()) {
    // Keep the words that introduce the number ("DOB ", "account number ") so the sentence still reads.
    const lead = f.type === 'dob' ? f.text.match(/^(?:date of birth|dob|d\.o\.b\.|birth ?date|birthday|born(?: on)?)\W{0,6}/i)?.[0] || ''
      : f.type === 'license' ? f.text.match(/^(?:driver'?s? licen[cs]e|dl|cdl)(?: number| no\.?| #)?\W{0,4}/i)?.[0] || ''
      : /^[a-z]/i.test(f.text) && f.type !== 'email' ? f.text.match(/^\D*/)[0] : '';
    s = s.slice(0, f.index) + lead + `[${f.label.replace(/^an? /, '')} removed]` + s.slice(f.index + f.text.length);
  }
  return { text: s, removed: finds.map((f) => f.type) };
}
