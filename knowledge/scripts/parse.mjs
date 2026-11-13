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
    // running page headers / footers, and table-of-contents dot leaders
    .filter((l) => !/^\s*Oklahoma Statutes\s*-\s*Title\s+\S+/i.test(l))
    .filter((l) => !/^\s*Page\s+\d+(\s+of\s+\d+)?\s*$/i.test(l))
    .filter((l) => !/\.{5,}/.test(l))
    // A heading can start mid-line, right after the previous section's history note:
    //   "...Laws 1977, c. 256, § 22-101, eff. July 1, 1978. §11-22-101.1. Political activities..."
    // Split there so it becomes its own section (only for headings in this title, after a period).
    .flatMap((l) => l.split(new RegExp(`(?<=[.)\\]])\\s+(?=§\\s*${String(title).replace(/[^0-9A-Z]/gi, '')}-[0-9A-Za-z.\\-]*[0-9A-Za-z]\\.\\s+[A-Z])`)));

  const HEAD = /^\s*§\s*(\d+[A-Z]?-[0-9A-Za-z.\-]*[0-9A-Za-z])\.\s+(.*)$/;
  const sections = [];
  let cur = null;

  for (const line of lines) {
    const m = line.match(HEAD);
    if (m) {
      if (cur) sections.push(cur);
      cur = { id: m[1], heading: m[2].trim(), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) sections.push(cur);

  // The table of contents repeats every heading with no body; when an id appears
  // more than once keep the version with the most text.
  const best = new Map();
  for (const s of sections.map((x) => finishOklahomaSection(x, { title, name, url })).filter(Boolean)) {
    const prev = best.get(s.id);
    if (!prev || s.text.length > prev.text.length) best.set(s.id, s);
  }
  return [...best.values()];
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
  // "See the following versions: OS 85A-2v1 ... | OS 85A-2v2 ..." — the versions are their own sections.
  if (/^See the following versions/i.test(heading)) return null;

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

  // Re-join paragraphs split by a page break mid-sentence.
  for (let i = paras.length - 1; i > 0; i--) {
    const prev = paras[i - 1].trim();
    const next = paras[i].trim();
    const prevUnfinished = !/[.;:!?)"”]$/.test(prev);
    const nextIsNewItem = /^(\d{1,3}\.|[A-Z]\.|\(?[a-z0-9]{1,3}\))\s/.test(next);
    if (prevUnfinished && !nextIsNewItem) {
      paras.splice(i - 1, 2, paras[i - 1] + ' ' + paras[i]);
    }
  }

  // History notes ("Laws 1977, c. 256, ...", "Added by Laws ...", "R.L. 1910 ...") go last.
  const history = [];
  const HIST = /^(Laws\s+\d{4}|Added by|Amended by|R\.L\.\s|Renumbered|Historical Data|St\.Ann\.)/;
  while (paras.length && HIST.test(paras[paras.length - 1])) history.unshift(paras.pop());
  // History often runs straight on from the last sentence: "...costs. Laws 1977, c. 256, § 12-106, eff. ..."
  if (paras.length) {
    const last = paras[paras.length - 1];
    const m = last.match(/^([\s\S]*?[.;:)"])\s+((?:Added by |Amended by )?(?:Laws|R\.L\.)\s+\d{4}\b[\s\S]*)$/);
    if (m && m[1].trim()) { paras[paras.length - 1] = m[1]; history.unshift(m[2]); }
  }
  const text = paras.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
  if (!text) return null;

  const [, rest] = s.id.match(/^\d+[A-Z]?-(.*)$/) || [];
  // Conflicting amendments are published as separate versions, e.g. 51-24A.5v1 and 51-24A.5v2.
  const ver = rest.match(/^(.*?)v(\d+)$/);
  return {
    id: s.id,
    ...(ver ? { baseId: s.id.replace(/v\d+$/, ''), version: Number(ver[2]) } : {}),
    cite: ver ? `${title} O.S. § ${ver[1]} (version ${ver[2]})` : `${title} O.S. § ${rest}`,
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
