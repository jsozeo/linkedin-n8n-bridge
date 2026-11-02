// Live DOM inspector for the selector registry.
//
// When LinkedIn moves something, the question is always the same: what does the
// page actually expose now? Answering it used to mean saving the page and
// reading it elsewhere. This command answers it from inside the extension: it
// opens the page, optionally puts it in the state where the control exists
// (the comment submit button only renders once there is text), and reports the
// stable handles it can see — plus a verdict on every candidate currently in
// the registry.
//
// Read-only. It never clicks a like, never posts anything, and never touches
// the write budget. The one state change it can make is typing a probe
// character into the comment box, which it deletes again.

import { open_tab, close_tab } from './tab.js';
import { wait_for_selector } from './navigation.js';
import { mouse_move, mouse_click } from './mouse.js';
import { type_text, key_press } from './keyboard.js';
import { evalInPage } from '../cdp.js';
import { sel, getSelectors, refreshSelectors } from '../selectors.js';

const jss = (s) => JSON.stringify(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attributes worth reporting: the ones LinkedIn does not hash between releases.
const INSPECT_JS = `
function __ozeoStable(el) {
  const out = {};
  for (const a of el.attributes) {
    if (/^(aria-label|aria-pressed|aria-expanded|aria-disabled|data-testid|data-view-name|data-urn|data-id|role|type|name|id)$/.test(a.name)) {
      if (a.name === 'id' && /^(ember|react|:r)/.test(a.value)) continue;  // generated
      out[a.name] = String(a.value).slice(0, 120);
    }
  }
  return out;
}
function __ozeoDescribe(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    attrs: __ozeoStable(el),
    text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    inComment: !!el.closest('[id^="replaceableComment_urn:li:comment:"], article[data-id^="urn:li:comment:"]'),
  };
}
function __ozeoInspect(registry, focus) {
  // 1. Verdict on what the registry currently claims.
  const verdict = {};
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      verdict[path] = node.map((cand) => {
        try {
          const n = __ozeoMatches(document, cand).length;
          const vis = __ozeoMatches(document, cand).filter((e) => __ozeoVisible(__ozeoClickable(e))).length;
          return { candidate: typeof cand === 'string' ? cand : cand, matches: n, visible: vis };
        } catch (e) { return { candidate: cand, error: 'invalid selector' }; }
      });
      return;
    }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? path + '.' + k : k);
  };
  walk(registry, '');

  // 2. Everything clickable, so a moved control can be spotted by its label.
  const controls = [];
  for (const el of document.querySelectorAll('button, [role="button"], [contenteditable="true"], [role="textbox"]')) {
    const d = __ozeoDescribe(el);
    if (!d.visible && !focus) continue;
    if (!Object.keys(d.attrs).length && !d.text) continue;
    controls.push(d);
  }

  // 3. The comment rows, with the urns the write commands need.
  const comments = [...document.querySelectorAll('[id^="replaceableComment_urn:li:comment:"], article[data-id^="urn:li:comment:"]')]
    .map((r) => {
      const urn = (r.id || r.getAttribute('data-id') || '').replace(/^replaceableComment_/, '');
      const opt = r.querySelector('[aria-label^="View more options for "]');
      const who = opt ? (opt.getAttribute('aria-label') || '').replace(/^View more options for /, '').replace(/[’']s comment\\.?$/, '') : null;
      return {
        urn,
        author: who,
        nestedReplies: r.querySelectorAll('[id^="replaceableComment_urn:li:comment:"]').length,
        controls: [...r.querySelectorAll('button, [role="button"]')]
          .map((b) => b.getAttribute('aria-label') || ('text:' + (b.innerText || '').trim().slice(0, 24)))
          .filter(Boolean),
      };
    });

  return {
    url: location.href,
    title: document.title,
    activityUrn: (location.href.match(/urn:li:(?:activity|share|ugcPost):\\d+/) || [null])[0],
    verdict,
    controls,
    comments,
    counts: { controls: controls.length, comments: comments.length },
  };
}`;

/** Reuse the geometry/matching helpers so probe and locate agree exactly. */
async function loadHelpers() {
  const { LOCATE_SOURCE } = await import('./linkedinWrite.js');
  return LOCATE_SOURCE;
}

async function clickBySelector(tabId, candidates) {
  const helpers = await loadHelpers();
  const t = await evalInPage(tabId, `(() => { ${helpers}
    return __ozeoLocate(${jss(candidates)}, null, '', null); })()`);
  if (t?.error) return t;
  await mouse_move({ tabId, x: t.centerX, y: t.centerY, startX: 40, startY: 40, steps: 8 });
  await mouse_click({ tabId, x: t.centerX, y: t.centerY });
  return t;
}

/**
 * Open a page and report what the selector registry can and cannot find.
 *
 *   url      page to inspect
 *   prepare  'comment' opens the composer and types a probe character, so the
 *            submit control exists; 'reply' does the same on a comment
 *   commentUrn  which comment, when prepare is 'reply'
 *   path     narrow the verdict to one registry path
 *   keepTab  leave the tab open to look at it yourself
 */
export async function selectors_probe({
  url, prepare = null, commentUrn = null, path = null, active = true, keepTab = false,
} = {}) {
  if (!url) { const e = new Error('selectors_probe: url is required'); e.code = 'BAD_PARAMS'; throw e; }
  await refreshSelectors();
  const registry = await getSelectors();
  const steps = [];
  const step = (label, info = {}) => steps.push({ label, ...info });

  const { tabId } = await open_tab({ url, active, waitUntil: 'domcontentloaded', timeoutMs: 45_000 });
  try {
    try { await wait_for_selector({ tabId, selector: 'main', timeoutMs: 20_000 }); } catch { step('wait_miss'); }
    await sleep(2000);

    let typed = false;
    if (prepare === 'comment' || prepare === 'reply') {
      const opener = prepare === 'reply'
        ? await sel('linkedin.comment.replyButton')
        : await sel('linkedin.post.commentButton');
      const scopeNote = prepare === 'reply' ? { commentUrn } : {};
      const o = await clickBySelector(tabId, opener);
      step('opener', { ...scopeNote, ...(o.error ? { error: o.error } : { label: o.label }) });
      await sleep(1500);

      const box = await clickBySelector(tabId, await sel('linkedin.composer.box'));
      if (!box.error) {
        // One character is enough to make LinkedIn render the submit control.
        await type_text({ tabId, text: 'x', delayMs: 60 });
        typed = true;
        step('typed_probe_char');
        await sleep(1200);
      } else {
        step('composer_miss', { error: box.error });
      }
    }

    const helpers = await loadHelpers();
    const report = await evalInPage(tabId, `(() => { ${helpers}
      ${INSPECT_JS}
      return __ozeoInspect(${jss(registry)}, ${jss(!!prepare)}); })()`);

    if (typed) {
      // Leave the page as we found it.
      await key_press({ tabId, key: 'Backspace' });
      step('probe_char_removed');
    }

    const verdict = report.verdict || {};
    const broken = Object.entries(verdict)
      .filter(([, cands]) => Array.isArray(cands) && cands.length && cands.every((c) => !c.matches))
      .map(([p]) => p);
    const healthy = Object.keys(verdict).length - broken.length;

    return {
      ...report,
      verdict: path ? { [path]: verdict[path] } : verdict,
      summary: {
        registryVersion: registry.version,
        pathsChecked: Object.keys(verdict).length,
        pathsMatching: healthy,
        pathsBroken: broken,
      },
      steps,
    };
  } finally {
    if (!keepTab) { try { await close_tab({ tabId }); } catch { /* already gone */ } }
  }
}
