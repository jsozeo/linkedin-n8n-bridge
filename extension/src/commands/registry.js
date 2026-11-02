// Selector-registry maintenance commands, so the cloud document can be
// inspected, forced and pointed elsewhere from n8n or the side panel without
// touching chrome://extensions.

import { refreshSelectors, selectorStatus, getSelectors, sel } from '../selectors.js';
import { budgetStatus } from '../guard.js';

export async function selectors_status() {
  return { selectors: await selectorStatus(), writeBudget: await budgetStatus() };
}

export async function selectors_refresh({ force = true } = {}) {
  const result = await refreshSelectors({ force });
  return { ...result, status: await selectorStatus() };
}

export async function selectors_set_url({ url = null, writeUrl = null, writeToken = null } = {}) {
  for (const u of [url, writeUrl]) {
    if (u && !/^https:\/\//.test(u)) {
      const e = new Error('selectors_set_url: https URL required'); e.code = 'BAD_PARAMS'; throw e;
    }
  }
  await chrome.storage.local.set({ selectorsUrl: url });
  if (writeUrl !== null) await chrome.storage.local.set({ selectorsWriteUrl: writeUrl });
  if (writeToken !== null) await chrome.storage.local.set({ selectorsWriteToken: writeToken });
  await chrome.storage.local.remove('selectorsCache');
  return url ? await selectors_refresh({ force: true }) : { source: 'bundled', url: null };
}

/** Dump the merged document, or one dotted path of it. */
export async function selectors_get({ path = null } = {}) {
  if (path) return { path, candidates: await sel(path) };
  return { registry: await getSelectors() };
}

/**
 * Change one path and publish the result, so a selector fix never requires
 * opening an editor. `prepend` (the default) puts the new candidates ahead of
 * the existing ones and keeps the old ones as a fallback — that is almost
 * always what you want, because it is reversible by doing nothing.
 *
 *   { path: 'linkedin.composer.submit',
 *     candidates: ['button[aria-label="Post comment"]'] }
 *
 * Needs `selectorsWriteUrl` + `selectorsWriteToken` in chrome.storage.local.
 */
export async function selectors_patch({ path, candidates, prepend = true, publish = true } = {}) {
  if (!path || !Array.isArray(candidates) || !candidates.length) {
    const e = new Error('selectors_patch: path and a non-empty candidates array are required');
    e.code = 'BAD_PARAMS'; throw e;
  }

  const doc = JSON.parse(JSON.stringify(await getSelectors()));
  const keys = path.split('.');
  const leaf = keys.pop();
  let node = doc;
  for (const k of keys) { if (!node[k] || typeof node[k] !== 'object') node[k] = {}; node = node[k]; }

  const before = Array.isArray(node[leaf]) ? node[leaf] : [];
  const merged = prepend
    ? [...candidates, ...before.filter((c) => !candidates.includes(c))]
    : candidates;
  node[leaf] = merged;
  doc.version = `sel-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;

  // Apply locally first so the very next action uses it even if publishing fails.
  await chrome.storage.local.set({ selectorsCache: { at: Date.now(), version: doc.version, data: doc } });
  const result = { path, before, after: merged, version: doc.version, published: false };
  if (!publish) return result;

  const { selectorsWriteUrl: writeUrl, selectorsWriteToken: writeToken } =
    await chrome.storage.local.get(['selectorsWriteUrl', 'selectorsWriteToken']);
  if (!writeUrl) return { ...result, note: 'applied locally only — set selectorsWriteUrl to publish' };

  const res = await fetch(writeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}) },
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    const e = new Error(`publish failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    e.code = 'PUBLISH_FAILED'; throw e;
  }
  return { ...result, published: true, url: writeUrl };
}
