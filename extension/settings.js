// The full-width page: everything you set once (connection, registry, schedule,
// identity) plus a readable view of whatever the side panel last read off a
// page. The drawer is for doing; this page is for configuring and for reading.

import { validateCron, nextRun } from './src/cron.js';
import { $, setStatus, originPattern, renderBuildStamp, getCapture, CAPTURE_KEY } from './src/ui.js';

let tokenVisible = false;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const VIEWS = ['settings', 'capture'];

function showView(name) {
  const view = VIEWS.includes(name) ? name : 'settings';
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  if (view === 'capture') renderCapture();
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
    const stepM = m.match(/^\*\/(\d+)$/);
    const singleHour = /^\d+$/.test(h);
    if (stepM && ['5', '10', '15', '30'].includes(stepM[1])) {
      $('bFreq').value = stepM[1];
    } else if (m === '0') {
      $('bFreq').value = singleHour ? 'once' : '60';
    }

    if (h === '*') {
      $('bAllDay').checked = true;
    } else {
      $('bAllDay').checked = false;
      const range = h.match(/^(\d+)-(\d+)$/);
      if (range) { $('bFrom').value = range[1]; $('bTo').value = range[2]; }
      else if (singleHour) { $('bFrom').value = h; $('bTo').value = h; }
    }

    const set = new Set();
    if (dow !== '*') {
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
  const cfg = await chrome.storage.local.get([
    'token', 'clientId', 'n8n', 'schedule',
    'registryUrl', 'registryWriteToken',
  ]);
  $('token').value = cfg.token || '';
  $('clientId').value = cfg.clientId || '';
  $('pollUrl').value = cfg.n8n?.pollUrl || '';
  $('resultUrl').value = cfg.n8n?.resultUrl || '';
  $('registryUrl').value = cfg.registryUrl || '';
  $('registryWriteToken').value = cfg.registryWriteToken || '';
  await renderSelectorsState();
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
      pollUrl: $('pollUrl').value.trim() || undefined,
      resultUrl: $('resultUrl').value.trim() || undefined,
    },
    schedule: { enabled: $('enabled').checked, cron: $('cron').value.trim() || '*/15 9-18 * * 1-5' },
    registryUrl: $('registryUrl').value.trim() || undefined,
    registryWriteToken: $('registryWriteToken').value.trim() || undefined,
  };
}

// The registry is usable on its own — notably for a local test run with no
// automation host configured — so it saves without going through validate().
async function saveSelectors() {
  const v = {
    registryUrl: $('registryUrl').value.trim(),
    registryWriteToken: $('registryWriteToken').value.trim(),
  };
  if (v.registryUrl && !/^https:\/\/.+/.test(v.registryUrl)) {
    setStatus($('status'), 'Registry URL must be https.', 'err');
    return;
  }

  try {
    if (!(await ensureHostPermissions(v))) {
      setStatus($('status'), 'Permission to reach the registry was denied.', 'err');
      return;
    }
  } catch (e) { console.error(e); }

  const res = await chrome.runtime.sendMessage({
    cmd: 'manual-run',
    type: 'selectors_set_url',
    params: { url: v.registryUrl || null, writeToken: v.registryWriteToken || null },
  });
  if (res?.ok) {
    setStatus($('status'), v.registryUrl ? 'Custom registry reached ✓' : 'Built-in registry reached ✓', 'ok');
  } else {
    setStatus($('status'), 'Registry: ' + (res?.error?.message || 'failed'), 'err');
  }
  await renderSelectorsState();
}

async function renderSelectorsState() {
  const el = $('selectorsState');
  if (!el) return;
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'manual-run', type: 'selectors_status', params: {} });
    const s = res?.data?.registry;
    if (!s) { el.textContent = '—'; return; }
    if (s.error) { el.textContent = `unreachable — ${s.error}`; return; }
    const n = (s.entries || []).length;
    const bytes = (s.entries || []).reduce((t, e) => t + (e.extract_js_bytes || 0), 0);
    el.textContent = `${n} page types · ${(bytes / 1024).toFixed(0)} KB of extractors · interface in ${s.uiLocale}`
      + (s.overridden ? ' · custom endpoint' : '')
      + (s.failures ? ` · ${s.failures.count} recent failures` : '');
  } catch {
    el.textContent = '—';
  }
}

function validate(v) {
  const errs = [];
  if (!v.token || v.token.length < 16) errs.push('token (≥16 chars)');
  if (v.n8n.pollUrl && !/^https?:\/\/.+/.test(v.n8n.pollUrl)) errs.push('poll URL');
  if (v.n8n.resultUrl && !/^https?:\/\/.+/.test(v.n8n.resultUrl)) errs.push('result URL');
  if (v.registryUrl && !/^https?:\/\/.+/.test(v.registryUrl)) errs.push('registry URL');
  if (!validateCron(v.schedule.cron).valid) errs.push('cron expression');
  return errs;
}

async function ensureHostPermissions(v) {
  // Built-in endpoints are already in host_permissions; only an override can
  // introduce an origin Chrome has not granted yet.
  const origins = [...new Set([
    v.n8n?.pollUrl && originPattern(v.n8n.pollUrl),
    v.n8n?.resultUrl && originPattern(v.n8n.resultUrl),
    v.registryUrl && originPattern(v.registryUrl),
  ].filter(Boolean))];
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

  const { registryUrl, registryWriteToken, ...core } = next;
  await chrome.storage.local.set(core);
  // Goes through the command so the stored URL and the failure counter stay
  // consistent with each other.
  try {
    await chrome.runtime.sendMessage({
      cmd: 'manual-run',
      type: 'selectors_set_url',
      params: { url: registryUrl || null, writeToken: registryWriteToken || null },
    });
  } catch (e) { console.error(e); }

  try { await chrome.runtime.sendMessage({ cmd: 'reschedule' }); } catch { /* SW waking */ }
  setStatus($('status'), next.schedule.enabled ? 'Saved ✓ — scheduler armed.' : 'Saved ✓ — scheduler off.', 'ok');
  await renderDiagnostics();
  await renderSelectorsState();
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
  if (!confirm('Your automation filters on this ID. A new one stops every job until the other side is updated too. Continue?')) return;
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
  masked._extension = {
    name: manifest.name,
    version: manifest.version,
    build: manifest.version_name || null,
    id: chrome.runtime.id,
  };
  $('diagnostics').textContent = JSON.stringify(masked, null, 2);
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return `${Object.keys(value).length} keys`;
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : (value || '(empty)');
  return String(value);
}

// A flat field list beats a JSON blob for the question this page answers:
// "did the extractor actually fill this in?". Empty values are called out
// rather than quietly rendered as nothing.
function renderFields(result) {
  const box = $('captureFields');
  box.innerHTML = '';
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    $('captureFieldsCard').hidden = true;
    return;
  }
  const entries = Object.entries(result);
  if (!entries.length) { $('captureFieldsCard').hidden = true; return; }

  for (const [key, value] of entries) {
    const row = document.createElement('div');
    row.className = 'field';
    const empty = value === null || value === undefined || value === ''
      || (Array.isArray(value) && !value.length);
    row.innerHTML = `<span class="fk">${key}</span>`;
    const v = document.createElement('span');
    v.className = 'fv' + (empty ? ' empty' : '');
    v.textContent = empty ? '— empty' : describe(value);
    row.appendChild(v);
    box.appendChild(row);
  }
  $('captureFieldsCard').hidden = false;
}

let currentCapture = null;

async function renderCapture() {
  const cap = await getCapture();
  currentCapture = cap;
  const meta = $('captureMeta');

  if (!cap) {
    meta.innerHTML = 'Nothing captured yet. Use <strong>Read this page</strong> in the side panel.';
    $('captureActions').hidden = true;
    for (const id of ['captureStepsCard', 'captureFieldsCard', 'captureJsonCard']) $(id).hidden = true;
    return;
  }

  const rows = [];
  rows.push(`<div><span class="k">Page</span> <a href="${cap.url}" target="_blank" rel="noreferrer">${cap.url}</a></div>`);
  if (cap.error) {
    rows.push(`<div class="err"><span class="k">Failed</span> ${cap.error.message}</div>`);
    if (cap.error.known?.length) {
      rows.push(`<div><span class="k">Published</span> ${cap.error.known.join(', ')}</div>`);
    }
  } else {
    rows.push(`<div><span class="k">Page type</span> ${cap.pageType} · ${cap.uiLocale}</div>`);
    rows.push(`<div><span class="k">Registry</span> ${cap.registryVersion}</div>`);
    rows.push(`<div><span class="k">Took</span> ${cap.durationMs} ms${cap.scrolled ? ' · scrolled the page' : ' · no scrolling'}</div>`);
  }
  rows.push(`<div><span class="k">Read at</span> ${new Date(cap.at).toLocaleString()}</div>`);
  meta.innerHTML = rows.join('');
  $('captureActions').hidden = false;

  const steps = cap.steps || [];
  $('captureStepsCard').hidden = !steps.length;
  const sbox = $('captureSteps');
  sbox.innerHTML = '';
  for (const s of steps) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (/fail|not_normalized|changed/i.test(s.label) ? ' bad' : '');
    chip.textContent = s.label;
    sbox.appendChild(chip);
  }

  renderFields(cap.result);

  $('captureJsonCard').hidden = false;
  $('captureJson').textContent = JSON.stringify(cap.error ? cap : cap.result, null, 2);
}

function captureCopy() {
  const text = $('captureJson').textContent;
  navigator.clipboard.writeText(text).then(
    () => setStatus($('captureStatus'), 'Copied.', 'ok'),
    () => setStatus($('captureStatus'), 'Clipboard refused.', 'err'),
  );
}

function captureDownload() {
  const cap = currentCapture;
  if (!cap) return;
  const name = `capture-${cap.pageType || 'unknown'}-${new Date(cap.at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify(cap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function captureClear() {
  await chrome.storage.session.remove(CAPTURE_KEY);
  await renderCapture();
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  renderBuildStamp();
  populateHourSelects();

  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => showView(b.dataset.view));
  }
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

  $('save').addEventListener('click', save);
  $('runNow').addEventListener('click', runNow);
  $('clear').addEventListener('click', clearAll);
  $('regenClientId').addEventListener('click', regenClientId);
  $('genToken').addEventListener('click', genToken);
  $('toggleTokenVis').addEventListener('click', toggleTokenVisibility);
  $('saveSelectors').addEventListener('click', saveSelectors);
  $('captureCopy').addEventListener('click', captureCopy);
  $('captureDownload').addEventListener('click', captureDownload);
  $('captureClear').addEventListener('click', captureClear);

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
  showView(location.hash.slice(1));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[CAPTURE_KEY]) { renderCapture(); return; }
  renderDiagnostics();
  renderStatus();
});
