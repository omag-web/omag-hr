#!/usr/bin/env node
// Local development server: runs the Lambda handler under Node and serves web/.
//
//   npm run dev:mock          # no AWS needed; scripted model
//   AWS_PROFILE=omag MODEL_ID=<inference profile id> AWS_REGION=us-east-1 npm run dev
//
// Open http://localhost:8787 — web/config.js points at this server automatically
// when the page is served from localhost.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installShim, makeResponseStream } from './lambda-shim.mjs';

installShim();
const { handler } = await import('../src/handler.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', '..', 'web');
const PORT = Number(process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const API = new Set(['/health', '/source', '/chat', '/feedback', '/contact']);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\/api(?=\/)/, '');
  if (API.has(path)) {
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const event = {
      rawPath: path,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body,
      isBase64Encoded: false,
      requestContext: { http: { method: req.method, sourceIp: req.socket.remoteAddress } }
    };
    const stream = makeResponseStream(res);
    await handler(event, stream);
    return;
  }
  // Static files from web/
  let file = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log(`Pip dev server on http://localhost:${PORT}  (model: ${process.env.MODEL_MODE === 'mock' ? 'mock' : process.env.MODEL_ID || 'MODEL_ID not set'})`));
