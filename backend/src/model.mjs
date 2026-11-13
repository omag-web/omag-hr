// Model access. Real mode streams from Amazon Bedrock's Converse API. Pip runs on
// OpenAI GPT-5.6 on Bedrock by default; Claude models on Bedrock work too. Mock mode is a scripted stand-in used by
// tests and `npm run dev:mock`, so the whole app can run without AWS.

import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

let client;
let cacheUnsupported = false;   // set if the model rejects prompt-cache breakpoints

/** Which model family a Bedrock model / inference profile id belongs to. */
export function modelFamily(modelId = '') {
  if (/openai\.|gpt/i.test(modelId)) return 'openai';
  if (/anthropic\.|claude/i.test(modelId)) return 'anthropic';
  return 'other';
}

/**
 * The ConverseStream request for a model. GPT-5.x models reason before they
 * answer (reasoning tokens count as output), so they get a bigger token budget
 * and no temperature (reasoning models use their own sampling).
 */
export function buildRequest({ modelId, system, messages, tools, maxTokens }) {
  const family = modelFamily(modelId);
  const inferenceConfig = family === 'anthropic'
    ? { maxTokens: maxTokens || 2000, temperature: 0.2 }
    : { maxTokens: maxTokens || 8000 };
  return {
    modelId,
    system: cacheUnsupported ? [{ text: system }] : [{ text: system }, { cachePoint: { type: 'default' } }],
    messages,
    toolConfig: { tools },
    inferenceConfig
  };
}

/**
 * Streams one model turn. Calls onText(delta) for text as it arrives and
 * resolves with { content, stopReason, usage } where content is the assistant
 * message content (text + toolUse blocks) in Converse format.
 */
export async function converseTurn({ system, messages, tools, onText, modelId, maxTokens }) {
  modelId ||= process.env.MODEL_ID;
  if ((process.env.MODEL_MODE || '').toLowerCase() === 'mock') return mockTurn({ messages, onText, tools });

  // Plain HTTP/1.1 rather than the SDK's HTTP/2 default: ConverseStream works the
  // same either way, and HTTP/1.1 also gets through office firewalls that inspect
  // HTTPS traffic (they often break HTTP/2 with "Protocol error").
  client ||= new BedrockRuntimeClient({
    requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, requestTimeout: 120_000 })
  });
  let res;
  try {
    res = await client.send(new ConverseStreamCommand(buildRequest({ modelId, system, messages, tools, maxTokens })));
  } catch (e) {
    // If this model doesn't accept prompt-cache breakpoints, drop them and retry once.
    if (!cacheUnsupported && e.name === 'ValidationException' && /cache/i.test(e.message || '')) {
      cacheUnsupported = true;
      console.warn('Model rejected cachePoint; continuing without prompt caching:', e.message);
      res = await client.send(new ConverseStreamCommand(buildRequest({ modelId, system, messages, tools, maxTokens })));
    } else throw e;
  }

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
      } else if (d.toolUse && current?.toolUse) {
        current.toolUse.inputJson += d.toolUse.input || '';
      }
      // d.reasoningContent (GPT-5.x / Claude thinking) is intentionally not shown to members.
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
async function mockTurn({ messages, onText, tools = [] }) {
  const last = messages[messages.length - 1];
  const toolResults = (last.content || []).filter((b) => b.toolResult);
  const userText = [...messages].reverse().find((m) => m.role === 'user' && m.content.some((b) => b.text))?.content.find((b) => b.text)?.text || '';
  const usage = { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0 };

  const canOffer = tools.some((t) => t.toolSpec?.name === 'offer_document');
  if (!toolResults.length && canOffer && /\b(build|create|draft|write|make|need)\b.*\b(policy|handbook|document|receipt|acknowledg)/i.test(userText)) {
    const id = /fmla/i.test(userText) ? 'fmla-policy' : /receipt|acknowledg/i.test(userText) ? 'acknowledgment-receipt' : 'personnel-policies';
    const town = userText.match(/\b((?:Town|City) of [A-Z][\w ]+?)\b(?=[.,?!]|$)/);
    return { stopReason: 'tool_use', usage, content: [{ toolUse: { toolUseId: 'mock-doc', name: 'offer_document', input: { template_id: id, ...(town ? { prefill: { municipality_name: town[1] } } : {}) } } }] };
  }
  if (toolResults.length && toolResults[0].toolResult.content[0].json?.shown) {
    const text = `**Mock answer.** I can build OMAG's ${toolResults[0].toolResult.content[0].json.title} for you. Answer a few questions and you'll get the Word file to review with your attorney before adoption.`;
    onText?.(text);
    return { stopReason: 'end_turn', usage, content: [{ text }] };
  }
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
