// Fetching public web pages for OMAG resources, safely, and turning HTML into plain text.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (compatible; PipBot/1.0; +https://omag-web.github.io/omag-hr/) OMAG HR assistant';
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* ---------- address checks (don't let a URL reach AWS-internal or private addresses) ---------- */
function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function privateIp(ip) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateV4(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

let resolver = (host) => lookup(host, { all: true });
/** For tests: replace DNS resolution. */
export function _setResolver(fn) { resolver = fn || ((host) => lookup(host, { all: true })); }

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw err('Enter a web address.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw err('Only http and https addresses work.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw err('That doesn’t look like a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw err('Only http and https addresses work.');
  if (u.username || u.password) throw err('Addresses with a username or password aren’t supported.');
  if (u.port && !['80', '443'].includes(u.port)) throw err('Only standard web ports are supported.');
  u.hash = '';
  return u.toString();
}

async function assertPublic(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw err('That address isn’t a public website.');
  const addrs = isIP(host) ? [{ address: host }] : await resolver(host).catch(() => { throw err(`Couldn’t find the website ${host}. Check the address.`); });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw err('That address isn’t a public website.');
}

/** GET a public URL, following up to 5 redirects. Returns { url, contentType, body: Buffer }. */
export async function fetchPublic(raw, { method = 'GET' } = {}) {
  let url = normalizeUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(url);
    await assertPublic(u);
    let r;
    try {
      r = await fetch(url, { method, redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw err(e.name === 'TimeoutError' ? 'The website took too long to respond.' : 'Couldn’t reach that website.');
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = normalizeUrl(new URL(r.headers.get('location'), url).toString());
      continue;
    }
    if (!r.ok) throw Object.assign(err(`The website answered with an error (HTTP ${r.status}).`), { httpStatus: r.status });
    const contentType = (r.headers.get('content-type') || '').toLowerCase();
    if (method === 'HEAD') return { url, contentType, status: r.status, body: Buffer.alloc(0) };
    const chunks = []; let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > MAX_BYTES) throw err('That page is too large (over 5 MB).');
      chunks.push(c);
    }
    return { url, contentType, status: r.status, body: Buffer.concat(chunks) };
  }
  throw err('That address redirects too many times.');
}

/* ---------- HTML → text ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', deg: '°' };
export const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});

export function pageTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const t = og?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const title = decode(t).replace(/\s+/g, ' ').trim();
  // Drop a trailing site name: "HR Hotline | OMAG" → "HR Hotline".
  const m = title.match(/^(.{6,}?)\s+[|–—·-]\s+[^|–—·]{2,60}$/);
  return (m ? m[1] : title).slice(0, 120);
}

/** Readable text of a page: drops scripts, menus, headers and footers; keeps headings, paragraphs, lists and tables. */
export function htmlToText(html) {
  let h = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|object|canvas|select|button)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Prefer the main content area when the page marks one.
  const main = h.match(/<main\b[\s\S]*?<\/main\s*>/i)?.[0] || h.match(/<article\b[\s\S]*?<\/article\s*>/i)?.[0];
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) h = main;
  else h = h.match(/<body\b[\s\S]*<\/body\s*>/i)?.[0] || h;
  h = h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+(aria-hidden=["']true["']|role=["'](navigation|banner|contentinfo|dialog)["']|class=["'][^"']*\b(cookie|banner|newsletter|header-nav|site-header|site-footer|skip-link)\b[^"']*["'])[^>]*>[\s\S]*?<\/(div|section|nav|ul)\s*>/gi, ' ');
  const text = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n, t) => `\n\n${t.replace(/<[^>]+>/g, ' ').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n\n- ')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|ul|ol|li|tr|table|thead|tbody|blockquote|pre|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\| *(\n|$)/g, '$1')
    .split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter((p) => p && p !== '-')
    .join('\n\n');
}
