// Local test orchestrator — same GET/POST contract as the Lambda, but runs on
// your machine and writes captures straight into tools/captures/ so the AI can
// read the real DOM and fix the extractor. No AWS, no copy-paste.
//
//   node test-server/local-server.mjs         # http://127.0.0.1:8787
//
//   GET  /  -> one hardcoded scrape job (active:true, captureHtml:true)
//   POST /  <- { taskId, status, data, html, steps }  -> tools/captures/latest.*

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const CAP = path.join(repoRoot, 'tools', 'captures');
fs.mkdirSync(CAP, { recursive: true });

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.SHARED_TOKEN || 'smbridge_test_7Kd93PqL2xTn';
const JOB_URL = process.env.JOB_URL
  || 'https://www.linkedin.com/search/results/content/?keywords=webflow&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D&datePosted=%5B%22past-24h%22%5D';
const JOB_KIND = process.env.JOB_KIND || 'linkedin.posts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const auth = req.headers.authorization || '';
  if (TOKEN && auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const taskId = globalThis.crypto?.randomUUID?.() || `t_${Date.now()}`;
    return send(res, 200, {
      tasks: [{ taskId, type: 'social_extract', params: { url: JOB_URL, kind: JOB_KIND, active: true, captureHtml: true } }],
    });
  }

  if (req.method === 'POST') {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch { /* keep {} */ }
      const taskId = body.taskId || 'no-task';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const html = body.html || body?.data?.html || '';
      const meta = { ...body };
      delete meta.html;
      if (meta.data && typeof meta.data === 'object') { meta.data = { ...meta.data }; delete meta.data.html; meta.data.htmlBytes = html.length; }
      const metaStr = JSON.stringify(meta, null, 2);
      fs.writeFileSync(path.join(CAP, 'latest.json'), metaStr);
      fs.writeFileSync(path.join(CAP, `${ts}__${taskId}.json`), metaStr);
      if (html) {
        fs.writeFileSync(path.join(CAP, 'latest.html'), html);
        fs.writeFileSync(path.join(CAP, `${ts}__${taskId}.html`), html);
      }
      const posts = Array.isArray(body?.data?.result?.posts) ? body.data.result.posts.length : null;
      console.log(`[local] POST task=${taskId} status=${body.status} htmlBytes=${html.length} posts=${posts} -> tools/captures/latest.*`);
      send(res, 200, { ok: true, htmlBytes: html.length, posts });
    });
    return;
  }

  send(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local] test orchestrator http://127.0.0.1:${PORT}`);
  console.log(`[local] job: ${JOB_KIND} ${JOB_URL}`);
  console.log('[local] captures -> tools/captures/latest.{html,json}');
});
