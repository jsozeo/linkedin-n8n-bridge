// Side panel = the doing surface. A manual runner for one-off tasks, and a
// read of whatever tab you are on so a selector can be checked at any moment.
// Everything you configure once lives in the full-width settings page.

import { validateCron, nextRun } from './src/cron.js';
import { $, setStatus, renderBuildStamp, openFullPage, putCapture } from './src/ui.js';

// ---------------------------------------------------------------------------
// Manual run
// ---------------------------------------------------------------------------

// Write actions are prefixed 'w:', registry commands 'r:'. Everything else is
// an extractor kind passed through to social_extract.
const NEEDS_TEXT = new Set(['linkedin_comment_post', 'linkedin_reply_comment', 'linkedin_invite']);
const NEEDS_URN = new Set(['linkedin_like_comment', 'linkedin_reply_comment', 'linkedin_like_reply']);

function syncManualFields() {
  const action = $('manualAction').value;
  const write = action.startsWith('w:');
  const cmd = write ? action.slice(2) : '';
  $('manualLiveRow').hidden = !write;
  $('manualTextRow').hidden = !NEEDS_TEXT.has(cmd);
  $('manualUrnRow').hidden = !NEEDS_URN.has(cmd);
  $('manualUrl').disabled = action.startsWith('r:');
}

function buildProbeTask(url, active, mode) {
  if (!/^https?:\/\/.+/.test(url)) return { error: 'Enter a valid http(s) URL.' };
  return {
    task: {
      type: 'selectors_probe',
      params: { url, active, prepare: mode === 'comment' ? 'comment' : null, keepTab: mode === 'comment' },
    },
  };
}

function buildManualTask() {
  const url = $('manualUrl').value.trim();
  const action = $('manualAction').value;
  const active = $('manualActive').checked;

  if (action.startsWith('r:')) return { task: { type: action.slice(2), params: {} } };
  if (action.startsWith('p:')) return buildProbeTask(url, active, action.slice(2));
  if (!/^https?:\/\/.+/.test(url)) return { error: 'Enter a valid http(s) URL.' };

  if (action.startsWith('w:')) {
    const type = action.slice(2);
    const params = { url, active, dryRun: !$('manualLive').checked };
    if (NEEDS_TEXT.has(type)) {
      const text = $('manualText').value.trim();
      if (!text && type !== 'linkedin_invite') return { error: 'This action needs some text.' };
      if (type === 'linkedin_invite') params.note = text; else params.text = text;
    }
    if (NEEDS_URN.has(type)) {
      const urn = $('manualUrn').value.trim();
      if (!urn) return { error: 'This action needs a comment URN (get_comments returns it as comment_urn).' };
      if (type === 'linkedin_like_reply') params.replyUrn = urn; else params.commentUrn = urn;
    }
    return { task: { type, params } };
  }

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
// Read the current page
// ---------------------------------------------------------------------------

async function readPage() {
  const btn = $('readPage');
  const state = $('readState');
  btn.disabled = true;
  state.className = 'hint';
  state.textContent = 'Reading the current tab…';

  try {
    const res = await chrome.runtime.sendMessage({
      cmd: 'manual-run',
      type: 'extract_current_page',
      params: { scroll: $('readScroll').checked },
    });

    if (res?.ok) {
      const d = res.data || {};
      await putCapture({ ...d, at: Date.now() });
      const n = countItems(d.result);
      state.className = 'hint ok';
      state.textContent = `${d.pageType} · ${d.uiLocale} · ${n} — open full width to read it`;
    } else {
      const err = res?.error || { message: 'no response' };
      await putCapture({
        url: err.url || null,
        error: { message: err.message, code: err.code, known: err.known || [] },
        at: Date.now(),
      });
      state.className = 'hint err';
      // The one case worth spelling out: the page simply is not in the registry.
      state.textContent = err.code === 'NO_PAGE_TYPE'
        ? 'No page type in the registry matches this URL — nothing was read.'
        : `${err.message} (${err.code || 'ERR'})`;
    }
  } catch (e) {
    state.className = 'hint err';
    state.textContent = 'Read failed: ' + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

function countItems(result) {
  if (!result || typeof result !== 'object') return 'no structure';
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) return `${v.length} ${k}`;
  }
  const filled = Object.values(result).filter((v) => v !== null && v !== undefined && v !== '').length;
  return `${filled}/${Object.keys(result).length} fields filled`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function renderStatus() {
  const box = $('statusSummary');
  if (!box) return;
  const stored = await chrome.storage.local.get(['schedule', 'nextRunAt', 'lastRun', 'scheduleError']);

  let live = null;
  try { live = await chrome.runtime.sendMessage({ cmd: 'status' }); } catch { /* SW asleep */ }

  const enabled = Boolean(stored.schedule?.enabled);
  const cron = stored.schedule?.cron || '';
  let nextAt = live?.nextRunAt ?? stored.nextRunAt ?? null;
  if (enabled && !nextAt && validateCron(cron).valid) {
    const n = nextRun(cron);
    if (n) nextAt = n.getTime();
  }

  const rows = [];
  rows.push(`<div><span class="k">Scheduler</span> ${enabled ? '<b class="on">enabled</b>' : '<b class="off">disabled</b>'}</div>`);
  if (enabled) rows.push(`<div><span class="k">Next run</span> ${nextAt ? new Date(nextAt).toLocaleString() : '—'}</div>`);
  const lr = stored.lastRun;
  rows.push(`<div><span class="k">Last run</span> ${lr?.at ? `${new Date(lr.at).toLocaleString()} · ${lr.executed || 0} ok, ${lr.failed || 0} failed${lr.error ? ' · ' + lr.error : ''}` : 'never'}</div>`);
  if (stored.scheduleError) rows.push(`<div class="err"><span class="k">Cron error</span> ${stored.scheduleError}</div>`);
  box.innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  renderBuildStamp();
  $('manualRun').addEventListener('click', manualRun);
  $('manualAction').addEventListener('change', syncManualFields);
  $('readPage').addEventListener('click', readPage);
  $('openCapture').addEventListener('click', () => openFullPage('capture'));
  $('openSettings').addEventListener('click', () => openFullPage('settings'));
  $('openSettings2').addEventListener('click', () => openFullPage('settings'));
  syncManualFields();
  await renderStatus();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') renderStatus();
});
