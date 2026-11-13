// Storage for everything the admin panel can change.
//
// In AWS: a DynamoDB table (TABLE_NAME) for small records and an S3 bucket
// (DATA_BUCKET) for files. Locally (no TABLE_NAME / DATA_BUCKET) the same calls
// use memory and a folder under the OS temp dir, so the dev server and tests run
// without AWS.

import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const TABLE = () => process.env.TABLE_NAME;
const BUCKET = () => process.env.DATA_BUCKET;

let ddb, s3;
const db = () => (ddb ||= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));
const s3c = () => (s3 ||= new S3Client({}));

/* ---------------- records (DynamoDB or memory) ---------------- */
const mem = new Map(); // key `${pk}|${sk}` → item

export const kv = {
  async get(pk, sk) {
    if (!TABLE()) return mem.get(`${pk}|${sk}`) || null;
    const r = await db().send(new GetCommand({ TableName: TABLE(), Key: { pk, sk } }));
    return r.Item || null;
  },
  async put(item) {
    if (!TABLE()) { mem.set(`${item.pk}|${item.sk}`, structuredClone(item)); return; }
    await db().send(new PutCommand({ TableName: TABLE(), Item: item }));
  },
  async del(pk, sk) {
    if (!TABLE()) { mem.delete(`${pk}|${sk}`); return; }
    await db().send(new DeleteCommand({ TableName: TABLE(), Key: { pk, sk } }));
  },
  /** All items with this pk (optionally sk prefix), newest sk first. */
  async query(pk, { prefix, limit = 100, newestFirst = true } = {}) {
    if (!TABLE()) {
      return [...mem.values()]
        .filter((i) => i.pk === pk && (!prefix || i.sk.startsWith(prefix)))
        .sort((a, b) => (newestFirst ? b.sk.localeCompare(a.sk) : a.sk.localeCompare(b.sk)))
        .slice(0, limit);
    }
    const r = await db().send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
      ExpressionAttributeValues: prefix ? { ':pk': pk, ':p': prefix } : { ':pk': pk },
      ScanIndexForward: !newestFirst,
      Limit: limit
    }));
    return r.Items || [];
  },
  /** Items on the gsi1 index with this partition key, newest first. */
  async queryIndex(gsi1pk, { limit = 200 } = {}) {
    if (!TABLE()) {
      return [...mem.values()].filter((i) => i.gsi1pk === gsi1pk).sort((a, b) => b.gsi1sk.localeCompare(a.gsi1sk)).slice(0, limit);
    }
    const r = await db().send(new QueryCommand({
      TableName: TABLE(), IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': gsi1pk },
      ScanIndexForward: false, Limit: limit
    }));
    return r.Items || [];
  },
  /** Set some attributes on an existing item. Returns false if it doesn't exist. */
  async patch(pk, sk, attrs) {
    if (!TABLE()) {
      const cur = mem.get(`${pk}|${sk}`);
      if (!cur) return false;
      mem.set(`${pk}|${sk}`, { ...cur, ...attrs });
      return true;
    }
    const names = {}, values = {}, sets = [];
    Object.entries(attrs).forEach(([k, v], i) => { names[`#a${i}`] = k; values[`:v${i}`] = v; sets.push(`#a${i} = :v${i}`); });
    try {
      await db().send(new UpdateCommand({
        TableName: TABLE(), Key: { pk, sk },
        UpdateExpression: 'SET ' + sets.join(', '),
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  },
  _reset() { mem.clear(); }
};

/* ---------------- files (S3 or a local folder) ---------------- */
const LOCAL_DIR = () => process.env.LOCAL_DATA_DIR || join(tmpdir(), 'pip-data');
const safeKey = (key) => String(key).replace(/\.\.+/g, '').replace(/^\/+/, '');

export const blobs = {
  async get(key) {
    key = safeKey(key);
    if (!BUCKET()) {
      try { return await readFile(join(LOCAL_DIR(), key)); } catch { return null; }
    }
    try {
      const r = await s3c().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  },
  async put(key, body, contentType = 'application/octet-stream') {
    key = safeKey(key);
    if (!BUCKET()) {
      const p = join(LOCAL_DIR(), key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
      return;
    }
    await s3c().send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: body, ContentType: contentType }));
  },
  async del(key) {
    key = safeKey(key);
    if (!BUCKET()) { await rm(join(LOCAL_DIR(), key), { force: true }); return; }
    await s3c().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
  },
  /** A URL the browser can PUT a file to directly (S3 presigned URL, or the dev server locally). */
  async uploadUrl(key, contentType) {
    key = safeKey(key);
    if (!BUCKET()) return `/dev-upload/${encodeURIComponent(key)}`;
    return getSignedUrl(s3c(), new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }), { expiresIn: 900 });
  }
};
