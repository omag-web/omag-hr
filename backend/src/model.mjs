// Model access. Real mode streams from Amazon Bedrock's Converse API (works with
// Claude and OpenAI models on Bedrock). Mock mode is a scripted stand-in used by
// tests and `npm run dev:mock`, so the whole app can run without AWS.

import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';

let client;

/**
 * Streams one model turn. Calls onText(delta) for text as it arrives and
 * resolves with { content, stopReason, usage } where content is the assistant
 * message content (text + toolUse blocks) in Converse format.
 */
export async function converseTurn({ system, messages, tools, onText, modelId = process.env.MODEL_ID, maxTokens = 2000 }) {
  if ((process.env.MODEL_MODE || '').toLowerCase() === 'mock') return mockTurn({ messages, onText });

  client ||= new BedrockRuntimeClient({});
  const cmd = new ConverseStreamCommand({
    modelId,
    system: [{ text: system }, { cachePoint: { type: 'default' } }],
    messages,
    toolConfig: { tools },
    inferenceConfig: { maxTokens, temperature: 0.2 }
  });
  const res = await client.send(cmd);

  const content = [];
  let current = null;
  let stopReason = 'end_turn';
  let usage = {};
  for await (const ev of res.stream) {
    if (ev.contentBlockStart?.start?.toolUse) {
      const t = ev.contentBlockStart.start.toolUse;
      current = { toolUse: { toolUseId: t.toolUseId, name: t.name, inputJson: '' } };
      content.push(current);
    } else if (ev.contentBlockDelta?.delta) {
      const d = ev.contentBlockDelta.delta;
      if (typeof d.text === 'string') {
        if (!current || !('text' in current)) { current = { text: '' }; content.push(current); }
        current.text += d.text;
        onText?.(d.text);
      } else if (d.toolUse) {
        current.toolUse.inputJson += d.toolUse.input || '';
      }
    } else if (ev.contentBlockStop) {
      current = null;
    } else if (ev.messageStop) {
      stopReason = ev.messageStop.stopReason;
    } else if (ev.metadata) {
      usage = ev.metadata.usage || {};
    }
  }
  for (const b of content) {
    if (b.toolUse) {
      try { b.toolUse.input = b.toolUse.inputJson ? JSON.parse(b.toolUse.inputJson) : {}; } catch { b.toolUse.input = {}; }
      delete b.toolUse.inputJson;
    }
  }
  return { content: content.filter((b) => b.toolUse || b.text), stopReason, usage };
}

/* ---------------- mock model ----------------
 * Turn 1: search the library with the user's question.
 * Turn 2: read the top two results.
 * Turn 3: write an answer citing them.
 */
async function mockTurn({ messages, onText }) {
  const last = messages[messages.length - 1];
  const toolResults = (last.content || []).filter((b) => b.toolResult);
  const userText = [...messages].reverse().find((m) => m.role === 'user' && m.content.some((b) => b.text))?.content.find((b) => b.text)?.text || '';
  const usage = { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0 };

  if (!toolResults.length) {
    return { stopReason: 'tool_use', usage, content: [{ toolUse: { toolUseId: 'mock-1', name: 'search_law', input: { query: userText } } }] };
  }
  const payload = toolResults[0].toolResult.content[0].json;
  if (Array.isArray(payload.results)) {
    if (!payload.results.length) {
      const text = `**Mock answer.** I couldn't find anything in the library for that. Try asking about FMLA eligibility or a mayor's authority.`;
      onText?.(text);
      return { stopReason: 'end_turn', usage, content: [{ text }] };
    }
    const ids = payload.results.slice(0, 2).map((h) => h.id);
    return { stopReason: 'tool_use', usage, content: [{ toolUse: { toolUseId: 'mock-2', name: 'get_sections', input: { ids } } }] };
  }
  const secs = payload.sections || [];
  const text = secs.length
    ? `**Mock answer** (no model connected). Here is what the library says:\n\n${secs.map((s, i) => `${i + 1}. **${s.heading}.** ${s.text.slice(0, 160).replace(/\s+/g, ' ')}… [[${s.id}]]`).join('\n')}\n\nConfirm with your municipal attorney or OMAG Legal Services before acting.`
    : `**Mock answer.** I couldn't find anything in the library for that. Try asking about FMLA eligibility or a mayor's authority.`;
  for (const chunk of text.match(/.{1,24}/gs)) { onText?.(chunk); await new Promise((r) => setTimeout(r, 8)); }
  return { stopReason: 'end_turn', usage, content: [{ text }] };
}
