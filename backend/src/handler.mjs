// Lambda entry point (Function URL with response streaming).
//
// Public
//   GET  /health                 → status and library info
//   GET  /config                 → member-facing settings (welcome text, starters, disclaimer)
//   GET  /auth-config            → Cognito ids for the admin sign-in page
//   GET  /source?id=11-12-106    → one section's full text (for citation chips)
//   POST /chat                   → streams NDJSON events: status | text | reset | done | error
//   POST /feedback               → thumbs up/down on an answer
//   POST /contact                → "Talk to OMAG" message
// Admin (signed in; see admin.mjs)
//   /admin/*                     → instructions, documents, settings, conversations, library
//   POST /admin/preview          → like /chat, but with the draft instructions
// Scheduled
//   { pipTask: "refresh-library" } from EventBridge → pull the latest statute library and re-read OMAG websites
//
// CORS is handled by the Function URL configuration in template.yaml.

import { getLibrary, refreshLibrary } from './library.mjs';
import { runAgent } from './agent.mjs';
import { getConfig, publicSettings } from './config.mjs';
import { kv } from './storage.mjs';
import { requireAdmin, authConfig } from './auth.mjs';
import { matchAdmin } from './admin.mjs';
import { refreshWebsites } from './docs.mjs';
import { checkRateLimit, logTurn, newTurnId, saveFeedback, saveContact } from './store.mjs';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  if (event?.pipTask === 'refresh-library') {
    const result = await refreshLibrary();
    console.log('scheduled library refresh', result);
    const sites = await refreshWebsites().catch((e) => { console.error('website refresh failed', e); return []; });
    if (sites.length) console.log('scheduled website refresh', sites);
    stream.write(JSON.stringify(result));
    stream.end();
    return;
  }
  const method = event.requestContext?.http?.method || 'GET';
  const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
  const ip = event.requestContext?.http?.sourceIp || '';
  try {
    if (method === 'GET' && path === '/health') return json(stream, 200, await health());
    if (method === 'GET' && path === '/config') return json(stream, 200, publicSettings((await getConfig()).settings), { 'Cache-Control': 'public, max-age=60' });
    if (method === 'GET' && path === '/auth-config') return json(stream, 200, authConfig());
    if (method === 'GET' && path === '/source') return source(stream, event.queryStringParameters?.id);
    if (method === 'POST' && path === '/chat') return chat(stream, parse(event), ip);
    if (method === 'POST' && path === '/feedback') return feedback(stream, parse(event));
    if (method === 'POST' && path === '/contact') return contact(stream, parse(event), ip);
    if (path.startsWith('/admin/')) {
      const admin = await requireAdmin(event);
      if (method === 'POST' && path === '/admin/preview') return chat(stream, parse(event), ip, { admin });
      const route = matchAdmin(method, path);
      if (!route) return json(stream, 404, { error: 'Not found' });
      const body = method === 'GET' ? {} : parse(event);
      const result = await route.fn({ admin, params: route.params, body, query: event.queryStringParameters || {} });
      return json(stream, 200, result ?? { ok: true });
    }
    return json(stream, 404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    return json(stream, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
  }
});

function parse(event) {
  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  if (body.length > 200_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function json(stream, statusCode, obj, headers = {}) {
  const s = awslambda.HttpResponseStream.from(stream, { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
  s.write(JSON.stringify(obj));
  s.end();
}

async function health() {
  const [lib, cfg] = await Promise.all([getLibrary(), getConfig()]);
  return {
    ok: true,
    model: process.env.MODEL_MODE === 'mock' ? 'mock' : cfg.settings.modelId,
    library: { sections: lib.sections.length, statutes: lib.statuteCount, omag: lib.sections.length - lib.statuteCount, builtAt: lib.builtAt, origin: lib.origin }
  };
}

async function source(stream, id) {
  const s = id && (await getLibrary()).get(String(id).slice(0, 60));
  if (!s) return json(stream, 404, { error: 'Section not found' });
  return json(stream, 200, { id: s.id, cite: s.cite, heading: s.heading, source: s.source, url: s.url, text: s.text, history: s.history }, { 'Cache-Control': 'public, max-age=300' });
}

/** Member chat, or (with opts.admin) an admin preview using the draft instructions. */
async function chat(stream, body, ip, opts = {}) {
  const { conversationId, browserId, city, form, messages } = body;
  if (!ID.test(String(conversationId || ''))) return json(stream, 400, { error: 'conversationId required' });
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) return json(stream, 400, { error: 'messages required' });
  const question = String(messages[messages.length - 1]?.text || '');
  if (!question.trim() || question.length > 4000) return json(stream, 400, { error: 'Question must be 1–4,000 characters.' });

  const cfg = await getConfig();
  let guidance = cfg.guidance;
  if (opts.admin) {
    if (typeof body.guidance === 'string' && body.guidance.trim()) guidance = body.guidance.slice(0, 20000);
    else if (body.useDraft !== false) guidance = (await kv.get('CONFIG', 'guidance#draft'))?.text ?? guidance;
  } else {
    const limit = await checkRateLimit(ip, { perIp: cfg.settings.dailyLimitPerIp, global: cfg.settings.dailyLimitGlobal });
    if (!limit.ok) return json(stream, 429, { error: limit.reason });
  }

  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
  });
  const emit = (ev) => out.write(JSON.stringify(ev) + '\n');
  const turnId = newTurnId();
  const started = Date.now();
  const modelId = cfg.settings.modelId;
  let result = null;
  let error = null;
  try {
    emit({ type: 'status', text: 'Reading your question' });
    result = await runAgent({
      history: messages, form, city: city ? String(city).slice(0, 120) : undefined,
      library: await getLibrary(), emit, guidance, modelId
    });
    emit({ type: 'done', turnId, citations: result.citations, unread: result.unread });
  } catch (e) {
    console.error('chat failed', e);
    error = e.name || 'Error';
    emit({ type: 'error', message: friendlyError(e) });
  }
  try {
    await logTurn({
      conversationId, turnId, browserId, ip, city, form, question,
      answer: result?.text, citations: result?.citations, unread: result?.unread,
      usage: result?.usage, toolCalls: result?.toolCalls, latencyMs: Date.now() - started,
      model: process.env.MODEL_MODE === 'mock' ? 'mock' : modelId, error, preview: !!opts.admin
    });
  } catch (e) { console.error('log failed', e); }
  out.end();
}

function friendlyError(e) {
  if (/Throttling|TooManyRequests/i.test(e.name || '')) return 'Pip is busy right now. Please try again in a minute.';
  if (/AccessDenied/i.test(e.name || '')) return 'Pip is not connected to its AI model yet (model access). Please let OMAG know.';
  if (/messages|last message/.test(e.message || '')) return e.message;
  return 'Something went wrong while answering. Please try again.';
}

async function feedback(stream, body) {
  const { conversationId, turnId, rating, note } = body;
  if (!ID.test(String(conversationId || '')) || !/^TURN#/.test(String(turnId || '')) || !['up', 'down'].includes(rating)) return json(stream, 400, { error: 'Invalid feedback' });
  const ok = await saveFeedback({ conversationId, turnId, rating, note });
  return json(stream, ok ? 200 : 404, { ok });
}

async function contact(stream, body, ip) {
  const { conversationId, city, form, note, transcript } = body;
  if (!String(note || '').trim() && !String(transcript || '').trim()) return json(stream, 400, { error: 'Add a note' });
  await saveContact({ conversationId, city, form, note, transcript, ip });
  return json(stream, 200, { ok: true });
}
