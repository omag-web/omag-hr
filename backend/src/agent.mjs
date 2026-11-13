// One chat turn: research with tools, then stream the answer.

import { converseTurn } from './model.mjs';
import { TOOL_SPECS, OFFER_DOCUMENT_SPEC, runTool } from './tools.mjs';
import { metric } from './metrics.mjs';
import { buildSystemPrompt, FORMS } from './prompt.mjs';

const MAX_TOOL_ROUNDS = 6;
const TIME_BUDGET_MS = 170_000;   // stop researching after ~3 minutes so the answer finishes inside Lambda's 5-minute limit

/** Errors where trying a different model makes sense (throttling, model outages, a retired or unavailable model). */
export function isModelFailure(e) {
  const n = e?.name || '';
  if (/Throttling|TooManyRequests|ServiceUnavailable|ModelNotReady|ModelTimeout|ModelError|InternalServer|ResourceNotFound|ModelStreamError|TimeoutError/.test(n)) return true;
  if (n === 'AccessDeniedException' && /model/i.test(e.message || '')) return true;
  if (n === 'ValidationException' && /model|end of life|not supported|deprecated|inference profile/i.test(e.message || '')) return true;
  return /ECONNRESET|ETIMEDOUT|socket hang up/i.test(e?.code || e?.message || '');
}
const MAX_HISTORY = 16;
const MAX_MSG_CHARS = 6000;

/** Validates and converts the client's [{role, text}] history into Converse messages. */
export function toConverseMessages(history) {
  if (!Array.isArray(history) || !history.length) throw new Error('messages must be a non-empty array');
  const msgs = history
    .slice(-MAX_HISTORY)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, content: [{ text: m.text.slice(0, MAX_MSG_CHARS) }] }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  // Merge consecutive same-role messages (Converse requires alternation).
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content[0].text += '\n\n' + m.content[0].text;
    else out.push(m);
  }
  if (!out.length || out[out.length - 1].role !== 'user') throw new Error('last message must be from the user');
  return out;
}

/** Ids in [[...]] markers. */
export function markerIds(text) {
  return [...String(text).matchAll(/\[\[([^\]\n]{1,40})\]\]/g)].map((m) => m[1].trim());
}

/**
 * Runs the research-and-answer loop.
 * emit(event) receives {type:'status'|'text', ...} as things happen.
 * Returns { text, citations, usage, toolCalls }.
 */
export async function runAgent({ history, form, city, library, emit = () => {}, turn = converseTurn, guidance, modelId, fallbackModelId, templates = [], timeBudgetMs = TIME_BUDGET_MS, now = Date.now }) {
  const started = now();
  let activeModel = modelId;
  let fellBack = false;
  /** One model call; if the main model fails, switch to the backup model for the rest of this answer. */
  const callModel = async (args, onText, onRestart = () => {}) => {
    let streamed = false;
    const wrapped = (d) => { streamed = true; onText(d); };
    try {
      return await turn({ ...args, modelId: activeModel, onText: wrapped });
    } catch (e) {
      if (fellBack || !fallbackModelId || fallbackModelId === activeModel || !isModelFailure(e)) throw e;
      console.warn(`Model ${activeModel} failed (${e.name}: ${e.message}); using backup model ${fallbackModelId}`);
      metric('ModelFallback');
      fellBack = true; activeModel = fallbackModelId;
      if (streamed) { emit({ type: 'reset' }); onRestart(); }
      return await turn({ ...args, modelId: activeModel, onText });
    }
  };
  const system = buildSystemPrompt({ form: FORMS[form] ? form : undefined, city, guidance, omagDocs: library.omagTitles || [], templates });
  const tools = templates.length ? [...TOOL_SPECS, OFFER_DOCUMENT_SPEC] : TOOL_SPECS;
  const offers = [];
  const messages = toConverseMessages(history);
  const seen = new Set();          // section ids the model has read this turn
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const toolCalls = [];
  let finalText = '';

  // Sections cited earlier in the conversation stay citable.
  for (const m of history) if (m.role === 'assistant') markerIds(m.text).forEach((id) => library.get(id) && seen.add(library.normalizeId(id)));

  let outOfTime = false;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS || outOfTime;
    let turnText = '';
    const res = await callModel({ system, messages, tools }, (d) => { turnText += d; emit({ type: 'text', text: d }); }, () => { turnText = ''; });
    for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] || 0;
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter((b) => b.toolUse);
    if (res.stopReason !== 'tool_use' || !uses.length || lastRound) {
      finalText = turnText;
      if (lastRound && uses.length && !turnText) {
        finalText = "I wasn't able to finish researching that. Could you rephrase or narrow the question?";
        emit({ type: 'text', text: finalText });
      }
      break;
    }
    // Text written before a tool call is a preamble; tell the client to clear it.
    if (turnText) emit({ type: 'reset' });

    const results = [];
    for (const { toolUse } of uses) {
      const r = runTool(toolUse.name, toolUse.input, library, { templates, offers });
      r.ids.forEach((id) => seen.add(id));
      toolCalls.push({ name: toolUse.name, input: toolUse.input });
      emit({ type: 'status', text: r.status });
      results.push({ toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: r.result }] } });
    }
    // Running long: tell the model to answer now from what it has read.
    if (!outOfTime && now() - started > timeBudgetMs) {
      outOfTime = true;
      metric('TimeBudgetReached');
      results.push({ text: 'Time is almost up. Write your answer now using only the sections you have already read, and do not call any more tools. If something is still uncertain, say so and suggest the member confirm with OMAG or their municipal attorney.' });
    }
    messages.push({ role: 'user', content: results });
  }

  // Only sections that exist and that the model actually read become citations.
  const citations = [];
  const unread = [];
  for (const raw of new Set(markerIds(finalText))) {
    const s = library.get(raw);
    if (s && seen.has(s.id)) citations.push({ marker: raw, id: s.id, cite: s.cite, heading: s.heading });
    else unread.push(raw);
  }
  // One button per document, last answers win.
  const documents = [...new Map(offers.map((o) => [o.templateId, o])).values()];
  return { text: finalText, citations, unread, usage, toolCalls, documents, model: activeModel, fellBack };
}
