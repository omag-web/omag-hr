// /admin/* routes. Every route requires a signed-in admin (see auth.mjs).

import { requireAdmin } from './auth.mjs';
import { getConfig, getGuidanceState, saveDraft, discardDraft, publishDraft, restoreToDraft, saveSettings, MODELS, validateGuidance } from './config.mjs';
import { listDocs, createUpload, processDoc, updateDoc, deleteDoc } from './docs.mjs';
import { getLibrary, libraryStatus, refreshLibrary } from './library.mjs';
import { listTurns, getConversation, listContacts, usageStats } from './store.mjs';
import { analytics } from './analytics.mjs';

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_\\-]+)') + '$'), fn });

on('GET', '/admin/me', async ({ admin }) => ({ email: admin.email, dev: !!admin.dev }));

on('GET', '/admin/overview', async () => {
  const [stats, library, docs, cfg] = await Promise.all([usageStats({ days: 30 }), libraryStatus(), listDocs(), getConfig({ fresh: true })]);
  return { stats, library, docs: { total: docs.length, enabled: docs.filter((d) => d.enabled).length }, guidance: cfg.guidanceMeta, model: MODELS[cfg.settings.modelId] || cfg.settings.modelId };
});

on('GET', '/admin/analytics', async ({ query }) => {
  const [lib, cfg] = await Promise.all([getLibrary(), getConfig({ fresh: true })]);
  return analytics({
    days: query.days,
    labels: (id) => lib.get(id)?.cite,
    prices: { in: cfg.settings.priceInputPerM, out: cfg.settings.priceOutputPerM }
  });
});
on('GET', '/admin/analytics/export', async ({ query }) => ({
  turns: (await listTurns({ days: Math.min(Number(query.days) || 30, 366), limit: 20000 }))
    .map(({ browser, ...t }) => t)
}));

/* guidance */
on('GET', '/admin/guidance', async () => getGuidanceState());
on('PUT', '/admin/guidance/draft', async ({ body, admin }) => { await saveDraft(body.text, admin.email); return getGuidanceState(); });
on('DELETE', '/admin/guidance/draft', async () => { await discardDraft(); return getGuidanceState(); });
on('POST', '/admin/guidance/publish', async ({ body, admin }) => { await publishDraft(admin.email, body.note); return getGuidanceState(); });
on('POST', '/admin/guidance/restore', async ({ body, admin }) => { await restoreToDraft(String(body.id || ''), admin.email); return getGuidanceState(); });

/* settings */
on('GET', '/admin/settings', async () => ({ settings: (await getConfig({ fresh: true })).settings, models: MODELS }));
on('PUT', '/admin/settings', async ({ body, admin }) => ({ settings: await saveSettings(body || {}, admin.email), models: MODELS }));

/* documents */
on('GET', '/admin/docs', async () => ({ docs: await listDocs() }));
on('POST', '/admin/docs', async ({ body, admin }) => createUpload(body || {}, admin.email));
on('POST', '/admin/docs/:id/process', async ({ params }) => processDoc(params.id));
on('PUT', '/admin/docs/:id', async ({ params, body }) => { await updateDoc(params.id, body || {}); return { docs: await listDocs() }; });
on('DELETE', '/admin/docs/:id', async ({ params }) => { await deleteDoc(params.id); return { docs: await listDocs() }; });
on('GET', '/admin/docs/:id/sections', async ({ params }) => {
  const lib = await getLibrary();
  return { sections: lib.sections.filter((s) => s.id.startsWith(`omag-${params.id}-`)).map(({ id, cite, heading, text }) => ({ id, cite, heading, text })) };
});

/* conversations */
on('GET', '/admin/conversations', async ({ query }) => ({ turns: await listTurns({ days: Math.min(Number(query.days) || 14, 90), limit: 500 }) }));
on('GET', '/admin/conversations/:id', async ({ params }) => ({ turns: await getConversation(params.id) }));
on('GET', '/admin/contacts', async () => ({ contacts: await listContacts({ limit: 200 }) }));

/* library */
on('GET', '/admin/library', async () => libraryStatus());
on('POST', '/admin/library/refresh', async ({ body }) => ({ result: await refreshLibrary({ force: !!body?.force }), status: await libraryStatus() }));
on('POST', '/admin/library/search', async ({ body }) => {
  const lib = await getLibrary();
  const j = ['OK', 'US', 'OMAG'].includes(body?.jurisdiction) ? body.jurisdiction : undefined;
  return { results: lib.search(String(body?.query || '').slice(0, 300), { jurisdiction: j, limit: 15 }).map(({ id, cite, heading, jurisdiction, text }) => ({ id, cite, heading, jurisdiction, excerpt: text.slice(0, 300) })) };
});

/** Finds the route. Returns null if no admin route matches. */
export function matchAdmin(method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (m) return { fn: r.fn, params: m.groups || {} };
  }
  return null;
}

export { validateGuidance };
