// Usage analytics for the admin panel, computed from the logged member questions.
// Days, hours and weekdays are in Oklahoma time (America/Chicago).

import { listTurns, listContacts } from './store.mjs';

const TZ = 'America/Chicago';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const localDay = (d) => dayFmt.format(d);
function localParts(d) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, weekday: p.weekday };
}

/** Topic of a cited section, from its id. Order matters: first match wins. */
const TOPICS = [
  [/^omag-/, 'OMAG guidance'],
  [/^29-CFR-825/, 'FMLA leave'],
  [/^29-CFR-(541|553|785|778|516)/, 'Wages & hours (FLSA)'],
  [/^29-CFR-1630/, 'Disability (ADA)'],
  [/^49-CFR-/, 'DOT drug & alcohol testing'],
  [/^25-(3\d\d)/, 'Open meetings'],
  [/^51-24A/, 'Open records'],
  [/^51-/, 'Tort claims & liability'],
  [/^85A-/, "Workers' comp"],
  [/^63-/, 'Medical marijuana'],
  [/^44-/, 'Military leave'],
  [/^40-/, 'Labor (Title 40)'],
  [/^11-51-/, 'Police & fire bargaining'],
  [/^11-/, 'Municipal authority (Title 11)'],
  [/CFR/, 'Other federal'],
  [/./, 'Other Oklahoma law']
];
export const topicOf = (id) => TOPICS.find(([re]) => re.test(id))[1];

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}
const top = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

function summarize(turns) {
  const convs = new Set(), people = new Set();
  let up = 0, down = 0, errors = 0, removed = 0, inTok = 0, outTok = 0, cacheTok = 0, cited = 0;
  for (const t of turns) {
    convs.add(t.conversationId);
    if (t.browser) people.add(t.browser);
    if (t.rating === 'up') up++;
    if (t.rating === 'down') down++;
    if (t.error) errors++;
    if (t.unread?.length) removed++;
    if (t.citations?.length) cited++;
    inTok += t.inputTokens || 0; outTok += t.outputTokens || 0; cacheTok += t.cacheReadTokens || 0;
  }
  const lat = turns.filter((t) => !t.error && t.latencyMs > 0).map((t) => t.latencyMs).sort((a, b) => a - b);
  return {
    questions: turns.length,
    conversations: convs.size,
    people: people.size,
    perConversation: convs.size ? Math.round((turns.length / convs.size) * 10) / 10 : null,
    up, down, rated: up + down,
    helpfulPct: pct(up, up + down),
    ratedPct: pct(up + down, turns.length),
    errors, errorPct: pct(errors, turns.length),
    removedCitations: removed,
    citedPct: pct(cited, turns.length),
    latencyMedianMs: quantile(lat, 0.5),
    latencyP90Ms: quantile(lat, 0.9),
    inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheTok
  };
}

/**
 * Analytics for the last `days` days, with the same-length period before it for comparison.
 * `labels` maps section id → citation label (from the library); `prices` gives $/million tokens.
 */
export async function analytics({ days = 30, labels = () => null, prices = {} } = {}) {
  days = [7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const now = Date.now();
  const all = await listTurns({ days: days * 2 + 1, limit: 50000 });
  const startCur = new Set();
  for (let i = 0; i < days; i++) startCur.add(localDay(new Date(now - i * 86400000)));
  const startPrev = new Set();
  for (let i = days; i < days * 2; i++) startPrev.add(localDay(new Date(now - i * 86400000)));
  const cur = [], prev = [];
  for (const t of all) {
    const d = localDay(new Date(t.at));
    if (startCur.has(d)) cur.push({ ...t, localDay: d }); else if (startPrev.has(d)) prev.push(t);
  }

  const totals = summarize(cur);
  const previous = summarize(prev);
  const cost = (s) => (prices.in || prices.out)
    ? Math.round((((s.inputTokens - s.cacheReadTokens * 0.9) / 1e6) * (prices.in || 0) + (s.outputTokens / 1e6) * (prices.out || 0)) * 100) / 100
    : null;
  totals.estimatedCost = cost(totals);
  previous.estimatedCost = cost(previous);

  // Questions per day (or per week for long ranges), oldest first.
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) byDay[localDay(new Date(now - i * 86400000))] = 0;
  const byHour = Array(24).fill(0);
  const byWeekday = Object.fromEntries(WEEKDAYS.map((w) => [w, 0]));
  const forms = {}, cities = {}, cityLabel = {}, sections = {}, topics = {};
  for (const t of cur) {
    if (t.localDay in byDay) byDay[t.localDay]++;
    const { hour, weekday } = localParts(new Date(t.at));
    byHour[hour]++;
    if (weekday in byWeekday) byWeekday[weekday]++;
    forms[t.form || 'unknown'] = (forms[t.form || 'unknown'] || 0) + 1;
    const city = String(t.city || '').trim().replace(/\s+/g, ' ');
    if (city) {
      const k = city.toLowerCase(); cities[k] = (cities[k] || 0) + 1;
      // Prefer a capitalized spelling ("Edmond" over "edmond").
      if (!cityLabel[k] || (!/[A-Z]/.test(cityLabel[k]) && /[A-Z]/.test(city))) cityLabel[k] = city;
    }
    const ids = [...new Set(t.citations || [])];
    for (const id of ids) sections[id] = (sections[id] || 0) + 1;
    const qTopics = new Set(ids.map(topicOf));
    if (!qTopics.size) qTopics.add(t.error ? 'Error (no answer)' : 'No law cited');
    for (const tp of qTopics) topics[tp] = (topics[tp] || 0) + 1;
  }
  let series = Object.entries(byDay).map(([d, n]) => ({ label: d, n }));
  let bucket = 'day';
  if (days > 90) {
    bucket = 'week';
    const weeks = [];
    for (let i = 0; i < series.length; i += 7) {
      const chunk = series.slice(i, i + 7);
      weeks.push({ label: chunk[0].label, end: chunk.at(-1).label, n: chunk.reduce((a, x) => a + x.n, 0) });
    }
    series = weeks;
  }

  const contacts = (await listContacts({ limit: 500 })).filter((c) => startCur.has(localDay(new Date(c.at)))).length;

  return {
    days, bucket, timeZone: TZ,
    totals: { ...totals, contacts }, previous,
    series,
    byHour, byWeekday,
    forms,
    topics: top(topics, 12).map(([name, n]) => ({ name, n })),
    sections: top(sections, 12).map(([id, n]) => ({ id, n, cite: labels(id) || (id.startsWith('omag-') ? 'OMAG document (since removed)' : id) })),
    cities: top(cities, 12).map(([k, n]) => ({ name: cityLabel[k], n })),
    citiesTotal: Object.keys(cities).length,
    feedback: cur.filter((t) => t.rating === 'down').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8)
      .map((t) => ({ conversationId: t.conversationId, at: t.at, question: t.question, note: t.ratingNote, city: t.city }))
  };
}
