// Lambda entry point (Function URL with response streaming).
//
//   GET  /health                 → library info
//   GET  /source?id=11-12-106    → one section's full text (for citation chips)
//   POST /chat                   → streams NDJSON events: status | text | reset | done | error
//   POST /feedback               → thumbs up/down on an answer
//   POST /contact                → "Talk to OMAG" message
//
// CORS is handled by the Function URL configuration in template.yaml.

import { getLibrary } from './library.mjs';
import { runAgent } from './agent.mjs';
import { checkRateLimit, logTurn, newTurnId, saveFeedback, saveContact } from './store.mjs';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  const method = event.requestContext?.http?.method || 'GET';
  const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
  const ip = event.requestContext?.http?.sourceIp || '';
  try {
    if (method === 'GET' && path === '/health') return json(stream, 200, health());
    if (method === 'GET' && path === '/source') return source(stream, event.queryStringParameters?.id);
    if (method === 'POST' && path === '/chat') return chat(stream, parse(event), ip);
    if (method === 'POST' && path === '/feedback') return feedback(stream, parse(event));
    if (method === 'POST' && path === '/contact') return contact(stream, parse(event), ip);
    return json(stream, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(stream, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
  }
});

function parse(event) {
  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  if (body.length > 200_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function json(stream, statusCode, obj) {
  const s = awslambda.HttpResponseStream.from(stream, { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  s.write(JSON.stringify(obj));
  s.end();
}

function health() {
  const lib = getLibrary();
  return { ok: true, model: process.env.MODEL_MODE === 'mock' ? 'mock' : process.env.MODEL_ID, library: { sections: lib.sections.length, builtAt: lib.builtAt } };
}

function source(stream, id) {
  const s = id && getLibrary().get(String(id).slice(0, 60));
  if (!s) return json(stream, 404, { error: 'Section not found' });
  const res = awslambda.HttpResponseStream.from(stream, { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } });
  res.write(JSON.stringify({ id: s.id, cite: s.cite, heading: s.heading, source: s.source, url: s.url, text: s.text, history: s.history }));
  res.end();
}

async function chat(stream, body, ip) {
  const { conversationId, browserId, city, form, messages } = body;
  if (!ID.test(String(conversationId || ''))) return json(stream, 400, { error: 'conversationId required' });
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) return json(stream, 400, { error: 'messages required' });
  const question = String(messages[messages.length - 1]?.text || '');
  if (!question.trim() || question.length > 4000) return json(stream, 400, { error: 'Question must be 1–4,000 characters.' });

  const limit = await checkRateLimit(ip);
  if (!limit.ok) return json(stream, 429, { error: limit.reason });

  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
  });
  const emit = (ev) => out.write(JSON.stringify(ev) + '\n');
  const turnId = newTurnId();
  const started = Date.now();
  let result = null;
  let error = null;
  try {
    emit({ type: 'status', text: 'Reading your question' });
    result = await runAgent({ history: messages, form, city: city ? String(city).slice(0, 120) : undefined, library: getLibrary(), emit });
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
      model: process.env.MODEL_MODE === 'mock' ? 'mock' : process.env.MODEL_ID, error
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
