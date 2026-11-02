// Registry maintenance commands, so the cloud document can be inspected and
// corrected from n8n or the side panel without touching chrome://extensions.

import { resolveEntry, registryStatus, registryUrl, sel, pageTypeFromKind } from '../registry.js';
import { budgetStatus } from '../guard.js';

function bad(message) {
  const e = new Error(message); e.code = 'BAD_PARAMS'; throw e;
}

/** What is published, for which page types, and whether anything is failing. */
export async function selectors_status() {
  return { registry: await registryStatus(), writeBudget: await budgetStatus() };
}

/**
 * There is no cache to refresh any more — every job fetches. Kept as a
 * connectivity check: it resolves one entry and reports what came back.
 */
export async function selectors_refresh({ url = null, pageType = null, locale = null } = {}) {
  if (!url && !pageType) return { checked: 'index', ...(await registryStatus()) };
  const entry = await resolveEntry({ url, pageType: pageTypeFromKind(pageType), locale });
  return {
    checked: 'entry',
    page_type: entry.page_type,
    ui_locale: entry.ui_locale,
    version: entry.version,
    published_at: entry.published_at,
    extract_js_bytes: entry.extractor?.extract_js?.length || 0,
    action_groups: Object.keys(entry.actions || {}),
  };
}

export async function selectors_set_url({ url = null, writeUrl = null, writeToken = null } = {}) {
  for (const u of [url, writeUrl]) {
    if (u && !/^https:\/\//.test(u)) bad('selectors_set_url: https URL required');
  }
  await chrome.storage.local.set({ registryUrl: url });
  if (writeUrl !== null) await chrome.storage.local.set({ registryWriteUrl: writeUrl });
  if (writeToken !== null) await chrome.storage.local.set({ registryWriteToken: writeToken });
  await chrome.storage.local.remove('registryFailure');
  return registryStatus();
}

/** One entry, or one dotted path inside its write selectors. */
export async function selectors_get({ url = null, pageType = null, locale = null, path = null } = {}) {
  if (!url && !pageType) bad('selectors_get: pass a url or a page_type');
  const entry = await resolveEntry({ url, pageType: pageTypeFromKind(pageType), locale });
  if (path) return { path, candidates: sel(entry, path), version: entry.version };
  return { entry };
}

/**
 * Change one selector path on one page type and publish it as a new version.
 * `prepend` (the default) puts the new candidates ahead of the existing ones
 * and keeps the old ones as a fallback — almost always what you want, because
 * it is reversible by doing nothing.
 *
 *   { pageType: 'comments', path: 'composer.submit',
 *     candidates: ['button[aria-label="Post comment"]'] }
 */
export async function selectors_patch({
  url = null, pageType = null, locale = null, path, candidates, prepend = true,
} = {}) {
  if (!path || !Array.isArray(candidates) || !candidates.length) {
    bad('selectors_patch: path and a non-empty candidates array are required');
  }
  if (!url && !pageType) bad('selectors_patch: pass a url or a page_type');

  const entry = await resolveEntry({ url, pageType: pageTypeFromKind(pageType), locale });
  const next = structuredClone(entry);
  next.actions = next.actions || {};

  const keys = String(path).split('.');
  const leaf = keys.pop();
  let node = next.actions;
  for (const k of keys) {
    if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  const before = Array.isArray(node[leaf]) ? node[leaf] : [];
  node[leaf] = prepend
    ? [...candidates, ...before.filter((c) => !candidates.includes(c))]
    : candidates;

  const { registryWriteUrl: writeUrl, registryWriteToken: writeToken } =
    await chrome.storage.local.get(['registryWriteUrl', 'registryWriteToken']);
  const target = writeUrl || (await registryUrl());
  if (!target) bad('selectors_patch: no registry write URL configured');

  const res = await fetch(target.replace(/\/+$/, '') + '/entry', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(writeToken ? { authorization: `Bearer ${writeToken}` } : {}),
    },
    body: JSON.stringify(next),
  });
  if (!res.ok) {
    const e = new Error(`publish failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    e.code = 'PUBLISH_FAILED'; throw e;
  }
  const out = await res.json();

  return {
    page_type: entry.page_type,
    ui_locale: entry.ui_locale,
    path,
    before,
    after: node[leaf],
    version: out.version,
    previous_version: out.previous_version,
    published: true,
  };
}
