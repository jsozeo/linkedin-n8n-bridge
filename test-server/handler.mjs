// Test orchestrator (NOT shipped in the extension). Closed-loop extractor
// auto-heal harness that stands in for n8n during development.
//
//   GET  /               -> current job from s3://<bucket>/job.json, plus an
//                           `extractorUrl` the extension fetches to run the
//                           latest parser WITHOUT reloading the extension.
//   GET  /extractor?kind= -> raw EXTRACT_JS text from s3://<bucket>/extractors/<kind>.js
//                           (no auth: it's just parser code, not secret)
//   POST /               -> { taskId, status, data, html, steps } stored to
//                           s3://<bucket>/runs/<ts>__<taskId>.{html,json} and latest.{html,json}
//
// Deployed as a Lambda Function URL (payload format 2.0). Bearer token on
// GET/POST (except /extractor). State lives in S3 — I flip job.json to advance
// through kinds (posts -> profile -> ...).

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';

const s3 = new S3Client({});
const BUCKET = process.env.CAPTURE_BUCKET;
const TOKEN = process.env.SHARED_TOKEN || '';

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

async function getObjectText(key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await out.Body.transformToString();
  } catch (e) {
    if (e?.name === 'NoSuchKey') return null;
    throw e;
  }
}

async function put(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(raw); } catch { return { _unparsed: raw.slice(0, 500) }; }
}

export const handler = async (event) => {
  const http = event?.requestContext?.http || {};
  const method = http.method || 'GET';
  const path = http.path || '/';
  const headers = event?.headers || {};
  const host = headers.host || headers.Host || '';
  const qs = event?.queryStringParameters || {};

  // Parser code is public (dev-only, not secret) so the extension can fetch it
  // without threading the token through the CDP-injected fetch.
  if (method === 'GET' && path.replace(/\/+$/, '').endsWith('/extractor')) {
    const kind = qs.kind || 'linkedin.posts';
    const jsText = await getObjectText(`extractors/${kind}.js`);
    if (jsText == null) return json(404, { error: `no extractor for kind ${kind}` });
    return { statusCode: 200, headers: { 'content-type': 'application/javascript' }, body: jsText };
  }

  const auth = headers.authorization || headers.Authorization || '';
  if (TOKEN && auth !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });

  if (method === 'GET') {
    const jobRaw = await getObjectText('job.json');
    if (!jobRaw) return json(200, { tasks: [] });
    let job;
    try { job = JSON.parse(jobRaw); } catch { return json(500, { error: 'job.json is not valid JSON' }); }

    // ONE-SHOT model: only serve a job that has been explicitly enqueued
    // (status === 'pending'), and CONSUME it (status -> 'served') so the
    // extension opens the tab exactly once. The agent inspects the capture,
    // fixes the parser, then flips status back to 'pending' to trigger the next
    // single run. This prevents a tab from opening every minute.
    if (job.status !== 'pending') return json(200, { tasks: [] });

    const kind = job.kind || 'linkedin.posts';
    const extractorUrl = host ? `https://${host}/extractor?kind=${encodeURIComponent(kind)}` : undefined;
    const taskId = globalThis.crypto?.randomUUID?.() || `t_${Date.now()}`;
    await put('job.json', JSON.stringify({ ...job, status: 'served', servedAt: Date.now(), lastTaskId: taskId }, null, 2), 'application/json');
    return json(200, {
      tasks: [{
        taskId,
        type: 'social_extract',
        params: {
          url: job.url,
          kind,
          active: job.active !== false,
          captureHtml: job.captureHtml !== false,
          extractorUrl,
        },
      }],
    });
  }

  if (method === 'POST') {
    const body = parseBody(event);
    const taskId = body.taskId || 'no-task';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `runs/${ts}__${taskId}`;

    // HTML may arrive raw (`html`) or gzip+base64 (`htmlGz`, to dodge 413s),
    // either at the top level (error path) or under `data` (success path).
    const gunzipB64 = (b64) => {
      try { return gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'); }
      catch { return ''; }
    };
    let html = body.html || body?.data?.html || '';
    if (!html) {
      const gz = body.htmlGz || body?.data?.htmlGz;
      if (gz) html = gunzipB64(gz);
    }
    const meta = { ...body };
    delete meta.html; delete meta.htmlGz; delete meta.htmlEncoding;
    if (meta.data && typeof meta.data === 'object') {
      meta.data = { ...meta.data };
      delete meta.data.html; delete meta.data.htmlGz; delete meta.data.htmlEncoding;
      meta.data.htmlBytes = html.length;
    }

    const metaStr = JSON.stringify(meta, null, 2);
    await put(`${base}.json`, metaStr, 'application/json');
    await put('latest.json', metaStr, 'application/json');
    if (html) {
      await put(`${base}.html`, html, 'text/html; charset=utf-8');
      await put('latest.html', html, 'text/html; charset=utf-8');
    }
    return json(200, { ok: true, stored: base, htmlBytes: html.length });
  }

  return json(405, { error: `method ${method} not allowed` });
};
