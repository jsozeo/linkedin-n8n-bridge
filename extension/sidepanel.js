// Side panel = the extension's home. Holds the settings form (persisted to
// chrome.storage.local) plus a manual runner that fires a single command
// against a LinkedIn URL so you can see the bridge work end-to-end.

import { validateCron, nextRun } from './src/cron.js';

const $ = (id) => document.getElementById(id);

let tokenVisible = false;

function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
  if (msg && kind) setTimeout(() => { if (el.textContent === msg) { el.textContent = ''; el.className = 'status'; } }, 6000);
}

function originPattern(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}/*`; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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
  if (!valid) { info.textContent = `Invalid cron: ${error}`; info.className = 'hint err'; return; }
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
    schedule: { enabled: $('enabled').checked, cron: $('cron').value.trim() || '*/15 * * * *' },
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
  const origins = [originPattern(v.n8n.pollUrl), v.n8n.resultUrl && originPattern(v.n8n.resultUrl)].filter(Boolean);
  if (!origins.length) return true;
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function save() {
  const next = collect();
  const errs = validate(next);
  if (errs.length) { setStatus($('status'), 'Missing/invalid: ' + errs.join(', '), 'err'); return; }

  let granted = true;
  try { granted = await ensureHostPermissions(next); }
  catch (e) { console.error(e); granted = false; }
  if (!granted) { setStatus($('status'), 'Permission to contact your n8n host was denied.', 'err'); return; }

  await chrome.storage.local.set(next);
  try { await chrome.runtime.sendMessage({ cmd: 'reschedule' }); } catch { /* SW waking */ }
  setStatus($('status'), next.schedule.enabled ? 'Saved ✓ — scheduler armed.' : 'Saved ✓ — scheduler off.', 'ok');
  await renderDiagnostics();
}

async function runNow() {
  const errs = validate(collect());
  if (errs.length) { setStatus($('status'), 'Fix config first: ' + errs.join(', '), 'err'); return; }
  setStatus($('status'), 'Running…');
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'run-now' });
    const s = res?.summary;
    if (s) setStatus($('status'), `Done — ${s.executed} ok, ${s.failed} failed${s.error ? ' · ' + s.error : ''}`, s.error || s.failed ? 'err' : 'ok');
    else setStatus($('status'), 'No response from the service worker.', 'err');
  } catch (e) {
    setStatus($('status'), 'Run failed: ' + (e?.message || e), 'err');
  }
  await renderDiagnostics();
}

function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  $('token').value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  tokenVisible = true; $('token').type = 'text';
  setStatus($('status'), 'Token generated — copy it to n8n, then Save.', 'ok');
}

function regenClientId() {
  $('clientId').value = crypto.randomUUID();
  setStatus($('status'), 'New client ID — click Save to persist.', 'ok');
}

async function clearAll() {
  if (!confirm('Erase all stored settings? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  await loadIntoForm();
  setStatus($('status'), 'Storage cleared.', 'ok');
}

function toggleTokenVisibility() {
  tokenVisible = !tokenVisible;
  $('token').type = tokenVisible ? 'text' : 'password';
  renderDiagnostics();
}

// ---------------------------------------------------------------------------
// Manual run
// ---------------------------------------------------------------------------

function buildManualTask() {
  const url = $('manualUrl').value.trim();
  const action = $('manualAction').value;
  const active = $('manualActive').checked;
  if (!/^https?:\/\/.+/.test(url)) return { error: 'Enter a valid http(s) URL.' };

  if (action === 'open') return { task: { type: 'open_tab', params: { url, active: true } } };
  const params = { url, active };
  if (action !== 'auto') params.kind = action;
  return { task: { type: 'linkedin_extract', params } };
}

function renderSteps(steps) {
  const box = $('manualSteps');
  box.innerHTML = '';
  if (!Array.isArray(steps) || !steps.length) return;
  for (const s of steps) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (/fail/i.test(s.label) ? ' bad' : '');
    chip.textContent = s.label;
    box.appendChild(chip);
  }
}

async function manualRun() {
  const built = buildManualTask();
  if (built.error) { setStatus($('manualStatus'), built.error, 'err'); return; }

  const btn = $('manualRun');
  btn.disabled = true;
  setStatus($('manualStatus'), 'Running… (this can take ~15–30s)');
  $('manualResult').hidden = true;
  $('manualSteps').innerHTML = '';
  $('manualJson').textContent = '';

  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'manual-run', ...built.task });
    $('manualResult').hidden = false;
    if (res?.ok) {
      const data = res.data || {};
      renderSteps(data.steps);
      const payload = 'result' in data ? data.result : data;
      $('manualJson').textContent = JSON.stringify(payload, null, 2);
      const label = data.skillId ? `${data.skillId} · ` : '';
      setStatus($('manualStatus'), `${label}done in ${res.durationMs} ms`, 'ok');
    } else {
      const err = res?.error || { message: 'no response' };
      $('manualJson').textContent = JSON.stringify(res, null, 2);
      setStatus($('manualStatus'), `Failed: ${err.message} (${err.code || 'ERR'})`, 'err');
    }
  } catch (e) {
    setStatus($('manualStatus'), 'Run failed: ' + (e?.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  $('save').addEventListener('click', save);
  $('runNow').addEventListener('click', runNow);
  $('clear').addEventListener('click', clearAll);
  $('regenClientId').addEventListener('click', regenClientId);
  $('genToken').addEventListener('click', genToken);
  $('toggleTokenVis').addEventListener('click', toggleTokenVisibility);
  $('preset').addEventListener('change', () => {
    if ($('preset').value) { $('cron').value = $('preset').value; renderCronInfo(); }
  });
  $('cron').addEventListener('input', () => { syncPresetFromCron(); renderCronInfo(); });
  $('manualRun').addEventListener('click', manualRun);

  await loadIntoForm();
  if (!$('clientId').value) $('clientId').value = crypto.randomUUID();
});

chrome.storage.onChanged.addListener(renderDiagnostics);
