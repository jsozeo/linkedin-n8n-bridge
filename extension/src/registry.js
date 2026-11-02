// Cloud registry client.
//
// Everything the extension knows about LinkedIn — extractor sources, wait
// conditions, scroll plans, URL patterns and write selectors — lives in object
// storage and is fetched at job time. The bundle carries none of it, which is
// the whole point: a selector fix must never require reloading the extension
// on the machine that holds the session.
//
// An entry is keyed by tenant + platform + page_type + ui_locale. The first two
// are fixed today and the fourth is read from the page, never from the browser.
//
// There is deliberately NO cache and NO bundled fallback. A stale selector that
// silently half-works is worse than a job that stops and says so.

import { evalInPage } from './cdp.js';

// Where the registry lives. This is infrastructure, not business logic: the
// address of the shelf belongs in the build, what sits on the shelf does not.
// Overridable from the side panel for a staging endpoint.
export const DEFAULT_REGISTRY_URL = 'https://l75fzlo5pc.execute-api.eu-west-3.amazonaws.com/registry';

const URL_KEY = 'registryUrl';
const LOCALE_KEY = 'uiLocale';
const FAILURE_KEY = 'registryFailure';
const TIMEOUT_MS = 10_000;

/** `<html lang>` is what LinkedIn sets from the account's interface language. */
const DETECT_LOCALE_JS = `(() => {
  const raw = document.documentElement.getAttribute('lang') || '';
  return raw.split('-')[0].toLowerCase() || null;
})()`;

function fail(message, code, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export async function registryUrl() {
  const { [URL_KEY]: url } = await chrome.storage.local.get([URL_KEY]);
  return url || DEFAULT_REGISTRY_URL;
}

/** Whether the endpoint in use was overridden, which the status line reports. */
export async function registryUrlIsOverridden() {
  const { [URL_KEY]: url } = await chrome.storage.local.get([URL_KEY]);
  return Boolean(url) && url !== DEFAULT_REGISTRY_URL;
}

/**
 * Counted rather than notified per occurrence: a storage outage would otherwise
 * fire one alert per job. The count is what the notifier reads.
 */
async function noteFailure(reason) {
  const { [FAILURE_KEY]: prev } = await chrome.storage.local.get([FAILURE_KEY]);
  const now = Date.now();
  const rec = prev && now - prev.lastAt < 60 * 60 * 1000
    ? { ...prev, count: prev.count + 1, lastAt: now, reason }
    : { count: 1, firstAt: now, lastAt: now, reason };
  await chrome.storage.local.set({ [FAILURE_KEY]: rec });
  return rec;
}

async function clearFailures() {
  const { [FAILURE_KEY]: prev } = await chrome.storage.local.get([FAILURE_KEY]);
  if (prev) await chrome.storage.local.remove(FAILURE_KEY);
}

export async function failureState() {
  const { [FAILURE_KEY]: rec } = await chrome.storage.local.get([FAILURE_KEY]);
  return rec || null;
}

/**
 * The interface language of the page in front of us. Stored so the next job can
 * ask for the right entry before the tab exists, and re-read on every page so a
 * language change corrects itself.
 */
export async function detectLocale(tabId) {
  try {
    const locale = await evalInPage(tabId, DETECT_LOCALE_JS);
    if (locale) {
      await chrome.storage.local.set({ [LOCALE_KEY]: locale });
      return locale;
    }
  } catch { /* page not ready; fall through to the remembered one */ }
  return lastKnownLocale();
}

export async function lastKnownLocale() {
  const { [LOCALE_KEY]: locale } = await chrome.storage.local.get([LOCALE_KEY]);
  return locale || 'en';
}

/**
 * One GET, every time. Resolution by URL happens server-side so a job never
 * needs a second round trip to turn a URL into a page type.
 */
export async function resolveEntry({ url = null, pageType = null, locale = null } = {}) {
  const base = await registryUrl();
  const loc = locale || (await lastKnownLocale());
  const endpoint = new URL(base.replace(/\/+$/, '') + '/entry');
  endpoint.searchParams.set('locale', loc);
  if (pageType) endpoint.searchParams.set('page_type', pageType);
  else if (url) endpoint.searchParams.set('url', url);
  else throw fail('resolveEntry needs a url or a page_type', 'BAD_PARAMS');

  let res;
  try {
    res = await fetch(endpoint.toString(), { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const rec = await noteFailure(e.message);
    throw fail(
      `the selector registry is unreachable (${e.message}) — the job stops here rather than running on guesses`,
      'REGISTRY_UNAVAILABLE',
      { failures: rec.count },
    );
  }

  if (res.status === 404) {
    const body = await res.json().catch(() => ({}));
    throw fail(
      `nothing published for ${pageType || url} in locale ${loc}${body.known ? ` — known: ${body.known.join(', ')}` : ''}`,
      'REGISTRY_MISS',
      { known: body.known || [] },
    );
  }
  if (!res.ok) {
    const rec = await noteFailure(`HTTP ${res.status}`);
    throw fail(`the selector registry answered HTTP ${res.status}`, 'REGISTRY_UNAVAILABLE', { failures: rec.count });
  }

  const entry = await res.json();
  if (!entry?.page_type) throw fail('the registry returned something that is not an entry', 'REGISTRY_MALFORMED');
  await clearFailures();
  return entry;
}

// --- reading an entry -------------------------------------------------------

/**
 * Candidate list for a dotted path inside the entry's write selectors, e.g.
 * sel(entry, 'composer.submit'). Always an array, so callers can loop without
 * a null check — an empty one simply means nothing is declared, which the
 * caller reports rather than judges.
 */
export function sel(entry, path) {
  const found = String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), entry?.actions);
  if (typeof found === 'string') return [found];
  return Array.isArray(found) ? found : [];
}

/** The declarative replacement for the seven normalizeUrl() functions. */
export function normalizeUrl(entry, url) {
  const rule = entry?.extractor?.normalize_url;
  if (!rule) return url;
  if (rule.replace_with) return rule.replace_with;
  try {
    const u = new URL(url);
    const m = u.pathname.match(new RegExp(rule.match, 'i'));
    if (!m) return url;
    u.pathname = String(rule.pathname).replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '');
    for (const [k, v] of Object.entries(rule.search_params || {})) {
      if (!u.searchParams.get(k)) u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** The declarative replacement for pickScroll(). */
export function pickScroll(entry, url) {
  const x = entry?.extractor;
  for (const rule of x?.scroll_rules || []) {
    try { if (new RegExp(rule.when_url_matches, 'i').test(url)) return rule.scroll; } catch { /* next */ }
  }
  return x?.scroll || null;
}

/**
 * The shape social_extract used to get from a bundled module. Built from the
 * entry so the runner did not have to learn a new vocabulary.
 */
export function skillFromEntry(entry, url) {
  const x = entry?.extractor;
  if (!x?.extract_js) {
    throw fail(`the registry entry for ${entry?.page_type} carries no extractor`, 'REGISTRY_MISS');
  }
  return {
    ID: x.skill_id || `${entry.platform}.${entry.page_type}`,
    STEP_KEYS: x.step_keys || [],
    WAIT_SELECTORS: x.wait_selectors || [],
    WAIT_PREDICATE_JS: x.wait_predicate_js || undefined,
    SCROLL: pickScroll(entry, url),
    AWAIT_PROMISE: Boolean(x.await_promise),
    ITEMS_KEY: x.items_key || undefined,
    EXTRACT_JS: x.extract_js,
    normalizedUrl: normalizeUrl(entry, url),
    version: entry.version,
    pageType: entry.page_type,
    uiLocale: entry.ui_locale,
  };
}

/**
 * Callers still speak the old vocabulary: a full skill id ('linkedin.profile'),
 * a bare camelCase type ('companyPosts'), or nothing at all.
 */
export function pageTypeFromKind(kind) {
  if (!kind) return null;
  const bare = String(kind).includes('.') ? String(kind).split('.').slice(1).join('.') : String(kind);
  return bare.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export async function registryStatus() {
  const base = await registryUrl();
  const out = {
    url: base,
    overridden: await registryUrlIsOverridden(),
    uiLocale: await lastKnownLocale(),
    failures: await failureState(),
    entries: [],
  };
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/index', {
      cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const idx = await res.json();
    out.entries = idx.entries || [];
    out.updatedAt = idx.updated_at || null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
