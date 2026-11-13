// Parsers that turn official source documents into section records.
// Kept dependency-free so they run anywhere (GitHub Actions, a laptop, tests).

/**
 * Split the text of an Oklahoma Legislature complete-title PDF (from `pdftotext`)
 * into sections. Section headings look like:
 *   §11-12-106.  Designated powers vested in board of trustees.
 *   §25-307.  Executive sessions.
 *   §51-24A.5.  Inspection and copying of records...
 * The front of each file is a table of contents whose lines end in dot leaders
 * and a page number; those are skipped.
 */
export function parseOklahomaText(text, { title, name, url }) {
  const lines = text
    .replace(/\r/g, '')
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/ /g, ' ').replace(/[ \t]+$/g, ''))
    // running page headers / footers
    .filter((l) => !/^\s*Oklahoma Statutes\s*-\s*Title\s+\S+.*Page\s+\d+\s*$/i.test(l))
    .filter((l) => !/^\s*Page\s+\d+\s*$/i.test(l));

  const HEAD = /^\s*§\s*(\d+[A-Z]?-[0-9A-Za-z.\-]*[0-9A-Za-z])\.\s+(.*)$/;
  const TOC = /\.{4,}\s*\d+\s*$/;
  const sections = [];
  let cur = null;

  for (const line of lines) {
    const m = line.match(HEAD);
    if (m && !TOC.test(line)) {
      if (cur) sections.push(cur);
      cur = { id: m[1], heading: m[2].trim(), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) sections.push(cur);

  return sections
    .map((s) => finishOklahomaSection(s, { title, name, url }))
    .filter(Boolean);
}

function finishOklahomaSection(s, { title, name, url }) {
  // Headings sometimes wrap onto the next line; if the heading doesn't end in a period,
  // pull following non-empty lines in until it does (max 2).
  let heading = s.heading;
  const body = [...s.body];
  for (let i = 0; i < 2 && !/[.)]$/.test(heading) && body.length; i++) {
    const next = body.shift().trim();
    if (!next) break;
    heading += ' ' + next;
  }
  heading = heading.replace(/\s+/g, ' ').replace(/\.$/, '').trim();

  if (/^(repealed|renumbered|blank|reserved)\b/i.test(heading)) return null;

  // Paragraphs: blank lines separate paragraphs; join wrapped lines.
  const paras = [];
  let buf = [];
  for (const raw of body) {
    const l = raw.trim();
    if (!l) { if (buf.length) { paras.push(buf.join(' ')); buf = []; } continue; }
    // New numbered/lettered item starts a new paragraph even without a blank line.
    if (buf.length && /^(\(?[A-Za-z0-9]{1,3}[.)]\s)/.test(l) && /[.;:]$/.test(buf[buf.length - 1])) {
      paras.push(buf.join(' ')); buf = [];
    }
    buf.push(l);
  }
  if (buf.length) paras.push(buf.join(' '));

  // History notes ("Laws 1977, c. 256, ...", "Added by Laws ...", "R.L. 1910 ...") go last.
  const history = [];
  while (paras.length && /^(Laws\s+\d{4}|Added by|Amended by|R\.L\.\s|Renumbered|Historical Data|St\.Ann\.)/.test(paras[paras.length - 1])) {
    history.unshift(paras.pop());
  }
  const text = paras.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
  if (!text) return null;

  const [, rest] = s.id.match(/^\d+[A-Z]?-(.*)$/) || [];
  return {
    id: s.id,
    cite: `${title} O.S. § ${rest}`,
    heading,
    jurisdiction: 'OK',
    source: `Oklahoma Statutes, Title ${title} (${name})`,
    url,
    text,
    history: history.join(' ').replace(/\s+/g, ' ').trim() || undefined
  };
}

/**
 * Split eCFR "full" XML for one part into sections.
 * Sections are <DIV8 N="825.110" TYPE="SECTION"> with a <HEAD> and <P> children.
 */
export function parseEcfrXml(xml, { title, part, name }) {
  const out = [];
  const re = /<DIV8\b[^>]*\bN="([^"]+)"[^>]*\bTYPE="SECTION"[^>]*>([\s\S]*?)<\/DIV8>/g;
  let m;
  while ((m = re.exec(xml))) {
    const num = m[1];
    const inner = m[2];
    const head = decode(stripTags((inner.match(/<HEAD>([\s\S]*?)<\/HEAD>/) || [])[1] || ''));
    const heading = head.replace(/^§+\s*[\d.A-Za-z-]+\s*/, '').replace(/\.$/, '').trim();
    if (/^\[?(reserved|removed)\]?$/i.test(heading)) continue;
    const paras = [];
    const pre = /<(P|FP|NOTE|EXTRACT|HD\d?)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let p;
    while ((p = pre.exec(inner))) {
      const t = decode(stripTags(p[2])).replace(/\s+/g, ' ').trim();
      if (t) paras.push(t);
    }
    const text = paras.join('\n\n');
    if (!text) continue;
    out.push({
      id: `${title}-CFR-${num}`,
      cite: `${title} C.F.R. § ${num}`,
      heading,
      jurisdiction: 'US',
      source: `${title} C.F.R. Part ${part} (${name})`,
      url: `https://www.ecfr.gov/current/title-${title}/section-${num}`,
      text
    });
  }
  return out;
}

function stripTags(s) { return s.replace(/<[^>]+>/g, ' '); }
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if the section id matches any of the include patterns. */
export function included(id, patterns) {
  return patterns.some((p) => new RegExp(p).test(id));
}
