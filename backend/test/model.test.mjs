import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, modelFamily } from '../src/model.mjs';

const base = { system: 'sys', messages: [{ role: 'user', content: [{ text: 'q' }] }], tools: [] };

test('model family detection', () => {
  assert.equal(modelFamily('us.openai.gpt-5.6-terra'), 'openai');
  assert.equal(modelFamily('global.openai.gpt-5.6-sol'), 'openai');
  assert.equal(modelFamily('us.anthropic.claude-sonnet-5-5'), 'anthropic');
});

test('GPT requests: bigger token budget for reasoning, no temperature, cache breakpoint', () => {
  const r = buildRequest({ ...base, modelId: 'us.openai.gpt-5.6-terra' });
  assert.equal(r.inferenceConfig.maxTokens, 8000);
  assert.equal('temperature' in r.inferenceConfig, false);
  assert.deepEqual(r.system[1], { cachePoint: { type: 'default' } });
});

test('Claude requests keep low temperature', () => {
  const r = buildRequest({ ...base, modelId: 'us.anthropic.claude-sonnet-5-5' });
  assert.equal(r.inferenceConfig.temperature, 0.2);
  assert.equal(r.inferenceConfig.maxTokens, 2000);
});
