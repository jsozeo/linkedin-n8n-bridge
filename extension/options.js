// Renders the settings form and persists into chrome.storage.local.
// Storage shape matches extension/src/config.js:
//   { token, clientId, n8n: { pollUrl, resultUrl }, schedule: { enabled, cron } }

import { validateCron, nextRun } from './src/cron.js';

const $ = (id) => document.getElementById(id);

let tokenVisible = false;

function setStatus(msg, kind = '') {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
  if (msg) setTimeout(() => { if (s.textContent === msg) { s.textContent = ''; s.className = 'status'; } }, 5000);
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function loadIntoForm() {
  const cfg = await chrome.storage.local.get(['token', 'clientId', 'n8n', 'schedule']);
  $('token').value = cfg.token || '';
  $('clientId').value = cfg.clientId || '';
  $('pollUrl').value = cfg.n8n?.pollUrl || '';
  $('resultUrl').value = cfg.n8n?.resultUrl || '';
  $('enabled').checked = Boolean(cfg.schedule?.enabled);
  $('cron').value = cfg.schedule?.cron || '*/15 * * * *';
  syncPresetFromCron();
  renderCronInfo();
  await renderDiagnostics();
}

function syncPresetFromCron() {
  const cron = $('cron').value.trim();
  const preset = $('preset');
  const match = Array.from(preset.options).find((o) => o.value === cron);
  preset.value = match ? cron : '';
}

function renderCronInfo() {
  const cron = $('cron').value.trim();
  const info = $('cronInfo');
  if (!cron) { info.textContent = ''; info.className = 'hint'; return; }
  const { valid, error } = validateCron(cron);
  if (!valid) {
    info.textContent = `Invalid cron: ${error}`;
    info.className = 'hint err';
    return;
  }
  const next = nextRun(cron);
  info.textContent = next ? `Next run: ${next.toLocaleString()}` : 'No upcoming run found.';
  info.className = 'hint ok';
}

async function renderDiagnostics() {
  const cfg = await chrome.storage.local.get(null);
  const masked = JSON.parse(JSON.stringify(cfg));
  if (masked.token && !tokenVisible) {
    masked.token = masked.token.slice(0, 4) + '…' + masked.token.slice(-4) + ` (${masked.token.length} chars)`;
  }
  if (typeof masked.nextRunAt === 'number') masked.nextRunAt = new Date(masked.nextRunAt).toLocaleString();
  if (masked.lastRun?.at) masked.lastRun.at = new Date(masked.lastRun.at).toLocaleString();
  const manifest = chrome.runtime.getManifest?.() || {};
  masked._extension = { name: manifest.name, version: manifest.version, id: chrome.runtime.id };
  $('diagnostics').textContent = JSON.stringify(masked, null, 2);
}

function collect() {
  return {
    token: $('token').value.trim(),
    clientId: $('clientId').value.trim() || crypto.randomUUID(),
    n8n: {
      pollUrl: $('pollUrl').value.trim(),
      resultUrl: $('resultUrl').value.trim() || undefined,
    },
    schedule: {
      enabled: $('enabled').checked,
      cron: $('cron').value.trim() || '*/15 * * * *',
    },
  };
}

function validate(v) {
  const errs = [];
  if (!v.token || v.token.length < 16) errs.push('token (≥16 chars)');
  if (!/^https?:\/\/.+/.test(v.n8n.pollUrl)) errs.push('n8n poll URL');
  if (v.n8n.resultUrl && !/^https?:\/\/.+/.test(v.n8n.resultUrl)) errs.push('n8n result URL');
  if (!validateCron(v.schedule.cron).valid) errs.push('cron expression');
  return errs;
}

async function ensureHostPermissions(v) {
  const origins = [originPattern(v.n8n.pollUrl), v.n8n.resultUrl && originPattern(v.n8n.resultUrl)]
    .filter(Boolean);
  if (!origins.length) return true;
  const already = await chrome.permissions.contains({ origins });
  if (already) return true;
  return chrome.permissions.request({ origins });
}

async function save() {
  const next = collect();
  const errs = validate(next);
  if (errs.length) {
    setStatus('Missing/invalid: ' + errs.join(', '), 'err');
    return;
  }

  let granted = true;
  try {
    granted = await ensureHostPermissions(next);
  } catch (e) {
    console.error('permission request failed', e);
    granted = false;
  }
  if (!granted) {
    setStatus('Permission to contact your n8n host was denied — the bridge cannot reach it.', 'err');
    return;
  }

  await chrome.storage.local.set(next);
  try {
    await chrome.runtime.sendMessage({ cmd: 'reschedule' });
  } catch { /* SW may be waking up; storage.onChanged will re-arm it */ }
  setStatus(next.schedule.enabled ? 'Saved ✓ — scheduler armed.' : 'Saved ✓ — scheduler is disabled.', 'ok');
  await renderDiagnostics();
}

async function runNow() {
  const errs = validate(collect());
  if (errs.length) { setStatus('Fix the config first: ' + errs.join(', '), 'err'); return; }
  setStatus('Running…');
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'run-now' });
    const s = res?.summary;
    if (s) setStatus(`Done — ${s.executed} ok, ${s.failed} failed${s.error ? ' · ' + s.error : ''}`, s.error || s.failed ? 'err' : 'ok');
    else setStatus('No response from the service worker.', 'err');
  } catch (e) {
    setStatus('Run failed: ' + (e?.message || e), 'err');
  }
  await renderDiagnostics();
}

function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  $('token').value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  tokenVisible = true;
  $('token').type = 'text';
  setStatus('Token generated — copy it to your n8n side, then Save.', 'ok');
}

function regenClientId() {
  $('clientId').value = crypto.randomUUID();
  setStatus('New client ID generated — click Save to persist.', 'ok');
}

async function clearAll() {
  if (!confirm('Erase all stored settings? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  await loadIntoForm();
  setStatus('Storage cleared.', 'ok');
}

function toggleTokenVisibility() {
  tokenVisible = !tokenVisible;
  $('token').type = tokenVisible ? 'text' : 'password';
  renderDiagnostics();
}

document.addEventListener('DOMContentLoaded', async () => {
  $('save').addEventListener('click', save);
  $('runNow').addEventListener('click', runNow);
  $('reload').addEventListener('click', loadIntoForm);
  $('clear').addEventListener('click', clearAll);
  $('regenClientId').addEventListener('click', regenClientId);
  $('genToken').addEventListener('click', genToken);
  $('toggleTokenVis').addEventListener('click', toggleTokenVisibility);
  $('preset').addEventListener('change', () => {
    if ($('preset').value) { $('cron').value = $('preset').value; renderCronInfo(); }
  });
  $('cron').addEventListener('input', () => { syncPresetFromCron(); renderCronInfo(); });
  await loadIntoForm();
  if (!$('clientId').value) $('clientId').value = crypto.randomUUID();
});

chrome.storage.onChanged.addListener(renderDiagnostics);
