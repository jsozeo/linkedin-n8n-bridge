// Side panel = the extension's home. Holds the settings form (persisted to
// chrome.storage.local) plus a manual runner that fires a single extraction
// against a URL so you can see the bridge work end-to-end.

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
// Cron builder  (controls ⇄ cron string; the #cron field is the source of truth)
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
let cronReflecting = false;

function populateHourSelects() {
  for (const id of ['bFrom', 'bTo']) {
    const sel = $(id);
    sel.innerHTML = '';
    for (let h = 0; h < 24; h += 1) {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = `${pad2(h)}:00`;
      sel.appendChild(o);
    }
  }
  $('bFrom').value = '9';
  $('bTo').value = '18';
}

function dayInputs() {
  return Array.from(document.querySelectorAll('#bDays input[type="checkbox"]'));
}

function selectedDays() {
  return dayInputs().filter((i) => i.checked).map((i) => Number(i.value)).sort((a, b) => a - b);
}

// Compress a sorted list of day numbers into a cron dow field ("1,2,3,4,5" → "1-5").
function compressDow(days) {
  if (!days.length || days.length === 7) return '*';
  const parts = [];
  let start = days[0];
  let prev = days[0];
  for (let i = 1; i <= days.length; i += 1) {
    const cur = days[i];
    if (cur === prev + 1) { prev = cur; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur; prev = cur;
  }
  return parts.join(',');
}

function buildCronFromBuilder() {
  const freq = $('bFreq').value;
  const allDay = $('bAllDay').checked;
  const from = Number($('bFrom').value);
  const to = Number($('bTo').value);
  const dow = compressDow(selectedDays());

  let minute;
  let hour;
  if (freq === 'once') {
    minute = '0';
    hour = String(from);
  } else if (freq === '60') {
    minute = '0';
    hour = allDay ? '*' : (from === to ? String(from) : `${Math.min(from, to)}-${Math.max(from, to)}`);
  } else {
    minute = `*/${freq}`;
    hour = allDay ? '*' : (from === to ? String(from) : `${Math.min(from, to)}-${Math.max(from, to)}`);
  }
  return `${minute} ${hour} * * ${dow}`;
}

function reflectToBuilder(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return;
  const [m, h] = parts;
  const dow = parts[4];
  cronReflecting = true;
  try {
    // Frequency + minute
    const stepM = m.match(/^\*\/(\d+)$/);
    const singleHour = /^\d+$/.test(h);
    if (stepM && ['5', '10', '15', '30'].includes(stepM[1])) {
      $('bFreq').value = stepM[1];
    } else if (m === '0') {
      $('bFreq').value = singleHour ? 'once' : '60';
    }

    // Hours
    if (h === '*') {
      $('bAllDay').checked = true;
    } else {
      $('bAllDay').checked = false;
      const range = h.match(/^(\d+)-(\d+)$/);
      if (range) { $('bFrom').value = range[1]; $('bTo').value = range[2]; }
      else if (singleHour) { $('bFrom').value = h; $('bTo').value = h; }
    }

    // Days
    const set = new Set();
    if (dow === '*') { /* leave all unchecked = every day */ }
    else {
      for (const term of dow.split(',')) {
        const r = term.match(/^(\d+)-(\d+)$/);
        if (r) { for (let d = Number(r[1]); d <= Number(r[2]); d += 1) set.add(d % 7); }
        else if (/^\d+$/.test(term)) set.add(Number(term) % 7);
      }
    }
    for (const input of dayInputs()) input.checked = set.has(Number(input.value));
  } finally {
    cronReflecting = false;
  }
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

function setCronField(str, { reflect = true } = {}) {
  $('cron').value = str;
  syncPresetFromCron();
  if (reflect) reflectToBuilder(str);
  renderCronInfo();
}

function onBuilderChanged() {
  if (cronReflecting) return;
  setCronField(buildCronFromBuilder(), { reflect: false });
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
  setCronField(cfg.schedule?.cron || '* * * * *', { reflect: true });
  await renderDiagnostics();
  await renderStatus();
}

function collect() {
  return {
    token: $('token').value.trim(),
    clientId: $('clientId').value.trim() || crypto.randomUUID(),
    n8n: {
      pollUrl: $('pollUrl').value.trim(),
      resultUrl: $('resultUrl').value.trim() || undefined,
    },
    schedule: { enabled: $('enabled').checked, cron: $('cron').value.trim() || '*/15 9-18 * * 1-5' },
  };
}

function validate(v) {
  const errs = [];
  if (!v.token || v.token.length < 16) errs.push('token (≥16 chars)');
  if (!/^https?:\/\/.+/.test(v.n8n.pollUrl)) errs.push('poll URL');
  if (v.n8n.resultUrl && !/^https?:\/\/.+/.test(v.n8n.resultUrl)) errs.push('result URL');
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
  if (!granted) { setStatus($('status'), 'Permission to contact your automation host was denied.', 'err'); return; }

  await chrome.storage.local.set(next);
  try { await chrome.runtime.sendMessage({ cmd: 'reschedule' }); } catch { /* SW waking */ }
  setStatus($('status'), next.schedule.enabled ? 'Saved ✓ — scheduler armed.' : 'Saved ✓ — scheduler off.', 'ok');
  await renderDiagnostics();
  setTimeout(renderStatus, 300);
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
  await renderStatus();
}

function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  $('token').value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  tokenVisible = true; $('token').type = 'text';
  setStatus($('status'), 'Token generated — copy it to your automation tool, then Save.', 'ok');
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
// Status
// ---------------------------------------------------------------------------

async function renderStatus() {
  const box = $('statusSummary');
  const stored = await chrome.storage.local.get(['schedule', 'nextRunAt', 'lastRun', 'scheduleError']);

  // Ask the service worker for its authoritative view (falls back to storage).
  let live = null;
  try { live = await chrome.runtime.sendMessage({ cmd: 'status' }); } catch { /* SW asleep */ }

  const enabled = Boolean(stored.schedule?.enabled);
  const cron = stored.schedule?.cron || '';
  let nextAt = live?.nextRunAt ?? stored.nextRunAt ?? null;
  let nextNote = '';
  if (enabled && !nextAt && validateCron(cron).valid) {
    const n = nextRun(cron);
    if (n) { nextAt = n.getTime(); nextNote = ' (computed)'; }
  }

  const rows = [];
  rows.push(`<div><span class="k">Scheduler</span> ${enabled ? '<b class="on">enabled</b>' : '<b class="off">disabled</b>'}</div>`);
  if (enabled) rows.push(`<div><span class="k">Next run</span> ${nextAt ? new Date(nextAt).toLocaleString() + nextNote : '—'}</div>`);
  const lr = stored.lastRun;
  rows.push(`<div><span class="k">Last run</span> ${lr?.at ? `${new Date(lr.at).toLocaleString()} · ${lr.executed || 0} ok, ${lr.failed || 0} failed${lr.error ? ' · ' + lr.error : ''}` : 'never'}</div>`);
  if (live?.cycleRunning) rows.push('<div><span class="k">Now</span> a run is in progress…</div>');
  if (stored.scheduleError) rows.push(`<div class="err"><span class="k">Cron error</span> ${stored.scheduleError}</div>`);
  box.innerHTML = rows.join('');
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
  if (action !== 'auto') params.kind = action; // full ID e.g. 'linkedin.profile'
  return { task: { type: 'social_extract', params } };
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
  populateHourSelects();

  $('save').addEventListener('click', save);
  $('runNow').addEventListener('click', runNow);
  $('clear').addEventListener('click', clearAll);
  $('regenClientId').addEventListener('click', regenClientId);
  $('genToken').addEventListener('click', genToken);
  $('toggleTokenVis').addEventListener('click', toggleTokenVisibility);
  $('manualRun').addEventListener('click', manualRun);

  // Cron builder wiring
  for (const id of ['bFreq', 'bFrom', 'bTo', 'bAllDay']) $(id).addEventListener('change', onBuilderChanged);
  for (const input of dayInputs()) input.addEventListener('change', onBuilderChanged);
  for (const btn of document.querySelectorAll('.daypresets button')) {
    btn.addEventListener('click', () => {
      const spec = btn.getAttribute('data-days');
      const set = spec === 'all' ? new Set([0, 1, 2, 3, 4, 5, 6]) : new Set(spec.split(',').map(Number));
      for (const input of dayInputs()) input.checked = set.has(Number(input.value));
      onBuilderChanged();
    });
  }
  $('preset').addEventListener('change', () => {
    if ($('preset').value) setCronField($('preset').value, { reflect: true });
  });
  $('cron').addEventListener('input', () => {
    syncPresetFromCron();
    reflectToBuilder($('cron').value.trim());
    renderCronInfo();
  });

  await loadIntoForm();
  if (!$('clientId').value) $('clientId').value = crypto.randomUUID();
});

chrome.storage.onChanged.addListener(() => { renderDiagnostics(); renderStatus(); });
