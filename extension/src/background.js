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

async function postResult(cfg, taskId, payload) {
  if (!cfg.n8n?.resultUrl) return; // result sink is optional
  const body = { clientId: cfg.clientId, taskId, ...payload };
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
    for (let i = 0; i < MAX_TASKS_PER_CYCLE; i += 1) {
      let tasks;
      try {
        tasks = await fetchTasks(cfg);
      } catch (e) {
        summary.error = e.message || String(e);
        console.error('[bridge] fetch error', e);
        break;
      }
      if (!tasks.length) break;

      for (const task of tasks) {
        const r = await executeTask(cfg, task);
        if (r.ok) summary.executed += 1;
        else summary.failed += 1;
        await sleep(250); // gentle pacing between actions
      }
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
  await chrome.alarms.clear(ALARM_NAME);

  const { schedule } = await chrome.storage.local.get(['schedule']);
  if (!schedule?.enabled) {
    await chrome.storage.local.set({ nextRunAt: null });
    console.log('[bridge] schedule disabled — no alarm set');
    return;
  }

  const cron = schedule.cron || DEFAULT_CRON;
  let when;
  try {
    const next = nextRun(cron);
    if (!next) throw new Error('no upcoming run');
    when = next.getTime();
  } catch (e) {
    console.error('[bridge] invalid cron, scheduler paused:', e.message);
    await chrome.storage.local.set({ nextRunAt: null, scheduleError: e.message });
    return;
  }

  await chrome.alarms.create(ALARM_NAME, { when });
  await chrome.storage.local.set({ nextRunAt: when, scheduleError: null });
  console.log('[bridge] next run at', new Date(when).toISOString());
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await runCycle('alarm');
  await scheduleNext();
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

// Arm on cold SW boot.
scheduleNext();
