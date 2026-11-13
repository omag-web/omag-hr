// Conversation logs, feedback, "Talk to OMAG" messages and rate limits.
//
//   pk CONV#<conversationId>  sk TURN#<iso>#<rand>   gsi1pk TURNS#<yyyy-mm-dd>  gsi1sk <turnId>
//   pk CONTACT#<yyyy-mm-dd>   sk <iso>#<rand>        gsi1pk CONTACTS            gsi1sk <iso>
//   pk RATE#<scope>#<date>    sk -                   (counters; expire after 2 days)

import { createHash, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { kv } from './storage.mjs';

const TABLE = () => process.env.TABLE_NAME;
const RETENTION_DAYS = () => Number(process.env.RETENTION_DAYS || 730);
const SALT = () => process.env.HASH_SALT || 'local-dev';
let ddb;
const db = () => (ddb ||= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));

export const hash = (v) => createHash('sha256').update(SALT() + '|' + String(v || '')).digest('hex').slice(0, 24);
export const day = (d = new Date()) => d.toISOString().slice(0, 10);
const epoch = (days) => Math.floor(Date.now() / 1000) + days * 86400;

/** Counts one question against the per-IP and global daily limits (from settings). */
export async function checkRateLimit(ip, { perIp = 60, global = 600 } = {}) {
  if (!TABLE()) return { ok: true };
  const bump = async (pk, limit) => {
    try {
      await db().send(new UpdateCommand({
        TableName: TABLE(),
        Key: { pk, sk: '-' },
        UpdateExpression: 'ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ConditionExpression: 'attribute_not_exists(n) OR n < :lim',
        ExpressionAttributeValues: { ':one': 1, ':lim': limit, ':exp': epoch(2) }
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  };
  if (!(await bump(`RATE#global#${day()}`, global))) return { ok: false, reason: 'Pip has reached its daily limit. Please try again tomorrow, or contact OMAG directly.' };
  if (!(await bump(`RATE#ip#${hash(ip)}#${day()}`, perIp))) return { ok: false, reason: "You've reached today's question limit. Please try again tomorrow, or contact OMAG directly." };
  return { ok: true };
}

export function newTurnId() {
  return `TURN#${new Date().toISOString()}#${randomBytes(3).toString('hex')}`;
}

export async function logTurn({ conversationId, turnId, browserId, ip, city, form, question, answer, citations, unread, usage, toolCalls, latencyMs, model, error, preview }) {
  await kv.put({
    pk: `CONV#${conversationId}`,
    sk: turnId,
    gsi1pk: preview ? `PREVIEW#${day()}` : `TURNS#${day()}`,
    gsi1sk: turnId,
    type: 'turn',
    day: day(),
    browser: hash(browserId),
    ip: hash(ip),
    city: city || undefined,
    form: form || undefined,
    question: String(question || '').slice(0, 4000),
    answer: String(answer || '').slice(0, 12000),
    citations: citations?.map((c) => c.id),
    unreadCitations: unread?.length ? unread : undefined,
    tools: toolCalls?.length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadInputTokens,
    latencyMs,
    model,
    error: error || undefined,
    expiresAt: epoch(RETENTION_DAYS())
  });
}

export async function saveFeedback({ conversationId, turnId, rating, note }) {
  return kv.patch(`CONV#${conversationId}`, turnId, { rating, ratingNote: note ? String(note).slice(0, 1000) : null, ratedAt: new Date().toISOString() });
}

export async function saveContact({ conversationId, city, form, note, transcript, ip }) {
  if (process.env.CONTACT_TOPIC_ARN) {
    await new SNSClient({}).send(new PublishCommand({
      TopicArn: process.env.CONTACT_TOPIC_ARN,
      Subject: `Pip: a member asked to talk to OMAG${city ? ` (${String(city).slice(0, 60)})` : ''}`.slice(0, 99),
      Message: [
        'A member used "Talk to OMAG" in Pip.',
        `Municipality: ${city || 'not given'}`,
        `Form of government: ${form || 'not given'}`,
        `Conversation: ${conversationId || 'n/a'}`,
        '',
        'Their note:',
        String(note || '(none)').slice(0, 2000),
        '',
        '--- Conversation ---',
        String(transcript || '').slice(0, 20000)
      ].join('\n')
    }));
  }
  const now = new Date().toISOString();
  await kv.put({
    pk: `CONTACT#${day()}`,
    sk: `${now}#${randomBytes(3).toString('hex')}`,
    gsi1pk: 'CONTACTS', gsi1sk: now,
    type: 'contact',
    conversationId, city, form,
    note: String(note || '').slice(0, 2000),
    transcript: String(transcript || '').slice(0, 20000),
    ip: hash(ip),
    expiresAt: epoch(RETENTION_DAYS())
  });
}

/* ---------- for the admin panel ---------- */
const turnSummary = (t) => ({
  conversationId: t.pk.slice(5), turnId: t.sk, at: t.sk.split('#')[1], day: t.day,
  city: t.city, form: t.form, question: t.question, answer: t.answer,
  citations: t.citations || [], unread: t.unreadCitations || [], rating: t.rating, ratingNote: t.ratingNote,
  inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cacheReadTokens, latencyMs: t.latencyMs, model: t.model, error: t.error,
  browser: t.browser
});

/** Member questions from the last `days` days (UTC), newest day first. Queries days 10 at a time. */
export async function listTurns({ days = 14, limit = 300 } = {}) {
  const out = [];
  const n = Math.min(Math.max(1, days), 366);
  for (let i = 0; i < n && out.length < limit; i += 10) {
    const batch = [];
    for (let j = i; j < Math.min(i + 10, n); j++) batch.push(day(new Date(Date.now() - j * 86400000)));
    const results = await Promise.all(batch.map((d) => kv.queryIndex(`TURNS#${d}`, { limit })));
    for (const r of results) out.push(...r);
  }
  return out.slice(0, limit).map(turnSummary);
}

export async function getConversation(conversationId) {
  const items = await kv.query(`CONV#${conversationId}`, { newestFirst: false, limit: 100 });
  return items.map(turnSummary);
}

export async function listContacts({ limit = 100 } = {}) {
  const items = await kv.queryIndex('CONTACTS', { limit });
  return items.map((c) => ({ at: c.gsi1sk, conversationId: c.conversationId, city: c.city, form: c.form, note: c.note, transcript: c.transcript }));
}

/** Rough usage numbers for the dashboard. */
export async function usageStats({ days = 30 } = {}) {
  const turns = await listTurns({ days, limit: 5000 });
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) byDay[day(new Date(Date.now() - i * 86400000))] = 0;
  let up = 0, down = 0, errors = 0, inTok = 0, outTok = 0;
  const forms = {}, convs = new Set();
  for (const t of turns) {
    if (t.day in byDay) byDay[t.day]++;
    if (t.rating === 'up') up++;
    if (t.rating === 'down') down++;
    if (t.error) errors++;
    inTok += t.inputTokens || 0; outTok += t.outputTokens || 0;
    if (t.form) forms[t.form] = (forms[t.form] || 0) + 1;
    convs.add(t.conversationId);
  }
  return { days, questions: turns.length, conversations: convs.size, up, down, errors, inputTokens: inTok, outputTokens: outTok, byDay, forms };
}
