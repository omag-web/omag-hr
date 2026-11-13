// OMAG guidance documents: upload → extract text → split into citable sections.
//
//   pk DOC   sk <docId>   { title, filename, contentType, size, status, enabled, sections, chars, error, uploadedAt, uploadedBy }
//   files:   docs/<docId>/original.<ext>   docs/<docId>/sections.json

import { randomBytes } from 'node:crypto';
import { kv, blobs } from './storage.mjs';
import { bumpVersion } from './config.mjs';

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
export async function createUpload({ filename, size, title }, by) {
  const e = ext(filename);
  if (!TYPES[e]) throw err(e === 'doc' ? 'Old .doc files aren’t supported. Save it as .docx or PDF and upload that.' : 'Upload a PDF, Word (.docx) or text file.');
  if (!(size > 0) || size > MAX_BYTES) throw err('Files must be under 15 MB.');
  const id = `${slug(title || filename)}-${randomBytes(2).toString('hex')}`;
  const key = `docs/${id}/original.${e}`;
  await kv.put({
    pk: 'DOC', sk: id,
    title: String(title || filename.replace(/\.[^.]+$/, '')).trim().slice(0, 120),
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
    const text = await extractText(buf, ext(doc.key));
    if (text.replace(/\s/g, '').length < 40) throw err('No readable text found. If this is a scanned PDF, it needs OCR first.');
    const sections = toSections(text, { id, title: doc.title });
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

export async function updateDoc(id, { enabled, title }) {
  const doc = await kv.get('DOC', id);
  if (!doc) throw err('Document not found.', 404);
  const attrs = {};
  if (typeof enabled === 'boolean') {
    if (enabled && doc.status !== 'ready') throw err('This document isn’t ready yet.');
    attrs.enabled = enabled;
  }
  if (typeof title === 'string' && title.trim()) attrs.title = title.trim().slice(0, 120);
  if (!Object.keys(attrs).length) return;
  await kv.patch('DOC', id, attrs);
  if (attrs.title && doc.status === 'ready') {
    // Rebuild citations with the new title.
    const buf = await blobs.get(`docs/${id}/sections.json`);
    if (buf) {
      const secs = JSON.parse(buf.toString('utf8')).map((s, i, all) => ({ ...s, ...labels(attrs.title, i, all.length) }));
      await blobs.put(`docs/${id}/sections.json`, JSON.stringify(secs), 'application/json');
    }
  }
  await bumpVersion('docs');
}

export async function deleteDoc(id) {
  const doc = await kv.get('DOC', id);
  if (!doc) return;
  await Promise.all([blobs.del(doc.key), blobs.del(`docs/${id}/sections.json`)]);
  await kv.del('DOC', id);
  await bumpVersion('docs');
}

/** Sections from every enabled document, for the library. */
export async function enabledSections() {
  const docs = (await listDocs()).filter((d) => d.enabled && d.status === 'ready');
  const all = await Promise.all(docs.map(async (d) => {
    const buf = await blobs.get(`docs/${d.id}/sections.json`);
    return buf ? JSON.parse(buf.toString('utf8')) : [];
  }));
  return { titles: docs.map((d) => d.title), sections: all.flat() };
}

/* ---------- text extraction ---------- */
export async function extractText(buf, kind) {
  if (kind === 'txt' || kind === 'md') return buf.toString('utf8');
  if (kind === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (kind === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n\n');
  }
  throw err('Unsupported file type.');
}

/* ---------- splitting into sections ---------- */
const TARGET = 1600;

function labels(title, i, n) {
  return { cite: n > 1 ? `OMAG: ${title} (part ${i + 1})` : `OMAG: ${title}`, source: `OMAG guidance: ${title}` };
}

const isHeading = (p) =>
  p.length <= 90 && !/[.,;:]$/.test(p) && /[A-Za-z]/.test(p) &&
  (/^[A-Z0-9][A-Z0-9 &/,'()\-–—:.]+$/.test(p) || /^(\d+(\.\d+)*\.?|[IVX]+\.|Section\s+\d+)\s+\S/.test(p) || /^([A-Z][a-z’']*\s?){1,8}$/.test(p));

export function toSections(text, { id, title }) {
  const paras = String(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  let cur = { heading: null, parts: [], len: 0 };
  const flush = () => { if (cur.parts.length) chunks.push(cur); };
  for (const p of paras) {
    if (isHeading(p)) {
      if (cur.len > 300) { flush(); cur = { heading: p, parts: [], len: 0 }; continue; }
      if (!cur.heading && !cur.parts.length) { cur.heading = p; continue; }
    }
    if (cur.len + p.length > TARGET && cur.len > 0) { flush(); cur = { heading: cur.heading, parts: [], len: 0, cont: true }; }
    cur.parts.push(p);
    cur.len += p.length;
  }
  flush();

  return chunks.map((c, i) => ({
    id: `omag-${id}-${i + 1}`,
    heading: c.heading ? `${c.heading}${c.cont ? ' (continued)' : ''}` : title,
    jurisdiction: 'OMAG',
    text: c.parts.join('\n\n'),
    ...labels(title, i, chunks.length)
  }));
}
