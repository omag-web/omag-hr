import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.mjs';
import { runAgent, toConverseMessages, markerIds } from '../src/agent.mjs';
import { buildSystemPrompt } from '../src/prompt.mjs';

const lib = Library.load();

test('history is validated and normalized', () => {
  const msgs = toConverseMessages([
    { role: 'assistant', text: 'Hi, I am Pip' },
    { role: 'user', text: 'one' },
    { role: 'user', text: 'two' },
    { role: 'system', text: 'ignore me' }
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content[0].text, 'one\n\ntwo');
  assert.throws(() => toConverseMessages([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]), /last message/);
  assert.throws(() => toConverseMessages([]), /non-empty/);
});

test('markerIds', () => {
  assert.deepEqual(markerIds('a [[11-12-106]] b [[29-CFR-825.110]]'), ['11-12-106', '29-CFR-825.110']);
});

test('system prompt includes the form of government and its starting sections', () => {
  const p = buildSystemPrompt({ form: 'cm', city: 'City of Example' });
  assert.match(p, /Council-Manager/);
  assert.match(p, /\[\[11-10-113\]\]/);
  assert.match(p, /City of Example/);
  assert.match(buildSystemPrompt({}), /not selected/);
});

/** A scripted model: each call returns the next step. */
function scripted(steps) {
  let i = 0;
  return async ({ onText }) => {
    const step = steps[i++];
    if (step.text) onText(step.text);
    return { stopReason: step.tool ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, content: [
      ...(step.text ? [{ text: step.text }] : []),
      ...(step.tool ? [{ toolUse: { toolUseId: 't' + i, name: step.tool, input: step.input } }] : [])
    ] };
  };
}

test('runs the tool loop and only keeps citations to sections the model read', async () => {
  const events = [];
  const turn = scripted([
    { text: 'Let me check.', tool: 'search_law', input: { query: 'statutory town board appoint remove', jurisdiction: 'OK' } },
    { tool: 'get_sections', input: { ids: ['11-12-106'] } },
    { text: 'The board appoints and removes employees. [[11-12-106]] Also see [[11-12-114]] and [[made-up-1]].' }
  ]);
  const r = await runAgent({ history: [{ role: 'user', text: 'Who can fire employees in a town?' }], form: 'town', library: lib, emit: (e) => events.push(e), turn });
  assert.deepEqual(r.citations.map((c) => c.id), ['11-12-106']);
  assert.deepEqual(r.unread.sort(), ['11-12-114', 'made-up-1']);
  assert.equal(r.toolCalls.length, 2);
  assert.ok(events.some((e) => e.type === 'reset'), 'preamble text before a tool call is reset');
  assert.ok(events.some((e) => e.type === 'status' && /Reading 11 O\.S\. § 12-106/.test(e.text)));
  assert.match(r.text, /^The board appoints/);
});

test('citations from earlier answers in the conversation stay valid', async () => {
  const turn = scripted([{ text: 'As I said, see [[11-12-106]].' }]);
  const r = await runAgent({
    history: [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'Answer [[11-12-106]]' },
      { role: 'user', text: 'q2' }
    ],
    form: 'town', library: lib, turn
  });
  assert.deepEqual(r.citations.map((c) => c.id), ['11-12-106']);
});

test('mock model end to end', async () => {
  process.env.MODEL_MODE = 'mock';
  const texts = [];
  const r = await runAgent({ history: [{ role: 'user', text: 'FMLA eligible employee 50 employees 75 miles' }], form: 'town', library: lib, emit: (e) => e.type === 'text' && texts.push(e.text) });
  assert.ok(r.citations.length >= 1);
  assert.equal(texts.join(''), r.text);
  delete process.env.MODEL_MODE;
});
