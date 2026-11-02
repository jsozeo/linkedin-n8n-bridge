// Selector registry storage.
//
// An entry is identified by the quad tenant + platform + page_type + ui_locale.
// `tenant` and `platform` are fixed today ("default" / "linkedin") but they sit
// in the key and in the S3 path, so adding a second LinkedIn account or a
// second network later is a value change, not a migration.
//
// Layout
//   registry/<tenant>/<platform>/<page_type>/<locale>/published.json
//   registry/<tenant>/<platform>/<page_type>/<locale>/versions/<version>.json
//   registry/<tenant>/<platform>/_index.json
//
// Version objects are immutable; publishing writes a new one and then rewrites
// published.json with the SAME content. The duplication is deliberate: a job
// resolves its entry in a single GET instead of reading a pointer and then the
// object it points at.
//
// Reads are public — these are CSS selectors, not secrets, and the extension
// fetches one on every job. Writes carry the shared token.

import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const DEFAULT_TENANT = 'default';
const DEFAULT_PLATFORM = 'linkedin';

const json = (statusCode, obj, extraHeaders = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: JSON.stringify(obj),
});

const NO_STORE = { 'cache-control': 'no-store' };

/** `a/b` in the key, `a-b` in a version id: keep both filesystem-safe. */
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');

function entryPrefix({ tenant, platform, pageType, locale }) {
  return `registry/${slug(tenant)}/${slug(platform)}/${slug(pageType)}/${slug(locale)}`;
}

function indexKey({ tenant, platform }) {
  return `registry/${slug(tenant)}/${slug(platform)}/_index.json`;
}

/**
 * `https://www.linkedin.com/posts/*` style patterns. Only `*` is special, so a
 * pattern cannot smuggle in a regex — these come from the registry, which the
 * AI chat writes to.
 */
function patternToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAny(url, patterns) {
  return (patterns || []).some((p) => {
    try { return patternToRegExp(p).test(url); } catch { return false; }
  });
}

/**
 * An entry matches a URL either through its glob patterns or through the exact
 * regex the bundled extractor used. Keeping the regex means the move to the
 * cloud cannot change which page resolves to which extractor.
 */
function entryMatchesUrl(entry, url) {
  if (matchesAny(url, entry.url_patterns)) return true;
  if (entry.url_regex) {
    try { return new RegExp(entry.url_regex, 'i').test(url); } catch { return false; }
  }
  return false;
}

/**
 * Exact locale first, then an entry that declares itself locale-independent.
 * The extractors match headings by accent-stripped text and genuinely behave
 * the same in every interface language, so forcing a copy per locale would
 * create duplicates that always drift apart. `any` is a declaration in the
 * document, never a silent guess.
 */
const LOCALE_ANY = 'any';

function pickByLocale(entries, locale) {
  return entries.find((e) => e.ui_locale === locale)
      || entries.find((e) => e.ui_locale === LOCALE_ANY)
      || null;
}

function newVersion() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

// --- storage helpers --------------------------------------------------------

async function readJson(s3, bucket, key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await out.Body.transformToString());
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.name === 'NotFound') return null;
    throw e;
  }
}

async function writeJson(s3, bucket, key, obj) {
  const body = JSON.stringify(obj, null, 2);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: 'application/json',
  }));
  return body.length;
}

/**
 * Rebuilt from the objects themselves rather than patched in place, so a failed
 * publish can never leave the index describing something that is not there.
 */
async function rebuildIndex(s3, bucket, { tenant, platform }) {
  const prefix = `registry/${slug(tenant)}/${slug(platform)}/`;
  const entries = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const obj of page.Contents || []) {
      if (!obj.Key.endsWith('/published.json')) continue;
      const doc = await readJson(s3, bucket, obj.Key);
      if (!doc) continue;
      entries.push({
        tenant: doc.tenant, platform: doc.platform,
        page_type: doc.page_type, ui_locale: doc.ui_locale,
        priority: Number.isFinite(doc.priority) ? doc.priority : 999,
        version: doc.version, published_at: doc.published_at,
        url_patterns: doc.url_patterns || [],
        url_regex: doc.extractor?.url_regex || null,
        field_count: (doc.fields || []).length,
        action_count: Object.keys(doc.actions || {}).length,
        has_extractor: Boolean(doc.extractor?.extract_js),
        extract_js_bytes: doc.extractor?.extract_js?.length || 0,
        step_keys: doc.extractor?.step_keys || [],
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  // Resolution order, not display order: overlapping URL patterns are settled
  // by priority exactly as the bundle settled them by declaration order.
  entries.sort((a, b) => (a.priority - b.priority)
    || `${a.page_type}/${a.ui_locale}`.localeCompare(`${b.page_type}/${b.ui_locale}`));
  await writeJson(s3, bucket, indexKey({ tenant, platform }), { updated_at: new Date().toISOString(), entries });
  return entries;
}

// --- shape checks -----------------------------------------------------------
//
// These validate the SHAPE of a document being published. They say nothing
// about whether the selectors inside it match anything on a page — that is
// observation, reported elsewhere, never judged here.

function shapeErrors(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['body is not an object'];
  if (!doc.page_type) errs.push('page_type is required');
  if (!doc.ui_locale) errs.push('ui_locale is required');
  if (doc.url_patterns && !Array.isArray(doc.url_patterns)) errs.push('url_patterns must be an array');
  if (doc.fields && !Array.isArray(doc.fields)) errs.push('fields must be an array');
  if (doc.actions && (typeof doc.actions !== 'object' || Array.isArray(doc.actions))) {
    errs.push('actions must be an object');
  }
  for (const f of doc.fields || []) {
    if (!f?.name) errs.push('every field needs a name');
    if (!f?.selector) errs.push(`field "${f?.name || '?'}" needs a selector`);
  }

  const x = doc.extractor;
  if (x !== undefined && x !== null) {
    if (typeof x !== 'object' || Array.isArray(x)) {
      errs.push('extractor must be an object');
    } else {
      if (!x.extract_js || typeof x.extract_js !== 'string') errs.push('extractor.extract_js must be a non-empty string');
      if (x.url_regex && !regexCompiles(x.url_regex)) errs.push(`extractor.url_regex does not compile: ${x.url_regex}`);
      if (x.wait_selectors && !Array.isArray(x.wait_selectors)) errs.push('extractor.wait_selectors must be an array');
      if (x.step_keys && !Array.isArray(x.step_keys)) errs.push('extractor.step_keys must be an array');
      if (x.scroll && typeof x.scroll !== 'object') errs.push('extractor.scroll must be an object');
      if (x.normalize_url && !normalizeShapeOk(x.normalize_url)) errs.push('extractor.normalize_url is malformed');
      for (const rule of x.scroll_rules || []) {
        if (!rule?.when_url_matches || !regexCompiles(rule.when_url_matches)) {
          errs.push('every scroll_rules entry needs a compilable when_url_matches');
        }
      }
    }
  }
  return errs;
}

function regexCompiles(source) {
  try { new RegExp(source); return true; } catch { return false; }
}

/**
 * The seven normalizeUrl() functions in the bundle are all "match a path, write
 * another path, maybe set a query param", so they survive the move as data.
 */
function normalizeShapeOk(n) {
  if (typeof n !== 'object' || Array.isArray(n)) return false;
  if (n.replace_with) return typeof n.replace_with === 'string';
  if (!n.match || !regexCompiles(n.match)) return false;
  if (typeof n.pathname !== 'string') return false;
  if (n.search_params && (typeof n.search_params !== 'object' || Array.isArray(n.search_params))) return false;
  return true;
}

// --- routes -----------------------------------------------------------------

/**
 * Returns null when the path is not ours, so the caller falls through to the
 * rest of the orchestrator.
 *
 *   GET  /registry/entry?page_type=&locale=    exact key
 *   GET  /registry/entry?url=&locale=          resolved from url_patterns
 *   GET  /registry/index                       everything published
 *   GET  /registry/versions?page_type=&locale= version history for one key
 *   POST /registry/entry                       publish (token enforced upstream)
 */
export async function registryRoute({ s3, bucket, method, path, qs, body, authorized }) {
  const clean = path.replace(/\/+$/, '');
  if (!clean.includes('/registry')) return null;

  const tenant = qs.tenant || body?.tenant || DEFAULT_TENANT;
  const platform = qs.platform || body?.platform || DEFAULT_PLATFORM;

  if (method === 'GET' && clean.endsWith('/registry/index')) {
    const idx = await readJson(s3, bucket, indexKey({ tenant, platform }));
    return json(200, idx || { updated_at: null, entries: [] }, NO_STORE);
  }

  if (method === 'GET' && clean.endsWith('/registry/versions')) {
    if (!authorized) return json(401, { error: 'unauthorized' });
    const { page_type: pageType, locale } = qs;
    if (!pageType || !locale) return json(400, { error: 'page_type and locale are required' });

    // Resolve the locale the way /entry does, otherwise asking for `en` on a
    // locale-independent entry returns an empty history instead of saying so.
    const idx = await readJson(s3, bucket, indexKey({ tenant, platform }));
    const hit = pickByLocale((idx?.entries || []).filter((e) => e.page_type === pageType), locale);
    if (!hit) {
      return json(404, {
        error: 'no entry for this page type in this locale',
        page_type: pageType, ui_locale: locale,
        known: (idx?.entries || []).map((e) => `${e.page_type}/${e.ui_locale}`),
      }, NO_STORE);
    }
    const prefix = `${entryPrefix({ tenant, platform, pageType, locale: hit.ui_locale })}/versions/`;
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const versions = (out.Contents || [])
      .map((o) => ({ version: o.Key.slice(prefix.length).replace(/\.json$/, ''), bytes: o.Size, at: o.LastModified }))
      .sort((a, b) => String(b.version).localeCompare(String(a.version)));
    return json(200, {
      tenant, platform, page_type: pageType,
      ui_locale: hit.ui_locale, requested_locale: locale,
      published: hit.version, versions,
    }, NO_STORE);
  }

  if (method === 'GET' && clean.endsWith('/registry/entry')) {
    const locale = qs.locale;
    if (!locale) return json(400, { error: 'locale is required — read it from the page, not from the browser' });

    const idx = await readJson(s3, bucket, indexKey({ tenant, platform }));
    const known = idx?.entries || [];
    let pageType = qs.page_type;
    let resolvedLocale = locale;

    if (pageType) {
      const hit = pickByLocale(known.filter((e) => e.page_type === pageType), locale);
      if (hit) resolvedLocale = hit.ui_locale;
    } else {
      if (!qs.url) return json(400, { error: 'pass either page_type or url' });
      // The index is already in priority order, so the first URL match wins
      // the same tie the bundle used to win.
      const candidates = known.filter((e) => entryMatchesUrl(e, qs.url));
      const hit = pickByLocale(candidates, locale);
      if (!hit) {
        return json(404, {
          error: 'no registry entry matches this URL in this locale',
          url: qs.url, ui_locale: locale,
          known: known.map((e) => `${e.page_type}/${e.ui_locale}`),
        }, NO_STORE);
      }
      pageType = hit.page_type;
      resolvedLocale = hit.ui_locale;
    }

    const doc = await readJson(
      s3, bucket,
      `${entryPrefix({ tenant, platform, pageType, locale: resolvedLocale })}/published.json`,
    );
    if (!doc) {
      return json(404, {
        error: 'no published entry for this key',
        key: { tenant, platform, page_type: pageType, ui_locale: locale },
        known: known.map((e) => `${e.page_type}/${e.ui_locale}`),
      }, NO_STORE);
    }
    return json(200, { ...doc, requested_locale: locale }, NO_STORE);
  }

  if (method === 'POST' && clean.endsWith('/registry/entry')) {
    if (!authorized) return json(401, { error: 'unauthorized' });
    const errs = shapeErrors(body);
    if (errs.length) return json(400, { error: 'invalid entry', problems: errs });

    const pageType = body.page_type;
    const locale = body.ui_locale;
    const prefix = entryPrefix({ tenant, platform, pageType, locale });
    const previous = await readJson(s3, bucket, `${prefix}/published.json`);

    const now = new Date().toISOString();
    const version = newVersion();
    const doc = {
      tenant, platform,
      page_type: pageType,
      ui_locale: locale,
      version,
      created_at: previous?.created_at || now,
      updated_at: now,
      published_at: now,
      previous_version: previous?.version || null,
      priority: Number.isFinite(body.priority) ? body.priority : (previous?.priority ?? 999),
      url_patterns: body.url_patterns || previous?.url_patterns || [],
      fields: body.fields || [],
      actions: body.actions || {},
      extractor: body.extractor || null,
      note: body.note || null,
    };

    const bytes = await writeJson(s3, bucket, `${prefix}/versions/${version}.json`, doc);
    await writeJson(s3, bucket, `${prefix}/published.json`, doc);
    const entries = await rebuildIndex(s3, bucket, { tenant, platform });

    return json(200, {
      ok: true,
      key: { tenant, platform, page_type: pageType, ui_locale: locale },
      version,
      previous_version: doc.previous_version,
      bytes,
      entries_known: entries.length,
    });
  }

  return null;
}
