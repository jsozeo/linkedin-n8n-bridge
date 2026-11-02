// Bits the side panel and the full-width page both need. Kept here so the two
// surfaces cannot drift apart on something as basic as "which build is this".

export const $ = (id) => document.getElementById(id);

export function setStatus(el, msg, kind = '') {
  if (!el) return;
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
  if (msg && kind) {
    setTimeout(() => {
      if (el.textContent === msg) { el.textContent = ''; el.className = 'status'; }
    }, 6000);
  }
}

export function originPattern(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}/*`; } catch { return null; }
}

// version_name is stamped by tools/stamp-version.mjs; a timestamp older than
// the last stamp means the reload never took.
export function renderBuildStamp(id = 'buildStamp') {
  const el = $(id);
  if (!el) return;
  const m = chrome.runtime.getManifest?.() || {};
  const stamp = m.version_name || `v${m.version || '?'} · unstamped`;
  el.textContent = stamp;
  el.classList.toggle('local', stamp.includes('+local'));
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(stamp).then(() => {
      const was = el.textContent;
      el.textContent = 'copied';
      setTimeout(() => { el.textContent = was; }, 1200);
    }, () => {});
  });
}

/** Open (or re-focus) the full-width page on a given view. */
export async function openFullPage(view = 'settings') {
  const base = chrome.runtime.getURL('settings.html');
  const url = `${base}#${view}`;
  const existing = await chrome.tabs.query({ url: `${base}*` });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { url, active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

/** Where the drawer leaves a capture for the full-width page to render. */
export const CAPTURE_KEY = 'lastCapture';

// chrome.storage.session: the capture is a working artefact, not a setting. It
// never touches disk and never shows up in the raw-storage dump.
export async function putCapture(capture) {
  await chrome.storage.session.set({ [CAPTURE_KEY]: capture });
}

export async function getCapture() {
  const { [CAPTURE_KEY]: c } = await chrome.storage.session.get([CAPTURE_KEY]);
  return c || null;
}
