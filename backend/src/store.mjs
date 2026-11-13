// DynamoDB: conversation logs, feedback, and rate limits — one table.
// If TABLE_NAME isn't set (local dev, tests) everything is a no-op that allows requests.
//
// Items
//   pk CONV#<conversationId>   sk TURN#<iso time>#<rand>   one per answered question
//   pk CONTACT#<date>          sk <iso time>#<rand>        "Talk to OMAG" messages
//   pk RATE#<scope>#<date>     sk -                        counters (expire after 2 days)

import { createHash, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const TABLE = process.env.TABLE_NAME;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 730);
const SALT = process.env.HASH_SALT || 'local-dev';
let ddb;
const db = () => (ddb ||= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));

export const hash = (v) => createHash('sha256').update(SALT + '|' + String(v || '')).digest('hex').slice(0, 24);
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const epoch = (days) => Math.floor(Date.now() / 1000) + days * 86400;

/**
 * Counts one message against the per-IP and global daily limits.
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function checkRateLimit(ip) {
  if (!TABLE) return { ok: true };
  const perIp = Number(process.env.DAILY_LIMIT_PER_IP || 60);
  const global = Number(process.env.DAILY_LIMIT_GLOBAL || 600);
  const bump = async (pk, limit) => {
    try {
      await db().send(new UpdateCommand({
        TableName: TABLE,
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

export async function logTurn({ conversationId, turnId, browserId, ip, city, form, question, answer, citations, unread, usage, toolCalls, latencyMs, model, error }) {
  if (!TABLE) return;
  await db().send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `CONV#${conversationId}`,
      sk: turnId,
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
      expiresAt: epoch(RETENTION_DAYS)
    }
  }));
}

export async function saveFeedback({ conversationId, turnId, rating, note }) {
  if (!TABLE) return true;
  try {
    await db().send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `CONV#${conversationId}`, sk: turnId },
      UpdateExpression: 'SET rating = :r, ratingNote = :n, ratedAt = :t',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':r': rating, ':n': note ? String(note).slice(0, 1000) : null, ':t': new Date().toISOString() }
    }));
    return true;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
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
  if (!TABLE) return;
  await db().send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `CONTACT#${day()}`,
      sk: `${new Date().toISOString()}#${randomBytes(3).toString('hex')}`,
      type: 'contact',
      conversationId, city, form,
      note: String(note || '').slice(0, 2000),
      transcript: String(transcript || '').slice(0, 20000),
      ip: hash(ip),
      expiresAt: epoch(RETENTION_DAYS)
    }
  }));
}
