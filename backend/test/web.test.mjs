import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';
import { htmlToText, pageTitle, normalizeUrl, fetchPublic, _setResolver } from '../src/web.mjs';

installShim();
const { handler } = await import('../src/handler.mjs');
const { kv } = await import('../src/storage.mjs');

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  const [rawPath, qs] = path.split('?');
  await handler({ rawPath, queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.9' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}

const PAGE = (extra = '') => `<!doctype html><html><head><title>Ignored</title><meta property="og:title" content="Drug &amp; Alcohol Testing FAQ"><style>.x{}</style></head>
<body><header><nav><a href="/">Home</a><a href="/about">About OMAG</a></nav></header>
<main><h1>Drug &amp; Alcohol Testing FAQ</h1><p>Municipalities that employ CDL drivers must follow DOT testing rules under 49 C.F.R. Part 382.</p>
<h2>Random testing</h2><ul><li>Select drivers using a scientifically valid method.</li><li>Notify the driver immediately&nbsp;before the test.</li></ul>
<script>console.log('nope')</script>${extra}</main><footer>© OMAG 2026 · Privacy</footer></body></html>`;

test('htmlToText keeps the content and drops menus, scripts and footers', () => {
  const t = htmlToText(PAGE());
  assert.match(t, /Drug & Alcohol Testing FAQ/);
  assert.match(t, /- Select drivers using a scientifically valid method\./);
  assert.match(t, /Notify the driver immediately before/);
  assert.ok(!/About OMAG|console\.log|Privacy/.test(t), t);
  assert.equal(pageTitle(PAGE()), 'Drug & Alcohol Testing FAQ');
  assert.equal(pageTitle('<title>HR Hotline | OMAG</title>'), 'HR Hotline');
});

test('URLs are normalized and private addresses are refused', async () => {
  assert.equal(normalizeUrl('omag.org/hr'), 'https://omag.org/hr');
  assert.throws(() => normalizeUrl('ftp://omag.org'), /http and https/);
  assert.throws(() => normalizeUrl('http://omag.org:8080/'), /standard web ports/);
  for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:80/', 'http://10.1.2.3/', 'http://[::1]/', 'http://localhost/']) {
    await assert.rejects(fetchPublic(bad), /isn’t a public website/, bad);
  }
  _setResolver(async () => [{ address: '192.168.1.5' }]);
  await assert.rejects(fetchPublic('https://sneaky.example.com/'), /isn’t a public website/);
  _setResolver(null);
});

test('websites: add, cite, re-check, keep last good copy when the site is down', async () => {
  const realFetch = globalThis.fetch;
  _setResolver(async () => [{ address: '93.184.216.34' }]);
  let html = PAGE(), status = 200, hits = 0;
  globalThis.fetch = async (url) => {
    hits++;
    if (String(url).startsWith('https://www.omag.org/old')) return new Response('', { status: 301, headers: { location: '/dot-testing' } });
    return new Response(status === 200 ? html : 'down', { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  try {
    const add = await call('POST', '/admin/docs/web', { body: { url: 'https://www.omag.org/old' } });
    assert.equal(add.statusCode, 200, JSON.stringify(add.json));
    const site = add.json.docs.find((d) => d.kind === 'web');
    assert.equal(site.status, 'ready');
    assert.equal(site.enabled, true);
    assert.equal(site.title, 'Drug & Alcohol Testing FAQ', 'title comes from the page');
    assert.equal(site.finalUrl, 'https://www.omag.org/dot-testing', 'redirects are followed');

    const found = (await call('POST', '/admin/library/search', { body: { query: 'random testing CDL drivers', jurisdiction: 'OMAG' } })).json.results;
    assert.ok(found.length, 'the page is searchable');
    const src = (await call('GET', `/source?id=${found[0].id}`)).json;
    assert.match(src.cite, /^OMAG: Drug & Alcohol Testing FAQ/, 'omag.org pages are cited as OMAG');
    assert.equal(src.url, 'https://www.omag.org/dot-testing', 'the citation links to the live page');

    assert.equal((await call('POST', '/admin/docs/web', { body: { url: 'https://www.omag.org/old' } })).statusCode, 400, 'no duplicates');

    let r = (await call('POST', `/admin/docs/${site.id}/recheck`)).json.result;
    assert.equal(r.changed, false, 'unchanged page is not rebuilt');
    html = PAGE('<p>New for 2027: post-accident testing within 8 hours of the accident.</p>');
    r = (await call('POST', `/admin/docs/${site.id}/recheck`)).json.result;
    assert.equal(r.changed, true);

    status = 500;
    r = (await call('POST', `/admin/docs/${site.id}/recheck`)).json;
    assert.match(r.result.error, /HTTP 500/);
    const after = r.docs.find((d) => d.id === site.id);
    assert.equal(after.status, 'ready', 'still usable');
    assert.match(after.lastError, /HTTP 500/);
    status = 200;

    // Other sites are cited by title, with the site in the source line.
    const other = (await call('POST', '/admin/docs/web', { body: { url: 'https://www.dol.gov/agencies/whd/fmla', title: 'DOL FMLA overview' } })).json;
    const otherId = other.docs.find((d) => d.title === 'DOL FMLA overview').id;
    const sec = (await call('GET', `/admin/docs/${otherId}/sections`)).json.sections[0];
    assert.equal(sec.cite.startsWith('DOL FMLA overview'), true);

    // A page with no readable text is rejected and not kept.
    html = '<html><body><div id="app"></div><script>render()</script></body></html>';
    const empty = await call('POST', '/admin/docs/web', { body: { url: 'https://spa.example.com/' } });
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json.error, /No readable text/);
    assert.ok(!(await call('GET', '/admin/docs')).json.docs.some((d) => d.url === 'https://spa.example.com/'));
    html = PAGE();

    // The daily task re-reads websites too.
    const before = hits;
    globalThis.fetch = async (url) => { hits++; if (String(url).includes('library.json')) return new Response('{}', { status: 404 }); return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }); };
    const s = makeResponseStream();
    await handler({ pipTask: 'refresh-library' }, s); await s.done;
    assert.ok(hits > before + 1, 'websites fetched by the daily task');
  } finally {
    globalThis.fetch = realFetch;
    _setResolver(null);
  }
});

test('statute sources: listed with counts, and links can be checked', async () => {
  const src = (await call('GET', '/admin/library/sources')).json;
  assert.ok(src.sources.length >= 10);
  const t11 = src.sources.find((s) => s.label === 'Title 11 O.S.');
  assert.equal(t11.url, 'https://oklegislature.gov/OK_Statutes/CompleteTitles/os11.pdf');
  assert.ok(t11.sections > 100);
  const fmla = src.sources.find((s) => s.label === '29 C.F.R. Part 825');
  assert.equal(fmla.url, 'https://www.ecfr.gov/current/title-29/part-825');
  assert.ok(fmla.sections > 50);
  assert.match(src.editUrl, /github\.com\/omag-web\/omag-hr\/edit\/main\/knowledge\/sources\.json/);

  const realFetch = globalThis.fetch;
  _setResolver(async () => [{ address: '93.184.216.34' }]);
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url.includes('os44.pdf')) return new Response('', { status: 404 });
    if (url.includes('os51.pdf') && opts?.method === 'HEAD') return new Response('', { status: 405 });
    if (url.endsWith('titles.json')) return new Response(JSON.stringify({ titles: [{ number: 29, up_to_date_as_of: '2026-11-10' }, { number: 49, up_to_date_as_of: '2026-11-10' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/ancestry/')) return new Response('{}', { status: url.includes('part=999') ? 404 : 200, headers: { 'content-type': 'application/json' } });
    return new Response(opts?.method === 'HEAD' ? null : 'x', { status: 200, headers: { 'content-type': 'application/pdf' } });
  };
  try {
    const { results } = (await call('POST', '/admin/library/check-sources')).json;
    const by = Object.fromEntries(results.map((r) => [r.url, r]));
    assert.equal(by['https://oklegislature.gov/OK_Statutes/CompleteTitles/os11.pdf'].ok, true);
    assert.equal(by['https://oklegislature.gov/OK_Statutes/CompleteTitles/os44.pdf'].ok, false);
    assert.match(by['https://oklegislature.gov/OK_Statutes/CompleteTitles/os44.pdf'].message, /404/);
    assert.equal(by['https://oklegislature.gov/OK_Statutes/CompleteTitles/os51.pdf'].ok, true, 'falls back to GET when HEAD is refused');
    assert.equal(by['https://www.ecfr.gov/current/title-29/part-825'].ok, true);
  } finally {
    globalThis.fetch = realFetch;
    _setResolver(null);
  }
});
