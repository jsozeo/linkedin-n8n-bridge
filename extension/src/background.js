import { loadConfig, DEFAULT_CRON } from './config.js';
import { dispatch } from './commands/index.js';
import { nextRun } from './cron.js';

const ALARM_NAME = 'cron-tick';
const MAX_TASKS_PER_CYCLE = 50;

let cycleRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// n8n transport
// ---------------------------------------------------------------------------

function normalizeTasks(payload) {
  if (payload == null || payload === '') return [];
  if (Array.isArray(payload)) return payload.filter(Boolean);
  if (Array.isArray(payload.tasks)) return payload.tasks.filter(Boolean);
  if (payload.type) return [payload];
  return [];
}

async function fetchTasks(cfg) {
  const url = new URL(cfg.n8n.pollUrl);
  url.searchParams.set('clientId', cfg.clientId);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`poll HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const text = await res.text();
  if (!text.trim()) return [];
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`poll returned non-JSON body: ${text.slice(0, 120)}`);
  }
  return normalizeTasks(json);
}

// gzip a string → base64, using the service-worker CompressionStream API.
async function gzipBase64(str) {
  const cs = new CompressionStream('gzip');
  const ab = await new Response(new Blob([str]).stream().pipeThrough(cs)).arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = '';
  const CHUNK = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// Captured page HTML can reach several MB. A raw JSON POST then blows past the
// Lambda/API-Gateway (and many webhook) request-size ceilings → HTTP 413. We
// gzip+base64 the `html` field (≈10× smaller) into `htmlGz` and drop the raw
// field; the receiver decompresses. Threshold keeps small payloads untouched.
async function compressHtmlInPlace(container) {
  if (!container || typeof container.html !== 'string') return;
  if (container.html.length < 256 * 1024 || typeof CompressionStream === 'undefined') return;
  try {
    container.htmlGz = await gzipBase64(container.html);
    container.htmlEncoding = 'gzip+base64';
    delete container.html;
  } catch (e) {
    console.warn('[bridge] html compress failed, sending raw', e);
  }
}

async function postResult(cfg, taskId, payload) {
  if (!cfg.n8n?.resultUrl) return; // result sink is optional
  const body = { clientId: cfg.clientId, taskId, ...payload };
  // Compress large HTML wherever it rides (success → data.html, error → html).
  await compressHtmlInPlace(body);
  if (body.data && typeof body.data === 'object') await compressHtmlInPlace(body.data);
  try {
    const r = await fetch(cfg.n8n.resultUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error('[bridge] result HTTP', r.status, await r.text());
  } catch (e) {
    console.error('[bridge] result error', e);
  }
}

async function executeTask(cfg, task) {
  const start = Date.now();
  const taskId = task.taskId || crypto.randomUUID();
  console.log('[bridge] exec', task.type, taskId);
  try {
    const data = await dispatch(task.type, task.params);
    await postResult(cfg, taskId, { status: 'success', data, durationMs: Date.now() - start });
    return { ok: true };
  } catch (err) {
    console.error('[bridge] exec error', err);
    await postResult(cfg, taskId, {
      status: 'error',
      error: { message: err.message || String(err), code: err.code || 'UNKNOWN' },
      // Captured DOM (when captureHtml was requested) so the orchestrator can
      // store it for auto-heal.
      html: err.html || null,
      steps: err.steps || null,
      durationMs: Date.now() - start,
    });
    return { ok: false, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Cycle: one scheduled run drains the n8n queue sequentially
// ---------------------------------------------------------------------------

async function runCycle(trigger = 'alarm') {
  if (cycleRunning) return { skipped: 'already-running' };
  cycleRunning = true;

  const summary = { at: Date.now(), trigger, executed: 0, failed: 0, error: null };
  try {
    const cfg = await loadConfig();
    if (!cfg) {
      summary.error = 'config incomplete';
      return summary;
    }

    console.log('[bridge] cycle start', trigger);
    // Poll ONCE per tick. The orchestrator (n8n random-switch) always answers
    // with a task, so a re-fetch loop would open a tab on every iteration up to
    // MAX_TASKS_PER_CYCLE — 50 tabs a minute. Execute only what this single poll
    // returns (capped for safety); the next cron tick polls again.
    let tasks = [];
    try {
      tasks = await fetchTasks(cfg);
    } catch (e) {
      summary.error = e.message || String(e);
      console.error('[bridge] fetch error', e);
    }

    for (const task of tasks.slice(0, MAX_TASKS_PER_CYCLE)) {
      const r = await executeTask(cfg, task);
      if (r.ok) summary.executed += 1;
      else summary.failed += 1;
      await sleep(250); // gentle pacing between actions
    }
  } finally {
    cycleRunning = false;
    await chrome.storage.local.set({ lastRun: summary });
    console.log('[bridge] cycle done', summary);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Scheduler (chrome.alarms — wakes the service worker even when suspended)
// ---------------------------------------------------------------------------

async function scheduleNext() {
  const cfg = await loadConfig();
  const schedule = cfg?.schedule;
  if (!schedule?.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({ nextRunAt: null });
    console.log('[bridge] schedule disabled — no alarm set');
    return;
  }

  // Compute the next due time from the cron for status/gating purposes.
  const cron = schedule.cron || DEFAULT_CRON;
  let when = null;
  try {
    const next = nextRun(cron);
    when = next ? next.getTime() : null;
    await chrome.storage.local.set({ nextRunAt: when, scheduleError: null });
  } catch (e) {
    console.error('[bridge] invalid cron:', e.message);
    await chrome.storage.local.set({ nextRunAt: null, scheduleError: e.message });
  }

  // PERIODIC heartbeat alarm (not one-shot). A one-shot alarm re-armed after
  // each cycle is lost forever if a long task (e.g. a multi-MB social_extract)
  // gets the MV3 service worker torn down before the re-arm runs — polling then
  // stops permanently. A periodic alarm is persisted by Chrome and keeps waking
  // the worker every minute regardless of what happened during a cycle.
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || !existing.periodInMinutes) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1, when: Date.now() + 1000 });
  }
  console.log('[bridge] heartbeat armed; next due', when ? new Date(when).toISOString() : 'n/a');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Heartbeat fires every minute; only actually poll when the cron is due.
  try {
    const { nextRunAt } = await chrome.storage.local.get('nextRunAt');
    const now = Date.now();
    // Self-heal: poll when due, when nextRunAt is missing, OR when it's parked
    // absurdly far in the future (> ~16 min — longer than any cron we schedule,
    // i.e. */15). A stale/corrupt future value would otherwise wedge polling
    // forever, which is exactly the "reloaded but never polls" symptom.
    const due = !nextRunAt || now >= nextRunAt - 2000 || (nextRunAt - now) > 16 * 60 * 1000;
    if (!due) return;
  } catch { /* if storage read fails, fall through and poll */ }
  await runCycle('alarm');
  await scheduleNext(); // recompute next due time (heartbeat persists regardless)
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[bridge] onInstalled');
  scheduleNext();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[bridge] onStartup');
  scheduleNext();
});

// Re-arm the scheduler whenever the schedule config changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.schedule) scheduleNext();
});

// Messages from the Options page: run now / reschedule / status.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.cmd === 'run-now') {
      const summary = await runCycle('manual');
      sendResponse({ ok: true, summary });
    } else if (msg?.cmd === 'reschedule') {
      await scheduleNext();
      sendResponse({ ok: true });
    } else if (msg?.cmd === 'status') {
      const state = await chrome.storage.local.get(['nextRunAt', 'lastRun', 'scheduleError']);
      sendResponse({ ok: true, ...state, cycleRunning });
    } else if (msg?.cmd === 'manual-run') {
      // Run a single command directly (no n8n round-trip) — used by the side
      // panel's manual mode.
      const start = Date.now();
      try {
        const data = await dispatch(msg.type, msg.params || {});
        sendResponse({ ok: true, data, durationMs: Date.now() - start });
      } catch (err) {
        sendResponse({
          ok: false,
          error: { message: err.message || String(err), code: err.code || 'UNKNOWN' },
          durationMs: Date.now() - start,
        });
      }
    } else {
      sendResponse({ ok: false, error: 'unknown command' });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Clicking the toolbar icon opens the side panel (the extension's home).
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// Arm on cold SW boot, and poll right away so a reload/wake picks up a queued
// job without waiting for the first heartbeat. runCycle self-guards against
// concurrent runs, so this is safe alongside the alarm.
scheduleNext().then(() => runCycle('startup')).catch(() => {});
