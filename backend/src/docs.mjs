// OMAG resources Pip can cite: uploaded documents and web pages.
// Upload or fetch → extract text → split into citable sections.
//
//   pk DOC   sk <docId>   files:    { title, publisher, filename, contentType, size, key, status, enabled, sections, chars, error, uploadedAt, uploadedBy }
//                         websites: { kind: 'web', url, title, status, enabled, sections, chars, contentHash, lastCheckedAt, changedAt, lastError, ... }
//   files:   docs/<docId>/original.<ext>   docs/<docId>/sections.json
//
// Websites are re-read daily (refreshWebsites). If a page can't be reached, Pip keeps the last good copy.

import { randomBytes, createHash } from 'node:crypto';
import { kv, blobs } from './storage.mjs';
import { bumpVersion } from './config.mjs';
import { fetchPublic, normalizeUrl, htmlToText, pageTitle } from './web.mjs';

const TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown'
};
const MAX_BYTES = 15 * 1024 * 1024;

const slug = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'doc';
const ext = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

export async function listDocs() {
  const items = await kv.query('DOC', { limit: 500 });
  return items
    .map(({ pk, ...d }) => ({ id: d.sk, ...d, sk: undefined }))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

/** Step 1: register the document and get a URL the browser uploads the file to. */
const cleanPublisher = (p) => String(p || '').replace(/[:\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'OMAG';

export async function createUpload({ filename, size, title, publisher }, by) {
  const e = ext(filename);
  if (!TYPES[e]) throw err(e === 'doc' ? 'Old .doc files aren’t supported. Save it as .docx or PDF and upload that.' : 'Upload a PDF, Word (.docx) or text file.');
  if (!(size > 0) || size > MAX_BYTES) throw err('Files must be under 15 MB.');
  const id = `${slug(title || filename)}-${randomBytes(2).toString('hex')}`;
  const key = `docs/${id}/original.${e}`;
  await kv.put({
    pk: 'DOC', sk: id,
    title: String(title || filename.replace(/\.[^.]+$/, '')).trim().slice(0, 120),
    publisher: cleanPublisher(publisher),
    filename: String(filename).slice(0, 200), contentType: TYPES[e], size, key,
    status: 'uploading', enabled: false, uploadedAt: new Date().toISOString(), uploadedBy: by
  });
  return { id, uploadUrl: await blobs.uploadUrl(key, TYPES[e]), contentType: TYPES[e] };
}

/** Step 2: after the browser uploads, extract text and build sections. */
export async function processDoc(id) {
  const doc = await kv.get('DOC', id);
  if (!doc) throw err('Document not found.', 404);
  const buf = await blobs.get(doc.key);
  if (!buf) throw err('The file didn’t finish uploading. Try again.');
  try {
    const extracted = await extractDoc(buf, ext(doc.key));
    const text = extracted.text;
    if (text.replace(/\s/g, '').length < 40) throw err('No readable text found. If this is a scanned PDF, it needs OCR first.');
    const sections = toSections(extracted, { id, title: doc.title, publisher: doc.publisher });
    await blobs.put(`docs/${id}/sections.json`, JSON.stringify(sections), 'application/json');
    await kv.patch('DOC', id, { status: 'ready', enabled: true, sections: sections.length, chars: text.length, error: null, processedAt: new Date().toISOString() });
    await bumpVersion('docs');
    return { sections: sections.length };
  } catch (e) {
    await kv.patch('DOC', id, { status: 'error', enabled: false, error: e.status ? e.message : 'Couldn’t read this file.' });
    if (!e.status) console.error('processDoc failed', id, e);
    throw e.status ? e : err('Couldn’t read this file. Try saving it as PDF or .docx again.');
  }
}

export async function updateDoc(id, { enabled, title, publisher }) {
  const doc = await kv.get('DOC', id);
  if (!doc) throw err('Document not found.', 404);
  const attrs = {};
  if (typeof enabled === 'boolean') {
    if (enabled && doc.status !== 'ready') throw err('This document isn’t ready yet.');
    attrs.enabled = enabled;
  }
  if (typeof title === 'string' && title.trim()) attrs.title = title.trim().slice(0, 120);
  if (typeof publisher === 'string' && doc.kind !== 'web') attrs.publisher = cleanPublisher(publisher);
  if (!Object.keys(attrs).length) return;
  await kv.patch('DOC', id, attrs);
  if ((attrs.title || attrs.publisher) && doc.status === 'ready') {
    // Rebuild citations with the new title or publisher.
    const t = attrs.title || doc.title, pub = attrs.publisher || doc.publisher;
    const buf = await blobs.get(`docs/${id}/sections.json`);
    if (buf) {
      const secs = JSON.parse(buf.toString('utf8')).map((s, i, all) => ({ ...s, ...labels(t, i, all.length, s.url, pub, s.pages) }));
      await blobs.put(`docs/${id}/sections.json`, JSON.stringify(secs), 'application/json');
    }
  }
  await bumpVersion('docs');
}

export async function deleteDoc(id) {
  const doc = await kv.get('DOC', id);
  if (!doc) return;
  await Promise.all([doc.key ? blobs.del(doc.key) : null, blobs.del(`docs/${id}/sections.json`)]);
  await kv.del('DOC', id);
  await bumpVersion('docs');
}

/* ---------- websites ---------- */
const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');

/** Add a web page. Reads it right away, so a bad address is reported immediately. */
export async function addWebsite({ url, title }, by) {
  url = normalizeUrl(url);
  if ((await listDocs()).some((d) => d.url === url)) throw err('That page is already in the list.');
  const id = `${slug(title || hostOf(url))}-${randomBytes(2).toString('hex')}`;
  await kv.put({
    pk: 'DOC', sk: id, kind: 'web', url,
    title: String(title || '').trim().slice(0, 120),
    status: 'processing', enabled: false, uploadedAt: new Date().toISOString(), uploadedBy: by
  });
  try {
    return { id, ...(await fetchWebsite(id)) };
  } catch (e) {
    // Don't keep a website that never worked.
    await kv.del('DOC', id);
    throw e;
  }
}

/** Read a web page again. Only rebuilds sections when the page's text changed. */
export async function fetchWebsite(id) {
  const doc = await kv.get('DOC', id);
  if (!doc || doc.kind !== 'web') throw err('Website not found.', 404);
  const now = new Date().toISOString();
  try {
    const page = await fetchPublic(doc.url);
    let text, extracted, title = doc.title;
    const isPdf = page.contentType.includes('pdf') || (!page.contentType && /\.pdf$/i.test(page.url));
    if (isPdf) {
      extracted = await extractDoc(page.body, 'pdf');
      text = extracted.text;
    } else if (!page.contentType || /html|xml/.test(page.contentType)) {
      const html = page.body.toString('utf8');
      text = htmlToText(html);
      if (!title) title = pageTitle(html);
    } else if (page.contentType.startsWith('text/')) {
      text = page.body.toString('utf8');
    } else {
      throw err('That address isn’t a web page or a PDF.');
    }
    if (!title) title = hostOf(page.url);
    if (String(text).replace(/\s/g, '').length < 40) {
      throw err('No readable text found on that page. Some sites only show their content with JavaScript; try a different page on the site, or save the page as a PDF and upload that.');
    }
    const hash = createHash('sha256').update(title + '\n' + text).digest('hex').slice(0, 32);
    if (doc.status === 'ready' && doc.contentHash === hash) {
      await kv.patch('DOC', id, { lastCheckedAt: now, lastError: null });
      return { changed: false, sections: doc.sections };
    }
    const sections = toSections(extracted || text, { id, title, url: page.url });
    await blobs.put(`docs/${id}/sections.json`, JSON.stringify(sections), 'application/json');
    await kv.patch('DOC', id, {
      status: 'ready', enabled: doc.status === 'ready' ? doc.enabled : true, title, finalUrl: page.url,
      sections: sections.length, chars: text.length, contentHash: hash,
      lastCheckedAt: now, changedAt: now, lastError: null, error: null
    });
    await bumpVersion('docs');
    return { changed: true, sections: sections.length };
  } catch (e) {
    const message = e.status ? e.message : 'Couldn’t read that page.';
    if (!e.status) console.error('fetchWebsite failed', id, e);
    if (doc.status === 'ready') await kv.patch('DOC', id, { lastCheckedAt: now, lastError: message });
    else await kv.patch('DOC', id, { status: 'error', error: message, lastCheckedAt: now });
    throw err(message);
  }
}

/** Daily: re-read every website. One failing site doesn't stop the others. */
export async function refreshWebsites() {
  const sites = (await listDocs()).filter((d) => d.kind === 'web');
  const results = [];
  for (const d of sites) {
    try { results.push({ id: d.id, ...(await fetchWebsite(d.id)) }); } catch (e) { results.push({ id: d.id, error: e.message }); }
  }
  return results;
}

/** Sections from every enabled document, for the library. */
export async function enabledSections() {
  const docs = (await listDocs()).filter((d) => d.enabled && d.status === 'ready');
  const all = await Promise.all(docs.map(async (d) => {
    const buf = await blobs.get(`docs/${d.id}/sections.json`);
    return buf ? JSON.parse(buf.toString('utf8')) : [];
  }));
  return { titles: docs.map((d) => (d.publisher && d.publisher !== 'OMAG' ? `${d.title} (published by ${d.publisher})` : d.title)), sections: all.flat() };
}

/* ---------- text extraction ---------- */
/**
 * Text of a file. PDFs come back as `{ text, paras }`, where `paras` keeps the page each
 * paragraph is on (the printed page number when the PDF has one), so citations can say "p. B-10".
 */
export async function extractDoc(buf, kind) {
  if (kind === 'txt' || kind === 'md') return { text: buf.toString('utf8') };
  if (kind === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value };
  }
  if (kind === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: false });
    const paras = pdfParagraphs(Array.isArray(text) ? text : [text]);
    return { text: paras.map((x) => x.text).join('\n\n'), paras };
  }
  throw err('Unsupported file type.');
}
/** Plain text of a file (kept for callers that only need the text). */
export async function extractText(buf, kind) { return (await extractDoc(buf, kind)).text; }

const PAGE_LABEL = /^(?:([A-Z]{1,3})\s*[-–]\s*(\d{1,4})|(?:page\s+)?(\d{1,4})(?:\s+of\s+\d+)?)$/i;
const normLine = (l) => l.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim();
const isLeader = (l) => /(\.{4,}|…{2,}|(\.\s){3,})\s*[A-Z]?\s?[-–]?\s?\d/.test(l); // table of contents / index lines
const endsSentence = (l) => /[.!?:;"”)]$/.test(l);
const startsItem = (l) => /^([•▪◦\-–*]|\d{1,2}[.)]|[a-z][.)]|\([a-z0-9]{1,3}\)|[IVX]{1,4}\.)\s/.test(l);

/** Turns PDF page texts into paragraphs: drops repeating headers/footers, finds page labels and headings. */
export function pdfParagraphs(pages) {
  const pageLines = pages.map((t) => String(t || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean));
  // Lines that repeat (ignoring numbers) on a quarter or more of the pages are headers or footers.
  const seen = new Map();
  for (const lines of pageLines) for (const k of new Set(lines.filter((l) => l.length <= 100).map(normLine))) seen.set(k, (seen.get(k) || 0) + 1);
  const minRepeat = Math.max(3, Math.ceil(pages.length * 0.25));
  const boiler = (l) => l.length <= 100 && pages.length >= 4 && (seen.get(normLine(l)) || 0) >= minRepeat;

  const out = [];
  pageLines.forEach((lines, i) => {
    let label = null;
    const body = [];
    lines.forEach((l, j) => {
      const edge = j < 3 || j >= lines.length - 3;
      const m = edge && l.match(PAGE_LABEL);
      if (m) { label ||= m[1] ? `${m[1].toUpperCase()}-${m[2]}` : m[3]; return; }
      if (boiler(l) || isLeader(l)) return;
      body.push(l);
    });
    const page = label || String(i + 1);
    const lens = body.map((l) => l.length).sort((a, b) => a - b);
    const full = lens.length ? lens[Math.floor(lens.length * 0.75)] : 80;
    let cur = null;
    const push = () => { if (cur) out.push(cur); cur = null; };
    body.forEach((l, j) => {
      const heading = isHeading(l) && l.length < full * 0.95;
      if (heading) { push(); out.push({ text: l, page, heading: true }); return; }
      if (!cur) {
        // A page that starts mid-sentence continues the last paragraph of the previous page.
        const prev = out[out.length - 1];
        if (j === 0 && prev && !prev.heading && !endsSentence(prev.text) && /^[a-z(,;]/.test(l)) { cur = out.pop(); }
        else { cur = { text: l, page }; return; }
      } else if (startsItem(l) || (endsSentence(body[j - 1]) && body[j - 1].length < full * 0.8)) {
        push(); cur = { text: l, page }; return;
      }
      cur.text = /[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(l) ? cur.text.slice(0, -1) + l : `${cur.text} ${l}`;
    });
    push();
  });
  return out;
}

/* ---------- splitting into sections ---------- */
const TARGET = 1600;

function labels(title, i, n, url, publisher = 'OMAG', pages = null) {
  const part = pages ? `, p. ${pages}` : n > 1 ? ` (part ${i + 1})` : '';
  if (url) {
    // OMAG's own pages are cited as OMAG; other sites by page title, with the site named in the source line.
    const host = hostOf(url);
    const omag = /(^|\.)omag\.org$/.test(host);
    return { cite: omag ? `OMAG: ${title}${part}` : `${title}${part}`, source: omag ? `OMAG website: ${title}` : `Website (${host}): ${title}`, url };
  }
  publisher = publisher || 'OMAG';
  return { cite: `${publisher}: ${title}${part}`, source: publisher === 'OMAG' ? `OMAG guidance: ${title}` : `${publisher}: ${title}` };
}

const isHeading = (p) =>
  p.length <= 90 && !/[.,;:]$/.test(p) && /[A-Za-z]/.test(p) &&
  (/^[A-Z0-9][A-Z0-9 &/,'()\-–—:.§]+$/.test(p) || /^(\d+(\.\d+)*\.?|[IVX]+\.|Section\s+\d+)\s+\S/.test(p) || /^([A-Z][a-z’']*\s?){1,8}$/.test(p));

const pageRange = (a, b) => (a === b ? a : `${a}–${b}`);

/**
 * Splits a document into sections of about 1,600 characters, starting a new section at headings.
 * `input` is plain text, or `{ paras }` from extractDoc (paragraphs with page numbers).
 */
export function toSections(input, { id, title, url, publisher }) {
  const paged = Array.isArray(input?.paras);
  const paras = paged
    ? input.paras.map((x) => ({ text: x.text, page: x.page, heading: !!x.heading }))
    : String(input?.text ?? input)
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((text) => ({ text, heading: isHeading(text) }));

  const chunks = [];
  let cur = { heading: null, parts: [], len: 0 };
  const flush = () => { if (cur.parts.length) chunks.push(cur); };
  for (const p of paras) {
    if (p.heading) {
      if (cur.len > 300) { flush(); cur = { heading: p.text, parts: [], len: 0 }; continue; }
      if (!cur.parts.length) { cur.heading = cur.heading && cur.heading !== p.text ? `${cur.heading} — ${p.text}`.slice(0, 160) : p.text; continue; }
    }
    if (cur.len + p.text.length > TARGET && cur.len > 0) { flush(); cur = { heading: cur.heading, parts: [], len: 0, cont: true }; }
    if (!cur.parts.length) cur.firstPage = p.page;
    cur.lastPage = p.page;
    cur.parts.push(p.text);
    cur.len += p.text.length;
  }
  flush();

  return chunks.map((c, i) => ({
    id: `omag-${id}-${i + 1}`,
    heading: c.heading ? `${c.heading}${c.cont ? ' (continued)' : ''}` : title,
    jurisdiction: 'OMAG',
    text: c.parts.join('\n\n'),
    ...(paged && c.firstPage ? { pages: pageRange(c.firstPage, c.lastPage) } : {}),
    ...labels(title, i, chunks.length, url, publisher, paged && c.firstPage ? pageRange(c.firstPage, c.lastPage) : null)
  }));
}
