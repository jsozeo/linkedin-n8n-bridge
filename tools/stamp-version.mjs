#!/usr/bin/env node
// Stamps the manifest so a loaded extension can say exactly which build it is.
//
//   node tools/stamp-version.mjs            bump the patch number
//   node tools/stamp-version.mjs 1.2.0      set an explicit version
//   node tools/stamp-version.mjs --same     keep the version, refresh the stamp
//
// version_name carries the commit, so comparing what the side panel shows with
// `git log -1 --format=%h` tells you whether Chrome is running your latest edits.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const arg = process.argv[2];
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const current = manifest.version || '0.0.0';

let version = current;
if (arg && arg !== '--same') {
  if (!/^\d+(\.\d+){0,3}$/.test(arg)) {
    console.error(`"${arg}" is not a Chrome version number (1 to 4 dot-separated integers).`);
    process.exit(1);
  }
  version = arg;
} else if (!arg) {
  const parts = current.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  parts[parts.length - 1] += 1;
  version = parts.join('.');
}

const sha = git('rev-parse', '--short', 'HEAD') || 'nogit';
const dirty = git('status', '--porcelain') ? '+local' : '';
const stampedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

manifest.version = version;
manifest.version_name = `${version} · ${sha}${dirty} · ${stampedAt}`;

// Keep version_name right after version instead of wherever a re-serialise lands it.
const ordered = {};
for (const key of Object.keys(manifest)) {
  if (key === 'version_name') continue;
  ordered[key] = manifest[key];
  if (key === 'version') ordered.version_name = manifest.version_name;
}

writeFileSync(manifestPath, `${JSON.stringify(ordered, null, 2)}\n`);
console.log(manifest.version_name);
if (dirty) console.log('working tree is dirty — the stamp says +local so you know the commit is not the whole story');
