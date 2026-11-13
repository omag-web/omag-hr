// Stand-in for the `awslambda` global that Lambda provides to streaming functions,
// so handler.mjs can run under plain Node (dev server, tests).

import { Writable } from 'node:stream';

export function installShim() {
  if (typeof globalThis.awslambda?.streamifyResponse === 'function') return;
  globalThis.awslambda = {
    streamifyResponse: (fn) => fn,
    HttpResponseStream: {
      from(stream, meta) {
        stream.setMeta?.(meta);
        return stream;
      }
    }
  };
}

/** A response stream that collects output (for tests) or pipes to a Node http response. */
export function makeResponseStream(httpRes) {
  const chunks = [];
  let meta = { statusCode: 200, headers: {} };
  let headersSent = false;
  const sendHead = () => {
    if (headersSent || !httpRes) return;
    headersSent = true;
    httpRes.writeHead(meta.statusCode, meta.headers);
  };
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); if (httpRes) { sendHead(); httpRes.write(chunk); } cb(); },
    final(cb) { if (httpRes) { sendHead(); httpRes.end(); } cb(); }
  });
  w.setMeta = (m) => { meta = { statusCode: m.statusCode || 200, headers: m.headers || {} }; };
  w.result = () => ({ ...meta, body: Buffer.concat(chunks).toString('utf8') });
  w.done = new Promise((r) => w.on('finish', r));
  return w;
}
