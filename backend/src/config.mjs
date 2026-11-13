// Everything an admin can change without a deploy: OMAG's guidance for Pip
// (draft → publish, with history), member-facing settings, and version counters
// that tell every running Lambda when the library or documents changed.
//
// Stored under pk "CONFIG":
//   sk guidance#live        { text, publishedAt, publishedBy, note }
//   sk guidance#draft       { text, updatedAt, updatedBy }
//   sk guidance#hist#<iso>  { text, publishedAt, publishedBy, note }
//   sk settings             { ...settings, updatedAt, updatedBy }
//   sk versions             { library, docs }

import { kv } from './storage.mjs';
import { DEFAULT_GUIDANCE } from './prompt.mjs';

export const MODELS = {
  'us.openai.gpt-5.6-terra': 'GPT-5.6 Terra (recommended: balanced)',
  'us.openai.gpt-5.6-sol': 'GPT-5.6 Sol (strongest, costs more)',
  'us.openai.gpt-5.6-luna': 'GPT-5.6 Luna (fastest, cheapest)'
};

/** The privacy notice members see. {retention} and {phone} are filled in when it's shown. */
export const DEFAULT_PRIVACY_NOTICE = `## What Pip is
Pip is an AI assistant that OMAG provides to its member municipalities. Its answers are general information, not legal advice.

## What we keep
- The questions you ask, Pip's answers, and any rating or comment you leave.
- The form of government you choose and the municipality name you enter.
- When you build a document: which document and when. Your answers to the document's questions are used to fill in the file and aren't kept.
- To prevent abuse, a scrambled one-way code made from your internet address and browser. It can't be used to tell who you are.

Pip doesn't ask for your name or use accounts.

## How it's used
- Your question goes to an AI model that runs inside OMAG's own Amazon Web Services account (Amazon Bedrock). It isn't sent to OpenAI or any other company, and it isn't used to train AI models.
- Authorized OMAG staff review conversations to check the quality of Pip's answers and improve it.
- If you use "Talk to OMAG", your note and the conversation are sent to OMAG staff so they can follow up.

## How long we keep it
Saved conversations are deleted automatically after {retention}.

## Personal details
Please don't include names, Social Security or other ID numbers, birth dates or medical details. Pip removes ID numbers, account numbers and birth dates automatically before your message is saved or sent to the AI.

## On this device
Your recent conversations are also stored in this browser so you can come back to them. You can clear them below; that doesn't delete the copies OMAG keeps.

## Questions
Call OMAG at {phone}.`;

export function defaultSettings() {
  return {
    welcomeText: "I'm OMAG's AI assistant for municipal HR. Ask about Oklahoma statutes and federal employment law for your form of government, or have me draft a document from OMAG's templates using your town's details.",
    starters: [
      { kicker: 'Authority', text: 'Does our town clerk have hiring authority?' },
      { kicker: 'Leave', text: 'Is our handbook FMLA compliant?' },
      { kicker: 'Discipline', text: 'Can the mayor suspend an employee unilaterally?' },
      { kicker: 'Create a document', text: 'Build our personnel policies handbook', doc: true }
    ],
    privacyNotice: '',
    disclaimer: 'Answers are general information, not legal advice. For your specific situation, consult your municipal attorney or OMAG Legal Services.',
    contactPhone: '1-800-234-9461',
    dailyLimitPerIp: Number(process.env.DAILY_LIMIT_PER_IP || 60),
    dailyLimitGlobal: Number(process.env.DAILY_LIMIT_GLOBAL || 600),
    modelId: process.env.MODEL_ID || 'us.openai.gpt-5.6-terra',
    // Used automatically for one answer if the main model is busy, down or retired. '' = no backup.
    fallbackModelId: process.env.FALLBACK_MODEL_ID ?? 'us.openai.gpt-5.6-luna',
    // Bedrock price in US dollars per million tokens, for the cost estimate on the Analytics page.
    // 0 means "not set": the page shows token counts only.
    priceInputPerM: 0,
    priceOutputPerM: 0
  };
}

const TTL_MS = 30_000;
let cache = null;

/** The live configuration, cached briefly. */
export async function getConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [live, settings, versions] = await Promise.all([
    kv.get('CONFIG', 'guidance#live'),
    kv.get('CONFIG', 'settings'),
    kv.get('CONFIG', 'versions')
  ]);
  const value = {
    guidance: live?.text ?? DEFAULT_GUIDANCE,
    guidanceMeta: live ? { publishedAt: live.publishedAt, publishedBy: live.publishedBy, note: live.note } : { default: true },
    settings: { ...defaultSettings(), ...(settings ? stripMeta(settings) : {}) },
    versions: { library: versions?.library || 0, docs: versions?.docs || 0 }
  };
  cache = { at: Date.now(), value };
  return value;
}
export function invalidateConfig() { cache = null; }

const stripMeta = ({ pk, sk, updatedAt, updatedBy, ...rest }) => rest;

/* ---------- guidance ---------- */
export async function getGuidanceState() {
  const [live, draft, hist] = await Promise.all([
    kv.get('CONFIG', 'guidance#live'),
    kv.get('CONFIG', 'guidance#draft'),
    kv.query('CONFIG', { prefix: 'guidance#hist#', limit: 30 })
  ]);
  const liveText = live?.text ?? DEFAULT_GUIDANCE;
  return {
    live: { text: liveText, publishedAt: live?.publishedAt, publishedBy: live?.publishedBy, note: live?.note, isDefault: !live },
    draft: draft ? { text: draft.text, updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, differs: draft.text !== liveText } : null,
    history: hist.map((h) => ({ id: h.sk.slice('guidance#hist#'.length), publishedAt: h.publishedAt, publishedBy: h.publishedBy, note: h.note, chars: h.text.length })),
    defaultText: DEFAULT_GUIDANCE
  };
}

export function validateGuidance(text) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('Guidance can’t be empty.'), { status: 400 });
  if (text.length > 20000) throw Object.assign(new Error('Guidance is too long (20,000 characters max).'), { status: 400 });
  return text.replace(/\r/g, '');
}

export async function saveDraft(text, by) {
  text = validateGuidance(text);
  await kv.put({ pk: 'CONFIG', sk: 'guidance#draft', text, updatedAt: new Date().toISOString(), updatedBy: by });
}

export async function discardDraft() { await kv.del('CONFIG', 'guidance#draft'); }

export async function publishDraft(by, note) {
  const draft = await kv.get('CONFIG', 'guidance#draft');
  if (!draft) throw Object.assign(new Error('There is no draft to publish.'), { status: 400 });
  const now = new Date().toISOString();
  const rec = { text: draft.text, publishedAt: now, publishedBy: by, note: note ? String(note).slice(0, 300) : undefined };
  await kv.put({ pk: 'CONFIG', sk: 'guidance#live', ...rec });
  await kv.put({ pk: 'CONFIG', sk: `guidance#hist#${now}`, ...rec });
  await kv.del('CONFIG', 'guidance#draft');
  invalidateConfig();
}

/** Loads a past version (or the original default) into the draft for review before republishing. */
export async function restoreToDraft(id, by) {
  let text;
  if (id === 'default') text = DEFAULT_GUIDANCE;
  else {
    const h = await kv.get('CONFIG', `guidance#hist#${id}`);
    if (!h) throw Object.assign(new Error('Version not found.'), { status: 404 });
    text = h.text;
  }
  await saveDraft(text, by);
}

/* ---------- settings ---------- */
export async function saveSettings(input, by) {
  const cur = (await getConfig({ fresh: true })).settings;
  const s = { ...cur };
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  if ('welcomeText' in input) s.welcomeText = str(input.welcomeText, 600);
  if ('disclaimer' in input) s.disclaimer = str(input.disclaimer, 400);
  if ('privacyNotice' in input) {
    const t = String(input.privacyNotice ?? '').trim();
    s.privacyNotice = t === DEFAULT_PRIVACY_NOTICE.trim() ? '' : t.slice(0, 8000);   // '' = use the default
  }
  if ('contactPhone' in input) s.contactPhone = str(input.contactPhone, 40);
  if ('starters' in input) {
    if (!Array.isArray(input.starters)) throw Object.assign(new Error('Starters must be a list.'), { status: 400 });
    s.starters = input.starters
      .map((x) => ({ kicker: str(x.kicker, 30), text: str(x.text, 160), ...(x.doc ? { doc: true } : {}) }))
      .filter((x) => x.text)
      .slice(0, 6);
  }
  for (const k of ['dailyLimitPerIp', 'dailyLimitGlobal']) {
    if (k in input) {
      const n = Math.round(Number(input[k]));
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw Object.assign(new Error(`${k} must be a number between 0 and 100,000.`), { status: 400 });
      s[k] = n;
    }
  }
  for (const k of ['priceInputPerM', 'priceOutputPerM']) {
    if (k in input) {
      const n = Number(input[k] || 0);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw Object.assign(new Error('Prices must be dollars per million tokens, between 0 and 1,000.'), { status: 400 });
      s[k] = Math.round(n * 10000) / 10000;
    }
  }
  if ('modelId' in input) {
    if (!MODELS[input.modelId] && !/^[a-z0-9.:\-]{6,100}$/i.test(String(input.modelId))) throw Object.assign(new Error('Unknown model.'), { status: 400 });
    s.modelId = String(input.modelId);
  }
  if ('fallbackModelId' in input) {
    const v = String(input.fallbackModelId || '');
    if (v && !MODELS[v] && !/^[a-z0-9.:\-]{6,100}$/i.test(v)) throw Object.assign(new Error('Unknown backup model.'), { status: 400 });
    s.fallbackModelId = v;
  }
  await kv.put({ pk: 'CONFIG', sk: 'settings', ...s, updatedAt: new Date().toISOString(), updatedBy: by });
  invalidateConfig();
  return s;
}

/** Public subset for the member-facing page. */
export function publicSettings(settings) {
  const { welcomeText, starters, disclaimer, contactPhone } = settings;
  return {
    welcomeText, starters, disclaimer, contactPhone,
    privacyNotice: settings.privacyNotice || DEFAULT_PRIVACY_NOTICE,
    retentionDays: Number(process.env.RETENTION_DAYS || 730)
  };
}

/* ---------- versions ---------- */
export async function bumpVersion(name) {
  const cur = (await kv.get('CONFIG', 'versions')) || { pk: 'CONFIG', sk: 'versions', library: 0, docs: 0 };
  cur[name] = (cur[name] || 0) + 1;
  await kv.put(cur);
  invalidateConfig();
  return cur[name];
}
