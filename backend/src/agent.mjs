// One chat turn: research with tools, then stream the answer.

import { converseTurn } from './model.mjs';
import { TOOL_SPECS, runTool } from './tools.mjs';
import { buildSystemPrompt, FORMS } from './prompt.mjs';

const MAX_TOOL_ROUNDS = 6;
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
export async function runAgent({ history, form, city, library, emit = () => {}, turn = converseTurn, guidance, modelId }) {
  const system = buildSystemPrompt({ form: FORMS[form] ? form : undefined, city, guidance, omagDocs: library.omagTitles || [] });
  const messages = toConverseMessages(history);
  const seen = new Set();          // section ids the model has read this turn
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const toolCalls = [];
  let finalText = '';

  // Sections cited earlier in the conversation stay citable.
  for (const m of history) if (m.role === 'assistant') markerIds(m.text).forEach((id) => library.get(id) && seen.add(library.normalizeId(id)));

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    let turnText = '';
    const res = await turn({
      system,
      modelId,
      messages,
      tools: TOOL_SPECS,
      onText: (d) => { turnText += d; emit({ type: 'text', text: d }); }
    });
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
      const r = runTool(toolUse.name, toolUse.input, library);
      r.ids.forEach((id) => seen.add(id));
      toolCalls.push({ name: toolUse.name, input: toolUse.input });
      emit({ type: 'status', text: r.status });
      results.push({ toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: r.result }] } });
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
  return { text: finalText, citations, unread, usage, toolCalls };
}
