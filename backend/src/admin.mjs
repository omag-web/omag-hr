// /admin/* routes. Every route requires a signed-in admin (see auth.mjs).

import { requireAdmin } from './auth.mjs';
import { getConfig, getGuidanceState, saveDraft, discardDraft, publishDraft, restoreToDraft, saveSettings, MODELS, validateGuidance, DEFAULT_PRIVACY_NOTICE } from './config.mjs';
import { listDocs, createUpload, processDoc, updateDoc, deleteDoc, addWebsite, fetchWebsite } from './docs.mjs';
import { getLibrary, libraryStatus, refreshLibrary, librarySources, checkSources } from './library.mjs';
import { listTurns, getConversation, listContacts, usageStats } from './store.mjs';
import { analytics } from './analytics.mjs';
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, variantUploadUrl, attachVariant, removeVariant, fillTemplate, exportPack, importPack, importUploadUrl, VARIANT_LABEL, FIELD_TYPES, PREFILLS } from './templates.mjs';
import { blobs } from './storage.mjs';
import { listAdmins, inviteAdmin, resendAccess, setAdminEnabled, removeAdmin, resetMfa } from './admins.mjs';

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

/* admins */
const withYou = async (admin, extra = {}) => ({ ...extra, you: admin.username, admins: (await listAdmins()).map((u) => ({ ...u, you: u.username === admin.username || u.email === admin.email })) });
on('GET', '/admin/admins', async ({ admin }) => withYou(admin));
on('POST', '/admin/admins', async ({ body, admin }) => { const u = await inviteAdmin(body?.email); console.log('admin invited', u.email, 'by', admin.email); return withYou(admin, { message: `Invited ${u.email}. They'll get an email with a temporary password (good for 7 days).` }); });
on('POST', '/admin/admins/:id/resend', async ({ params, admin }) => withYou(admin, await resendAccess(params.id)));
on('POST', '/admin/admins/:id/disable', async ({ params, admin }) => { const r = await setAdminEnabled(params.id, false, admin); console.log('admin disabled', params.id, 'by', admin.email); return withYou(admin, r); });
on('POST', '/admin/admins/:id/enable', async ({ params, admin }) => { const r = await setAdminEnabled(params.id, true, admin); console.log('admin enabled', params.id, 'by', admin.email); return withYou(admin, r); });
on('POST', '/admin/admins/:id/reset-mfa', async ({ params, admin }) => { const r = await resetMfa(params.id, admin); console.log('admin MFA reset', params.id, 'by', admin.email); return withYou(admin, r); });
on('DELETE', '/admin/admins/:id', async ({ params, admin }) => { const r = await removeAdmin(params.id, admin); console.log('admin removed', params.id, 'by', admin.email); return withYou(admin, r); });

/* document templates */
const tplMeta = { variants: VARIANT_LABEL, fieldTypes: FIELD_TYPES, prefills: PREFILLS };
on('GET', '/admin/templates', async () => ({ templates: await listTemplates(), ...tplMeta }));
on('POST', '/admin/templates', async ({ body, admin }) => ({ template: await createTemplate(body || {}, admin.email) }));
on('GET', '/admin/templates/:id', async ({ params }) => ({ template: await getTemplate(params.id), ...tplMeta }));
on('PUT', '/admin/templates/:id', async ({ params, body, admin }) => ({ template: await updateTemplate(params.id, body || {}, admin.email) }));
on('DELETE', '/admin/templates/:id', async ({ params }) => { await deleteTemplate(params.id); return { templates: await listTemplates() }; });
on('POST', '/admin/templates/:id/upload', async ({ params, body }) => variantUploadUrl(params.id, body || {}));
on('POST', '/admin/templates/:id/attach', async ({ params, body, admin }) => attachVariant(params.id, body || {}, admin.email));
on('POST', '/admin/templates/:id/remove-file', async ({ params, body }) => ({ template: await removeVariant(params.id, String(body?.variant || '')) }));
on('POST', '/admin/templates/:id/test', async ({ params, body }) => {
  const d = await fillTemplate(params.id, { form: body?.form, values: body?.values || {}, municipality: body?.values?.municipality_name }, { allowDisabled: true });
  return { filename: d.filename, data: d.data.toString('base64'), blanks: d.blanks, variant: d.variant };
});
on('GET', '/admin/templates-export', async () => ({ filename: `pip-templates-${new Date().toISOString().slice(0, 10)}.zip`, data: (await exportPack()).toString('base64') }));
on('POST', '/admin/templates-import/upload', async () => importUploadUrl());
on('POST', '/admin/templates-import', async ({ body, admin }) => {
  const key = String(body?.key || '');
  if (!/^imports\/[\w-]+\.zip$/.test(key)) throw Object.assign(new Error('Upload not found.'), { status: 404 });
  const buf = await blobs.get(key);
  if (!buf) throw Object.assign(new Error('The upload didn’t arrive. Try again.'), { status: 404 });
  try { return { imported: await importPack(buf, admin.email), templates: await listTemplates() }; } finally { await blobs.del(key); }
});

/* guidance */
on('GET', '/admin/guidance', async () => getGuidanceState());
on('PUT', '/admin/guidance/draft', async ({ body, admin }) => { await saveDraft(body.text, admin.email); return getGuidanceState(); });
on('DELETE', '/admin/guidance/draft', async () => { await discardDraft(); return getGuidanceState(); });
on('POST', '/admin/guidance/publish', async ({ body, admin }) => { await publishDraft(admin.email, body.note); return getGuidanceState(); });
on('POST', '/admin/guidance/restore', async ({ body, admin }) => { await restoreToDraft(String(body.id || ''), admin.email); return getGuidanceState(); });

/* settings */
const settingsExtra = { models: MODELS, privacyDefault: DEFAULT_PRIVACY_NOTICE, retentionDays: Number(process.env.RETENTION_DAYS || 730) };
on('GET', '/admin/settings', async () => ({ settings: (await getConfig({ fresh: true })).settings, ...settingsExtra }));
on('PUT', '/admin/settings', async ({ body, admin }) => ({ settings: await saveSettings(body || {}, admin.email), ...settingsExtra }));

/* documents */
on('GET', '/admin/docs', async () => ({ docs: await listDocs() }));
on('POST', '/admin/docs', async ({ body, admin }) => createUpload(body || {}, admin.email));
on('POST', '/admin/docs/web', async ({ body, admin }) => { const result = await addWebsite(body || {}, admin.email); return { result, docs: await listDocs() }; });
on('POST', '/admin/docs/:id/recheck', async ({ params }) => {
  let result;
  try { result = await fetchWebsite(params.id); } catch (e) { result = { error: e.message }; }
  return { result, docs: await listDocs() };
});
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
on('GET', '/admin/library/sources', async () => librarySources());
on('POST', '/admin/library/check-sources', async () => checkSources());
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
