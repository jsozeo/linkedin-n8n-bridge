// Tab lifecycle commands.
//   - 'load' / 'none' use only chrome.tabs (no CDP attach).
//   - 'domcontentloaded' listens on chrome.webNavigation.onDOMContentLoaded
//     for the main frame of the new tab. No debugger required — survives
//     the cross-origin process swap that happens when navigating from
//     about:blank to the target.

/**
 * Pick a window to host the new tab. A service worker has no "current window",
 * so chrome.tabs.create() throws `No current window` whenever the browser holds
 * no open window at all — which is what an unattended machine looks like after
 * a Chrome auto-update. Reuse any normal window, else open one unfocused.
 */
async function resolveWindowId(explicit) {
  if (typeof explicit === 'number') return explicit;
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length) return wins[0].id;
  } catch { /* no window list available — fall through and create one */ }
  const created = await chrome.windows.create({ focused: false });
  return created.id;
}

/**
 * Open a new tab. `waitUntil`:
 *   - 'load' (default) → chrome.tabs status === 'complete' (= window.load).
 *   - 'domcontentloaded' → main-frame DCL via chrome.webNavigation. Use this
 *     for pages whose `load` event is held up by third-party trackers
 *     (Malt, LinkedIn, etc.).
 *   - 'none' → resolves immediately after chrome.tabs.create.
 */
export async function open_tab({ url, active = true, windowId, waitUntil = 'load', timeoutMs = 30_000 } = {}) {
  if (!url) {
    const err = new Error('open_tab: `url` is required'); err.code = 'BAD_PARAMS'; throw err;
  }

  const hostWindowId = await resolveWindowId(windowId);

  if (waitUntil === 'domcontentloaded') {
    // Arm the listener BEFORE creating the tab so a very-fast (cached) load
    // can't fire DCL before we're listening.
    let resolveFn, rejectFn, listener, timer;
    const dclP = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    const created = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active, windowId: hostWindowId })
        .then(resolve).catch(reject);
    });
    listener = (details) => {
      if (details.tabId === created.id && details.frameId === 0) {
        chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
        clearTimeout(timer);
        resolveFn();
      }
    };
    chrome.webNavigation.onDOMContentLoaded.addListener(listener);
    timer = setTimeout(() => {
      chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
      const err = new Error(`open_tab: timeout waiting for 'domcontentloaded' (${timeoutMs}ms)`);
      err.code = 'WAIT_TIMEOUT';
      rejectFn(err);
    }, timeoutMs);
    try {
      await dclP;
    } catch (e) {
      // Tab was created but DCL never fired (timeout / nav error). Remove
      // it now so we don't leak orphan tabs across the user's Chrome window.
      try { await chrome.tabs.remove(created.id); } catch { /* tab gone */ }
      throw e;
    }
    const t = await chrome.tabs.get(created.id);
    return { tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active };
  }

  const created = await chrome.tabs.create({ url, active, windowId: hostWindowId });

  if (waitUntil === 'load') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        const err = new Error(`open_tab: timeout waiting for 'load' (${timeoutMs}ms)`);
        err.code = 'WAIT_TIMEOUT'; reject(err);
      }, timeoutMs);
      const listener = (tid, info) => {
        if (tid === created.id && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Race: if the tab is already complete (rare but possible with cached pages), short-circuit.
      chrome.tabs.get(created.id).then((t) => {
        if (t.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }).catch(() => { /* tab gone or pre-load — keep waiting */ });
    });
  } else if (waitUntil !== 'none') {
    const e = new Error(`open_tab: unsupported waitUntil '${waitUntil}' (use 'load', 'domcontentloaded', or 'none')`);
    e.code = 'BAD_PARAMS'; throw e;
  }

  // Re-read so the URL is populated (chrome.tabs.create returns before nav).
  const t = await chrome.tabs.get(created.id);
  return { tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active };
}

export async function close_tab({ tabId } = {}) {
  if (!tabId) { const e = new Error('close_tab: `tabId` is required'); e.code = 'BAD_PARAMS'; throw e; }
  await chrome.tabs.remove(tabId);
  return { ok: true };
}

export async function list_tabs({ windowId, currentWindow } = {}) {
  const query = {};
  if (typeof windowId === 'number') query.windowId = windowId;
  if (currentWindow === true) query.currentWindow = true;
  const tabs = await chrome.tabs.query(query);
  return {
    tabs: tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url,
      title: t.title,
      active: t.active,
      status: t.status,
      index: t.index,
    })),
  };
}

export async function focus_tab({ tabId } = {}) {
  if (!tabId) { const e = new Error('focus_tab: `tabId` is required'); e.code = 'BAD_PARAMS'; throw e; }
  const tab = await chrome.tabs.update(tabId, { active: true });
  // Also focus the window containing the tab.
  if (tab?.windowId) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* noop */ }
  }
  return { ok: true, tabId: tab.id, windowId: tab.windowId };
}

export async function get_tab({ tabId } = {}) {
  if (!tabId) { const e = new Error('get_tab: `tabId` is required'); e.code = 'BAD_PARAMS'; throw e; }
  const t = await chrome.tabs.get(tabId);
  return {
    tabId: t.id,
    windowId: t.windowId,
    url: t.url,
    title: t.title,
    active: t.active,
    status: t.status,
    index: t.index,
    pinned: t.pinned,
  };
}
