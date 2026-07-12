// Navigation + readiness commands.
import { send, enableDomain, waitForEvent, evalInPage } from '../cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Navigate the tab. `waitUntil`:
 *   - 'load'              → Page.loadEventFired (default)
 *   - 'domcontentloaded'  → Page.domContentEventFired
 *   - 'none'              → return immediately after Page.navigate resolves
 */
export async function navigate({ tabId, url, waitUntil = 'load', timeoutMs = 30_000 } = {}) {
  if (!tabId || !url) { const e = new Error('navigate: tabId and url required'); e.code = 'BAD_PARAMS'; throw e; }
  await enableDomain(tabId, 'Page');

  let waitMethod = null;
  if (waitUntil === 'load') waitMethod = 'Page.loadEventFired';
  else if (waitUntil === 'domcontentloaded') waitMethod = 'Page.domContentEventFired';

  const waiter = waitMethod ? waitForEvent(tabId, waitMethod, () => true, timeoutMs) : null;
  const nav = await send(tabId, 'Page.navigate', { url });
  if (nav.errorText) {
    const err = new Error(`navigate failed: ${nav.errorText}`); err.code = 'NAV_ERROR'; throw err;
  }
  if (waiter) await waiter;
  return { ok: true, frameId: nav.frameId, loaderId: nav.loaderId };
}

export async function reload({ tabId, bypassCache = false, waitUntil = 'load', timeoutMs = 30_000 } = {}) {
  if (!tabId) { const e = new Error('reload: tabId required'); e.code = 'BAD_PARAMS'; throw e; }
  await enableDomain(tabId, 'Page');
  const waitMethod = waitUntil === 'domcontentloaded'
    ? 'Page.domContentEventFired'
    : waitUntil === 'none' ? null : 'Page.loadEventFired';
  const waiter = waitMethod ? waitForEvent(tabId, waitMethod, () => true, timeoutMs) : null;
  await send(tabId, 'Page.reload', { ignoreCache: bypassCache });
  if (waiter) await waiter;
  return { ok: true };
}

export async function go_back({ tabId, timeoutMs = 30_000 } = {}) {
  if (!tabId) { const e = new Error('go_back: tabId required'); e.code = 'BAD_PARAMS'; throw e; }
  await enableDomain(tabId, 'Page');
  const { entries, currentIndex } = await send(tabId, 'Page.getNavigationHistory');
  if (currentIndex === 0) { const e = new Error('no previous history'); e.code = 'NO_HISTORY'; throw e; }
  const waiter = waitForEvent(tabId, 'Page.loadEventFired', () => true, timeoutMs);
  await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
  await waiter;
  return { ok: true };
}

export async function go_forward({ tabId, timeoutMs = 30_000 } = {}) {
  if (!tabId) { const e = new Error('go_forward: tabId required'); e.code = 'BAD_PARAMS'; throw e; }
  await enableDomain(tabId, 'Page');
  const { entries, currentIndex } = await send(tabId, 'Page.getNavigationHistory');
  if (currentIndex >= entries.length - 1) { const e = new Error('no forward history'); e.code = 'NO_HISTORY'; throw e; }
  const waiter = waitForEvent(tabId, 'Page.loadEventFired', () => true, timeoutMs);
  await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[currentIndex + 1].id });
  await waiter;
  return { ok: true };
}

/**
 * Wait for a page-readiness state.
 *   - state='load'         → document.readyState === 'complete'
 *   - state='domcontentloaded' → document.readyState !== 'loading'
 *   - state='networkidle'  → no network activity for 500ms (heuristic via performance.getEntriesByType)
 */
export async function wait_for_load({ tabId, state = 'load', timeoutMs = 30_000 } = {}) {
  if (!tabId) { const e = new Error('wait_for_load: tabId required'); e.code = 'BAD_PARAMS'; throw e; }
  const deadline = Date.now() + timeoutMs;
  const pollMs = 100;

  while (Date.now() < deadline) {
    let cond;
    if (state === 'load') cond = "document.readyState === 'complete'";
    else if (state === 'domcontentloaded') cond = "document.readyState !== 'loading'";
    else if (state === 'networkidle') {
      // crude: complete + no fetch entries newer than 500ms ago
      cond = "document.readyState === 'complete' && (() => { const e = performance.getEntriesByType('resource'); const last = e.length ? e[e.length-1].responseEnd : 0; return performance.now() - last > 500; })()";
    } else {
      const e = new Error(`wait_for_load: unknown state '${state}'`); e.code = 'BAD_PARAMS'; throw e;
    }
    const ok = await evalInPage(tabId, cond);
    if (ok) return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()) };
    await sleep(pollMs);
  }
  const err = new Error(`wait_for_load timeout (state=${state}, ${timeoutMs}ms)`);
  err.code = 'WAIT_TIMEOUT'; throw err;
}

/**
 * Poll the page for a selector. Returns when found.
 * `visible` (default false) → also requires non-zero bounding rect + computed
 * visibility/display/opacity.
 */
export async function wait_for_selector({ tabId, selector, timeoutMs = 30_000, visible = false, pollMs = 100 } = {}) {
  if (!tabId || !selector) { const e = new Error('wait_for_selector: tabId and selector required'); e.code = 'BAD_PARAMS'; throw e; }
  const deadline = Date.now() + timeoutMs;
  const probe = visible
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; })()`
    : `!!document.querySelector(${JSON.stringify(selector)})`;

  while (Date.now() < deadline) {
    const found = await evalInPage(tabId, probe);
    if (found) return { ok: true, selector };
    await sleep(pollMs);
  }
  const err = new Error(`wait_for_selector timeout: ${selector}`);
  err.code = 'WAIT_TIMEOUT'; throw err;
}
