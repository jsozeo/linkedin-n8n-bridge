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
        version: doc.version, published_at: doc.published_at,
        url_patterns: doc.url_patterns || [],
        field_count: (doc.fields || []).length,
        action_count: Object.keys(doc.actions || {}).length,
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  entries.sort((a, b) => `${a.page_type}/${a.ui_locale}`.localeCompare(`${b.page_type}/${b.ui_locale}`));
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
  const js = JSON.stringify(doc);
  if (/"\s*javascript:|<script\b/i.test(js)) errs.push('the document must not carry script payloads');
  return errs;
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
    const prefix = `${entryPrefix({ tenant, platform, pageType, locale })}/versions/`;
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const versions = (out.Contents || [])
      .map((o) => ({ version: o.Key.slice(prefix.length).replace(/\.json$/, ''), bytes: o.Size, at: o.LastModified }))
      .sort((a, b) => String(b.version).localeCompare(String(a.version)));
    return json(200, { tenant, platform, page_type: pageType, ui_locale: locale, versions }, NO_STORE);
  }

  if (method === 'GET' && clean.endsWith('/registry/entry')) {
    const locale = qs.locale;
    if (!locale) return json(400, { error: 'locale is required — read it from the page, not from the browser' });

    let pageType = qs.page_type;
    if (!pageType) {
      if (!qs.url) return json(400, { error: 'pass either page_type or url' });
      const idx = await readJson(s3, bucket, indexKey({ tenant, platform }));
      const hit = (idx?.entries || []).find(
        (e) => e.ui_locale === locale && matchesAny(qs.url, e.url_patterns),
      );
      if (!hit) {
        return json(404, {
          error: 'no registry entry matches this URL in this locale',
          url: qs.url, ui_locale: locale,
          known: (idx?.entries || []).map((e) => `${e.page_type}/${e.ui_locale}`),
        }, NO_STORE);
      }
      pageType = hit.page_type;
    }

    const doc = await readJson(s3, bucket, `${entryPrefix({ tenant, platform, pageType, locale })}/published.json`);
    if (!doc) {
      return json(404, {
        error: 'no published entry for this key',
        key: { tenant, platform, page_type: pageType, ui_locale: locale },
      }, NO_STORE);
    }
    return json(200, doc, NO_STORE);
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
      url_patterns: body.url_patterns || previous?.url_patterns || [],
      fields: body.fields || [],
      actions: body.actions || {},
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
