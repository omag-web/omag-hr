import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
delete process.env.TABLE_NAME;
const { handler } = await import('../src/handler.mjs');

async function call(method, path, { body, query } = {}) {
  const stream = makeResponseStream();
  await handler({
    rawPath: path,
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : undefined,
    requestContext: { http: { method, sourceIp: '203.0.113.9' } }
  }, stream);
  await stream.done;
  return stream.result();
}

test('GET /health', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  assert.ok(j.library.sections > 1000);
});

test('GET /source', async () => {
  const r = await call('GET', '/source', { query: { id: '11-12-106' } });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.cite, '11 O.S. § 12-106');
  assert.match(j.text, /board of trustees/);
  assert.equal((await call('GET', '/source', { query: { id: 'zzz' } })).statusCode, 404);
});

test('POST /chat streams NDJSON ending in done with citations', async () => {
  const r = await call('POST', '/chat', { body: {
    conversationId: 'conv_test_123', browserId: 'b1', form: 'town', city: 'Town of Example',
    messages: [{ role: 'user', text: 'board of trustees appoint and remove town employees' }]
  } });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['Content-Type'], /ndjson/);
  const events = r.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'status');
  assert.ok(events.some((e) => e.type === 'text'));
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.match(done.turnId, /^TURN#/);
  assert.ok(done.citations.length >= 1);
});

test('POST /chat validates input', async () => {
  assert.equal((await call('POST', '/chat', { body: { messages: [{ role: 'user', text: 'hi' }] } })).statusCode, 400);
  assert.equal((await call('POST', '/chat', { body: { conversationId: 'conv_test_123', messages: [] } })).statusCode, 400);
  assert.equal((await call('POST', '/chat', { body: { conversationId: 'conv_test_123', messages: [{ role: 'user', text: 'x'.repeat(5000) }] } })).statusCode, 400);
});

test('POST /feedback rates a real answer, rejects unknown ones', async () => {
  const r = await call('POST', '/chat', { body: { conversationId: 'conv_fb_12345', browserId: 'b', form: 'town', messages: [{ role: 'user', text: 'board of trustees appoint remove' }] } });
  const done = r.body.trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal((await call('POST', '/feedback', { body: { conversationId: 'conv_fb_12345', turnId: done.turnId, rating: 'up' } })).statusCode, 200);
  assert.equal((await call('POST', '/feedback', { body: { conversationId: 'conv_test_123', turnId: 'TURN#nope', rating: 'up' } })).statusCode, 404);
  assert.equal((await call('POST', '/feedback', { body: { conversationId: 'conv_test_123', turnId: 'TURN#x', rating: 'meh' } })).statusCode, 400);
});

test('unknown route', async () => {
  assert.equal((await call('GET', '/nope')).statusCode, 404);
});
