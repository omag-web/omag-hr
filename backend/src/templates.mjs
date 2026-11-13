// Document templates: OMAG's Word files with {{fields}}, filled in for a member.
//
//   pk TEMPLATE  sk <id>  { id, title, description, enabled, order, fields[], notes[], variants{}, updatedAt, updatedBy }
//     variants: { all | town | aldermanic | cm | strong | charter: { key, filename, size, tags[], sections[], uploadedAt } }
//     fields:   [{ key, label, type, help, required, default, options[{value,label,text}], prefill, group }]
//   files:      templates/<id>/<variant>-<stamp>.docx
//
// Inside a Word file, admins write {{field_name}}. Supported:
//   {{field}}                   the member's answer (blank answers print as ________)
//   {{field | words}}           a number as words: 3 → "three"   ({{field | Words}} → "Three")
//   {{field | upper}} / lower / title
//   {{#field}} … {{/field}}     include only when a yes/no field is yes (or a value is given)
//   {{^field}} … {{/field}}     include only when it is no / empty
// Every template also gets these automatically (no question asked):
//   {{form_label}}  {{unit}} (Town/City)  {{governing_body}}  {{today}}  {{year}}

import { randomBytes } from 'node:crypto';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { kv, blobs } from './storage.mjs';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const DELIMS = { start: '{{', end: '}}' };
const BLANK = '________';
export const VARIANTS = ['all', 'town', 'aldermanic', 'cm', 'strong', 'charter'];
export const VARIANT_LABEL = { all: 'Every form of government', town: 'Statutory Town', aldermanic: 'Aldermanic City', cm: 'Council-Manager City', strong: 'Strong-Mayor-Council City', charter: 'Charter City' };
export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'yesno'];
export const PREFILLS = ['', 'municipality', 'city_name_only', 'governing_body', 'clerk', 'today'];
const FORMS = {
  town: { label: 'Statutory Town', unit: 'Town', body: 'Board of Trustees' },
  aldermanic: { label: 'Aldermanic City', unit: 'City', body: 'City Council' },
  cm: { label: 'Council-Manager City', unit: 'City', body: 'City Council' },
  strong: { label: 'Strong-Mayor-Council City', unit: 'City', body: 'City Council' },
  charter: { label: 'Charter City', unit: 'City', body: 'City Council' }
};
const AUTO = ['form_label', 'unit', 'governing_body', 'today', 'year'];
const KEY = /^[a-z][a-z0-9_]{0,48}$/;

/* ---------- numbers and dates ---------- */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function numberWords(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return '';
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberWords(n % 100) : '');
  return numberWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberWords(n % 1000) : '');
}
const longDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const FILTERS = {
  words: (v) => numberWords(v),
  Words: (v) => cap(numberWords(v)),
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  title: (v) => String(v).replace(/\b\w/g, (c) => c.toUpperCase())
};

/* ---------- reading a template file ---------- */
/** Field names used in a .docx, and which ones open {{#sections}}. Throws a readable error if the file is broken. */
export function inspectDocx(buf) {
  let zip;
  try { zip = new PizZip(buf); } catch { throw err('That isn’t a Word (.docx) file.'); }
  if (!zip.file('word/document.xml')) throw err('That isn’t a Word (.docx) file.');
  const tags = new Set();
  try {
    new Docxtemplater(zip, { delimiters: DELIMS, paragraphLoop: true, linebreaks: true, parser: (t) => { tags.add(t.trim()); return { get: () => '' }; } });
  } catch (e) {
    const first = e.properties?.errors?.[0]?.properties;
    const where = first?.xtag ? ` near “{{${first.xtag}}}”` : '';
    throw err(`The template has a field that isn’t written correctly${where}. Check that every {{ has a matching }} and every {{#section}} has a {{/section}}.`);
  }
  const xml = Object.keys(zip.files).filter((f) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f)).map((f) => zip.file(f).asText().replace(/<[^>]+>/g, '')).join(' ');
  const sections = new Set([...xml.matchAll(/\{\{\s*[#^]\s*([a-z][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1]));
  const names = new Set();
  for (const t of tags) {
    const name = t.split('|')[0].trim();
    if (name && name !== '.') names.add(name);
  }
  const bad = [...names].filter((n) => !KEY.test(n));
  if (bad.length) throw err(`Field names can only use lowercase letters, numbers and underscores (e.g. {{pay_period}}). Fix: ${bad.slice(0, 5).map((b) => `{{${b}}}`).join(', ')}`);
  const unknownFilters = [...tags].flatMap((t) => t.split('|').slice(1).map((f) => f.trim())).filter((f) => f && !FILTERS[f]);
  if (unknownFilters.length) throw err(`Unknown option “| ${unknownFilters[0]}”. You can use | words, | Words, | upper, | lower or | title.`);
  return { tags: [...names].filter((n) => !AUTO.includes(n)).sort(), sections: [...sections] };
}

/* ---------- filling ---------- */
function formatValue(field, v) {
  if (v === undefined || v === null || v === '') return undefined;
  switch (field?.type) {
    case 'number': return Number.isFinite(Number(v)) ? String(Number(v)) : undefined;
    case 'yesno': return v === true || v === 'yes' || v === 'true';
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? longDate(`${v}T12:00:00`) : String(v);
    case 'select': {
      const o = (field.options || []).find((x) => x.value === v);
      return o ? (o.text || o.label || o.value) : undefined;
    }
    default: return String(v);
  }
}

/** Fills a template file. Returns the .docx as a Buffer. */
export function fillDocx(buf, { fields = [], values = {}, form = 'town' }) {
  const f = FORMS[form] || FORMS.town;
  const byKey = Object.fromEntries(fields.map((x) => [x.key, x]));
  const data = {
    form_label: f.label, unit: f.unit, governing_body: f.body,
    today: longDate(Date.now()), year: String(new Date().getFullYear())
  };
  for (const [k, v] of Object.entries(values || {})) {
    if (!KEY.test(k) || AUTO.includes(k)) continue;
    const out = formatValue(byKey[k], v);
    if (out !== undefined) data[k] = out;
  }
  const doc = new Docxtemplater(new PizZip(buf), {
    delimiters: DELIMS, paragraphLoop: true, linebreaks: true,
    parser: (tag) => {
      const [name, ...filters] = tag.split('|').map((s) => s.trim());
      return {
        get(scope) {
          let v = name === '.' ? scope : scope[name];
          if (v === undefined || v === null || v === '') return undefined;
          if (typeof v === 'boolean') return v;
          for (const fl of filters) if (FILTERS[fl]) v = FILTERS[fl](v);
          return v;
        }
      };
    },
    nullGetter: (part) => (part.module ? '' : BLANK)
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ---------- storage ---------- */
const slug = (s) => String(s || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'template';

export async function listTemplates() {
  const all = await kv.query('TEMPLATE');
  return all.map(strip).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
}
const strip = ({ pk, sk, ...t }) => t;
export async function getTemplate(id) {
  const t = await kv.get('TEMPLATE', id);
  if (!t) throw err('Template not found.', 404);
  return strip(t);
}

export async function createTemplate({ title, description }, by) {
  title = String(title || '').trim().slice(0, 120);
  if (!title) throw err('Give the template a title.');
  const id = `${slug(title)}-${randomBytes(2).toString('hex')}`;
  const t = { id, title, description: String(description || '').trim().slice(0, 400), enabled: false, order: 99, fields: [], notes: [], variants: {}, updatedAt: new Date().toISOString(), updatedBy: by };
  await kv.put({ pk: 'TEMPLATE', sk: id, ...t });
  return t;
}

function cleanField(f, existingKeys) {
  const key = String(f.key || '').trim();
  if (!KEY.test(key)) throw err(`“${key}” isn’t a valid field name.`);
  if (existingKeys.has(key)) throw err(`The field “${key}” is listed twice.`);
  existingKeys.add(key);
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
  const out = {
    key, type,
    label: String(f.label || key.replace(/_/g, ' ')).trim().slice(0, 160),
    help: String(f.help || '').trim().slice(0, 1200),
    required: !!f.required,
    group: String(f.group || '').trim().slice(0, 60),
    prefill: PREFILLS.includes(f.prefill) ? f.prefill : ''
  };
  if (f.default !== undefined && f.default !== null && f.default !== '') out.default = type === 'number' ? Number(f.default) : type === 'yesno' ? !!f.default : String(f.default).slice(0, 500);
  if (type === 'select') {
    out.options = (Array.isArray(f.options) ? f.options : []).map((o) => ({
      value: String(o.value || o.label || '').trim().slice(0, 60),
      label: String(o.label || o.value || '').trim().slice(0, 160),
      ...(o.text ? { text: String(o.text).slice(0, 1500) } : {})
    })).filter((o) => o.value);
    if (!out.options.length) throw err(`The choice field “${out.label}” needs at least one option.`);
  }
  return out;
}

export async function updateTemplate(id, input, by) {
  const t = await getTemplate(id);
  const next = { ...t };
  if ('title' in input) { next.title = String(input.title || '').trim().slice(0, 120); if (!next.title) throw err('Give the template a title.'); }
  if ('description' in input) next.description = String(input.description || '').trim().slice(0, 400);
  if ('order' in input) next.order = Math.max(0, Math.min(99, Number(input.order) || 0));
  if ('notes' in input) next.notes = (Array.isArray(input.notes) ? input.notes : []).map((n) => String(n).trim().slice(0, 1200)).filter(Boolean).slice(0, 20);
  if ('fields' in input) {
    const seen = new Set();
    next.fields = (Array.isArray(input.fields) ? input.fields : []).map((f) => cleanField(f, seen)).slice(0, 80);
  }
  if ('enabled' in input) {
    next.enabled = !!input.enabled;
    if (next.enabled && !Object.keys(next.variants).length) throw err('Upload a Word file before turning the template on.');
  }
  next.updatedAt = new Date().toISOString(); next.updatedBy = by;
  await kv.put({ pk: 'TEMPLATE', sk: id, ...next });
  return next;
}

export async function deleteTemplate(id) {
  const t = await getTemplate(id);
  await Promise.all(Object.values(t.variants).map((v) => blobs.del(v.key)));
  await kv.del('TEMPLATE', id);
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Step 1 of uploading a Word file: returns a URL to PUT the file to. */
export async function variantUploadUrl(id, { variant, filename, size }) {
  await getTemplate(id);
  if (!VARIANTS.includes(variant)) throw err('Choose which form of government this file is for.');
  if (!/\.docx$/i.test(String(filename || ''))) throw err(/\.doc$/i.test(String(filename || '')) ? 'Save it as a .docx first (in Word: File → Save As → Word Document).' : 'Upload a Word (.docx) file.');
  if (!(size > 0) || size > 10 * 1024 * 1024) throw err('Word files must be under 10 MB.');
  const key = `templates/${id}/${variant}-${Date.now()}.docx`;
  return { key, uploadUrl: await blobs.uploadUrl(key, DOCX), contentType: DOCX };
}

/** Step 2: reads the uploaded file, records its fields, and adds a question for each new one. */
export async function attachVariant(id, { variant, key, filename }, by) {
  const t = await getTemplate(id);
  if (!VARIANTS.includes(variant) || !String(key || '').startsWith(`templates/${id}/`)) throw err('Upload not found.', 404);
  const buf = await blobs.get(key);
  if (!buf) throw err('The upload didn’t arrive. Try again.', 404);
  let info;
  try { info = inspectDocx(buf); } catch (e) { await blobs.del(key); throw e; }
  const old = t.variants[variant];
  t.variants[variant] = { key, filename: String(filename || 'template.docx').slice(0, 200), size: buf.length, tags: info.tags, sections: info.sections, uploadedAt: new Date().toISOString(), uploadedBy: by };
  if (old && old.key !== key) await blobs.del(old.key);
  const known = new Set(t.fields.map((f) => f.key));
  const added = info.tags.filter((k) => !known.has(k));
  for (const k of added) t.fields.push({ key: k, type: info.sections.includes(k) ? 'yesno' : 'text', label: cap(k.replace(/_/g, ' ')), help: '', required: false, group: '', prefill: '' });
  t.updatedAt = new Date().toISOString(); t.updatedBy = by;
  await kv.put({ pk: 'TEMPLATE', sk: id, ...t });
  return { template: t, added, tags: info.tags };
}

export async function removeVariant(id, variant) {
  const t = await getTemplate(id);
  const v = t.variants[variant];
  if (!v) throw err('That file isn’t attached.', 404);
  await blobs.del(v.key);
  delete t.variants[variant];
  if (!Object.keys(t.variants).length) t.enabled = false;
  await kv.put({ pk: 'TEMPLATE', sk: id, ...t });
  return t;
}

/** Which file a member with this form of government gets. Charter cities fall back to the Council-Manager file. */
export function pickVariant(t, form) {
  if (t.variants[form]) return { variant: form, fallback: false };
  if (t.variants.all) return { variant: 'all', fallback: false };
  if (form === 'charter' && t.variants.cm) return { variant: 'cm', fallback: true };
  return null;
}

/** What the member page needs: enabled templates that have a file for this form, with only the questions that file uses. */
export async function memberTemplates(form) {
  const out = [];
  for (const t of await listTemplates()) {
    if (!t.enabled) continue;
    const pick = pickVariant(t, form);
    if (!pick) continue;
    const used = new Set(t.variants[pick.variant].tags);
    out.push({
      id: t.id, title: t.title, description: t.description, notes: t.notes,
      variant: pick.variant, fallback: pick.fallback ? `OMAG doesn’t have a Charter City version, so this uses the ${VARIANT_LABEL.cm} template. Check it against your charter.` : null,
      fields: t.fields.filter((f) => used.has(f.key))
    });
  }
  return out;
}

/** Fills a template for a member. Returns { filename, data (Buffer), blanks: [labels left empty] }. */
export async function fillTemplate(id, { form, values, municipality }, { allowDisabled = false } = {}) {
  const t = await getTemplate(id);
  if (!t.enabled && !allowDisabled) throw err('That document isn’t available right now.', 404);
  const pick = pickVariant(t, FORMS[form] ? form : 'town');
  if (!pick) throw err('This document isn’t available for your form of government.', 404);
  const v = t.variants[pick.variant];
  const buf = await blobs.get(v.key);
  if (!buf) throw err('The template file is missing. Please let OMAG know.', 500);
  const used = new Set(v.tags);
  const fields = t.fields.filter((f) => used.has(f.key));
  const clean = {};
  for (const f of fields) {
    let x = values?.[f.key];
    if (typeof x === 'string') x = x.slice(0, f.type === 'textarea' ? 4000 : 500);
    clean[f.key] = x;
  }
  let data;
  try { data = fillDocx(buf, { fields, values: clean, form }); } catch (e) {
    console.error('fill failed', id, e);
    throw err('Pip couldn’t build that document. Please let OMAG know.', 500);
  }
  const blanks = fields.filter((f) => f.type !== 'yesno' && (clean[f.key] === undefined || clean[f.key] === null || String(clean[f.key]).trim() === '')).map((f) => f.label);
  const who = String(municipality || '').replace(/[^\w .,'&-]+/g, '').trim().slice(0, 60);
  const filename = `${t.title}${who ? ` - ${who}` : ''}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
  return { filename, data, blanks, variant: pick.variant };
}

/* ---------- template packs (import / export as one .zip) ---------- */
export async function exportPack() {
  const zip = new PizZip();
  const manifest = { format: 'pip-templates', version: 1, exportedAt: new Date().toISOString(), templates: [] };
  for (const t of await listTemplates()) {
    const entry = { ...t, variants: {} };
    delete entry.updatedBy;
    for (const [name, v] of Object.entries(t.variants)) {
      const buf = await blobs.get(v.key);
      if (!buf) continue;
      const file = `${t.id}/${name}.docx`;
      zip.file(file, buf);
      entry.variants[name] = { file, filename: v.filename };
    }
    manifest.templates.push(entry);
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Adds or replaces templates from a pack. Templates with the same id are replaced. */
export async function importPack(buf, by) {
  let zip, manifest;
  try { zip = new PizZip(buf); manifest = JSON.parse(zip.file('manifest.json').asText()); } catch { throw err('That isn’t a Pip template pack (.zip with a manifest.json).'); }
  if (manifest.format !== 'pip-templates' || !Array.isArray(manifest.templates)) throw err('That isn’t a Pip template pack.');
  const done = [];
  for (const src of manifest.templates) {
    const id = /^[a-z0-9-]{3,60}$/.test(src.id || '') ? src.id : `${slug(src.title)}-${randomBytes(2).toString('hex')}`;
    const existing = await kv.get('TEMPLATE', id);
    if (existing) await deleteTemplate(id);
    const seen = new Set();
    const t = {
      id, title: String(src.title || id).slice(0, 120), description: String(src.description || '').slice(0, 400),
      enabled: !!src.enabled, order: Number(src.order ?? 99), notes: (src.notes || []).map(String).slice(0, 20),
      fields: (src.fields || []).map((f) => cleanField(f, seen)), variants: {}, updatedAt: new Date().toISOString(), updatedBy: by
    };
    for (const [name, v] of Object.entries(src.variants || {})) {
      if (!VARIANTS.includes(name)) continue;
      const file = zip.file(v.file);
      if (!file) throw err(`The pack is missing ${v.file}.`);
      const fbuf = Buffer.from(file.asUint8Array());
      const info = inspectDocx(fbuf);
      const key = `templates/${id}/${name}-${Date.now()}.docx`;
      await blobs.put(key, fbuf, DOCX);
      t.variants[name] = { key, filename: v.filename || `${name}.docx`, size: fbuf.length, tags: info.tags, sections: info.sections, uploadedAt: t.updatedAt, uploadedBy: by };
      for (const k of info.tags) if (!seen.has(k)) { seen.add(k); t.fields.push({ key: k, type: info.sections.includes(k) ? 'yesno' : 'text', label: cap(k.replace(/_/g, ' ')), help: '', required: false, group: '', prefill: '' }); }
    }
    if (!Object.keys(t.variants).length) t.enabled = false;
    await kv.put({ pk: 'TEMPLATE', sk: id, ...t });
    done.push({ id, title: t.title, files: Object.keys(t.variants).length });
  }
  return done;
}

export async function importUploadUrl() {
  const key = `imports/${Date.now()}-${randomBytes(3).toString('hex')}.zip`;
  return { key, uploadUrl: await blobs.uploadUrl(key, 'application/zip'), contentType: 'application/zip' };
}
