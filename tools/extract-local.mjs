#!/usr/bin/env node
// Local extractor test harness.
//
// Runs an extractor's EXTRACT_JS against a saved HTML snapshot using jsdom —
// no Chrome, no extension reload, no LinkedIn session. Lets us iterate on the
// DOM parsing (selectors, URNs, counts, dedupe shape) in a single command.
//
//   node tools/extract-local.mjs [htmlFile] [--kind linkedin.posts] [--url HREF]
//
// Defaults: htmlFile=posts.html, kind=linkedin.posts, url=<a plausible LinkedIn URL>.
//
// NOTE: jsdom has no layout engine, so `innerText` is aliased to `textContent`
// (no line breaks) and there is NO scrolling. This harness validates the
// per-page extraction logic only — the scroll/merge loop lives in the runner
// (extension/src/commands/social.js) and needs a real browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let htmlFile = 'posts.html';
let kind = 'linkedin.posts';
let url = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--kind') kind = argv[++i];
  else if (a === '--url') url = argv[++i];
  else if (!a.startsWith('--')) htmlFile = a;
}

const KIND_TO_MODULE = {
  'linkedin.posts':         'extension/src/extractors/linkedin/posts.js',
  'linkedin.profile':       'extension/src/extractors/linkedin/profile.js',
  'linkedin.peopleCompany': 'extension/src/extractors/linkedin/peopleCompany.js',
  'linkedin.jobs':          'extension/src/extractors/linkedin/jobs.js',
  'linkedin.comments':      'extension/src/extractors/linkedin/comments.js',
};

const DEFAULT_URL = {
  'linkedin.posts': 'https://www.linkedin.com/search/results/content/?keywords=webflow',
};

const modRel = KIND_TO_MODULE[kind];
if (!modRel) {
  console.error(`Unknown --kind "${kind}". Known: ${Object.keys(KIND_TO_MODULE).join(', ')}`);
  process.exit(1);
}

const htmlPath = path.isAbsolute(htmlFile) ? htmlFile : path.join(repoRoot, htmlFile);
if (!fs.existsSync(htmlPath)) {
  console.error(`HTML file not found: ${htmlPath}`);
  process.exit(1);
}
const html = fs.readFileSync(htmlPath, 'utf8');
const pageUrl = url || DEFAULT_URL[kind] || 'https://www.linkedin.com/';

// ── DOM setup ───────────────────────────────────────────────────────────────
const dom = new JSDOM(html, { url: pageUrl, pretendToBeVisual: true });
const { window } = dom;

// jsdom doesn't implement innerText — extractors rely on it. Alias to
// textContent (good enough for identity/URN/count parsing; loses line breaks).
if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    configurable: true,
  });
}

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.Event = window.Event;

// ── Run the extractor ─────────────────────────────────────────────────────
const mod = await import(pathToFileURL(path.join(repoRoot, modRel)).href);
if (!mod.EXTRACT_JS) {
  console.error(`Module ${modRel} has no EXTRACT_JS export.`);
  process.exit(1);
}

let result;
try {
  // EXTRACT_JS is a self-contained IIFE string that reads globals document/location.
  result = (0, eval)(mod.EXTRACT_JS);
} catch (e) {
  console.error('Extractor threw:', e);
  process.exit(1);
}

// ── Report ──────────────────────────────────────────────────────────────────
const items = Array.isArray(result?.[mod.ITEMS_KEY]) ? result[mod.ITEMS_KEY] : null;
console.error(`\n[extract-local] kind=${kind} file=${path.relative(repoRoot, htmlPath)} url=${pageUrl}`);
if (items) {
  const withUrl = items.filter((p) => p.postUrl).length;
  const withDate = items.filter((p) => p.postEpochMs).length;
  console.error(`[extract-local] items=${items.length}  postUrl set=${withUrl}/${items.length}  epoch set=${withDate}/${items.length}\n`);
}
console.log(JSON.stringify(result, null, 2));
