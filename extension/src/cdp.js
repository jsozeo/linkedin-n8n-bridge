// Thin wrapper around `chrome.debugger` (Chrome DevTools Protocol).
//
// - Caches attached tabIds so we don't re-attach (which would flash the
//   yellow "DevTools is debugging…" banner) on every command.
// - Tracks which CDP domains have been `enable`d per tab to avoid redundant
//   calls.
// - Exposes a promise-based `waitForEvent(tabId, method, predicate, timeoutMs)`
//   for navigation / lifecycle synchronization.

const PROTOCOL_VERSION = '1.3';

const attached = new Set();
const enabledDomains = new Map(); // tabId -> Set<string>
const eventListeners = new Map(); // listenerId -> { tabId, method, fn }
let listenerSeq = 0;

// Global event dispatcher (single chrome.debugger.onEvent listener)
chrome.debugger.onEvent.addListener((source, method, params) => {
  for (const { tabId, method: m, fn } of eventListeners.values()) {
    if (tabId === source.tabId && m === method) {
      try { fn(params); } catch (e) { console.error('[cdp] listener error', e); }
    }
  }
});

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  console.warn('[cdp] detached', { tabId, reason });
  attached.delete(tabId);
  enabledDomains.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  enabledDomains.delete(tabId);
});

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attached.add(tabId);
  enabledDomains.set(tabId, new Set());
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  attached.delete(tabId);
  enabledDomains.delete(tabId);
}

export async function send(tabId, method, params = {}) {
  await attach(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Enable a CDP domain at most once per tab. */
export async function enableDomain(tabId, domain) {
  await attach(tabId);
  const set = enabledDomains.get(tabId);
  if (set.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
  set.add(domain);
}

/**
 * Wait for a CDP event matching `method` (e.g. "Page.loadEventFired") on the
 * given tab. `predicate(params)` lets you filter (default: first match).
 * Rejects on timeout.
 */
export function waitForEvent(tabId, method, predicate = () => true, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = ++listenerSeq;
    const timer = setTimeout(() => {
      eventListeners.delete(id);
      const err = new Error(`Timeout waiting for ${method} (${timeoutMs}ms)`);
      err.code = 'CDP_EVENT_TIMEOUT';
      reject(err);
    }, timeoutMs);

    eventListeners.set(id, {
      tabId,
      method,
      fn: (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        eventListeners.delete(id);
        resolve(params);
      },
    });
  });
}

/** Evaluate a JS expression in the page and return the deserialized value. */
export async function evalInPage(tabId, expression, { awaitPromise = false } = {}) {
  const res = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (res.exceptionDetails) {
    const err = new Error(
      res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        'Runtime.evaluate failed'
    );
    err.code = 'PAGE_EVAL_ERROR';
    err.details = res.exceptionDetails;
    throw err;
  }
  return res.result?.value;
}
