// High-level social-media extraction command.
//
// Runs the generic pipeline (open → wait → scroll → evaluate → close) using an
// extractor fetched from the cloud registry. Works both from automation tasks
// (`{ type: 'social_extract', params: { url } }`) and from the side panel's
// manual mode. The extension ships no extractor of its own: adding a page type
// is a publish, never a build.

import { open_tab, close_tab } from './tab.js';
import { wait_for_selector } from './navigation.js';
import { scroll as scrollCmd } from './scroll.js';
import { evaluate_js } from './evaluate.js';
import {
  resolveEntry, skillFromEntry, detectLocale, pageTypeFromKind, registryStatus,
} from '../registry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function list_social_skills() {
  const status = await registryStatus();
  return {
    registry: status.url,
    uiLocale: status.uiLocale,
    skills: (status.entries || []).map((e) => ({
      id: `${e.platform}.${e.page_type}`,
      platform: e.platform,
      kind: e.page_type,
      locale: e.ui_locale,
      version: e.version,
      pattern: e.url_regex,
      bytes: e.extract_js_bytes,
    })),
  };
}

// Grab the full page HTML (best effort) for the auto-heal loop.
async function grabHtml(tabId) {
  try {
    const { value } = await evaluate_js({ tabId, expression: 'document.documentElement.outerHTML' });
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

// De-dupe key for a merged item — prefer stable IDs, fall back to a content
// fingerprint so we never drop or double-count a post.
function itemKey(it) {
  return it.postUrl || it.vmid || it.profileUrl || it.companyUrl
    || ((it.name || '') + '|' + String(it.textContent || '').slice(0, 80));
}

/**
 * Drive an infinite / virtualized list: scroll to the bottom repeatedly, and
 * extract + merge after every scroll (nodes get recycled out of the DOM, so a
 * single extract at the end would miss everything above the fold). Stops once
 * no new items appear for `stableRounds` consecutive rounds, or after
 * `maxSteps` scrolls.
 *
 * Requires `skill.ITEMS_KEY` (the array field to merge, e.g. 'posts'). Without
 * it, falls back to height-driven scrolling + a single final extract.
 */
async function infiniteScrollExtract({ tabId, skill, s, onStep, extractJs }) {
  const maxSteps     = s.maxSteps || 25;
  const delayMs      = s.delayMs || 2000;
  const stableRounds = s.stableRounds || 3;
  const itemsKey     = skill.ITEMS_KEY || null;
  const selector     = s.selector || null;
  const EXTRACT      = extractJs || skill.EXTRACT_JS;
  // HARD wall-clock budget. A Manifest-V3 service worker is torn down after
  // ~30s of activity; if the scroll/extract loop runs longer, Chrome kills the
  // worker mid-run and NO capture is ever posted (observed on high-volume feeds
  // like /company/<slug>/posts/). Cap the loop so it always finishes in time.
  const budgetMs     = s.budgetMs || 22_000;
  const deadline     = Date.now() + budgetMs;

  const acc = new Map();
  let last = null;
  let best = -1;
  let stale = 0;

  for (let i = 0; i <= maxSteps; i++) {
    if (Date.now() > deadline) { onStep('scroll_budget', { i, merged: itemsKey ? acc.size : best }); break; }
    try {
      const { value } = await evaluate_js({
        tabId,
        expression: EXTRACT,
        awaitPromise: skill.AWAIT_PROMISE === true,
      });
      last = value;
      if (itemsKey && value && Array.isArray(value[itemsKey])) {
        for (const it of value[itemsKey]) {
          const k = itemKey(it);
          if (k && !acc.has(k)) acc.set(k, it);
        }
      }
    } catch (e) {
      onStep('extract_failed', { i, message: e.message });
    }

    const progress = itemsKey ? acc.size : ((last && last.count) || 0);
    onStep('scroll_extract', { i, merged: itemsKey ? acc.size : progress });

    if (progress > best) { best = progress; stale = 0; }
    else if (++stale >= stableRounds) { onStep('scroll_stable', { i, merged: acc.size }); break; }

    if (i === maxSteps) break;
    const params = { tabId, percent: 100, durationMs: 700 };
    if (selector) params.selector = selector;
    try {
      await scrollCmd(params);
    } catch (e) {
      onStep('scroll_failed', { i, message: e.message });
    }
    await sleep(delayMs);
  }

  if (itemsKey && last) {
    return { ...last, [itemsKey]: [...acc.values()], count: acc.size, _debug: undefined };
  }
  return last;
}

/**
 * Everything that happens once a tab is sitting on the right page: re-read the
 * locale, honour the declared waits, scroll the way the entry asks, extract.
 * Shared so that running against an already-open tab is the same code path as
 * a scheduled job, not a second implementation that can drift from it.
 */
async function runOnTab({ tabId, skill, entry, onStep }) {
  // The entry had to be resolved before the tab existed, using the language
  // seen last time. Re-read it now: it is remembered for the next job, and a
  // mismatch is reported rather than silently tolerated.
  const locale = await detectLocale(tabId);
  if (entry.ui_locale !== 'any' && locale !== entry.ui_locale) {
    onStep('locale_changed', { page: locale, entry: entry.ui_locale });
  }

  for (const sel of skill.WAIT_SELECTORS || ['body']) {
    try {
      await wait_for_selector({ tabId, selector: sel, timeoutMs: 20_000 });
      onStep('wait_for_selector', { sel });
    } catch (e) {
      onStep('wait_for_selector_failed', { sel, message: e.message });
    }
  }

  if (skill.WAIT_PREDICATE_JS) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { value } = await evaluate_js({ tabId, expression: skill.WAIT_PREDICATE_JS });
      if (value) break;
      await sleep(400);
    }
    onStep('wait_predicate', {});
  }

  // Scroll + extract. Two strategies:
  //   - fixed paliers ('window'/'pane'): scroll a few times, extract once.
  //   - 'infinite': virtualized/infinite lists (search, feeds) recycle
  //     off-screen nodes, so we extract after every scroll and merge —
  //     otherwise the posts at the top are gone from the DOM by the time we
  //     reach the bottom.
  const s = skill.SCROLL || { strategy: 'window', steps: [20, 40, 60, 80, 100], delayMs: 1500 };
  const extractJs = skill.EXTRACT_JS;

  if (s.strategy === 'infinite') {
    return infiniteScrollExtract({ tabId, skill, s, onStep, extractJs });
  }

  for (const pct of s.steps) {
    const params = { tabId, percent: pct, durationMs: 700 };
    if (s.strategy === 'pane' && s.selector) params.selector = s.selector;
    try {
      await scrollCmd(params);
      onStep('scroll', { pct });
    } catch (e) {
      onStep('scroll_failed', { pct, message: e.message });
    }
    await sleep(s.delayMs);
  }
  await sleep(800); // settle in-flight XHR from the last scroll

  onStep('extract', {});
  const { value } = await evaluate_js({
    tabId,
    expression: extractJs,
    awaitPromise: skill.AWAIT_PROMISE === true,
  });
  return value;
}

/**
 * @param {object} params
 * @param {string} params.url             Social-media URL to extract from
 * @param {string} [params.kind]          Force an extractor: full ID ('linkedin.profile') or bare type ('profile')
 * @param {string} [params.platform]      Optional platform hint when `kind` is a bare type
 * @param {boolean} [params.active=false] Open the tab in the foreground (nice for manual runs)
 * @param {boolean} [params.keepTab=false] Leave the tab open after extraction
 * @param {boolean} [params.captureHtml=false] Attach the page's outerHTML to the
 *        result (and to any thrown error). Powers the auto-heal loop: the test
 *        orchestrator stores it so the extractor can be fixed from real DOM.
 * @param {number} [params.timeoutMs=45000]
 */
export async function social_extract({ url, kind, platform, active = false, keepTab = false, captureHtml = false, extractorUrl = null, timeoutMs = 45_000 } = {}) {
  if (!url) { const e = new Error('social_extract: `url` is required'); e.code = 'BAD_PARAMS'; throw e; }

  const steps = [];
  const onStep = (label, info = {}) => steps.push({ label, ...info, at: Date.now() });

  // One GET against the registry. No cache and no bundled copy: if this fails
  // the job stops, because a half-right selector fails silently and a stopped
  // job does not.
  const entry = await resolveEntry({ url, pageType: pageTypeFromKind(kind) });
  const skill = skillFromEntry(entry, url);
  onStep('registry_entry', {
    page_type: entry.page_type,
    ui_locale: entry.ui_locale,
    version: entry.version,
    bytes: skill.EXTRACT_JS.length,
  });

  const targetUrl = skill.normalizedUrl || url;
  if (targetUrl !== url) onStep('url_normalized', { from: url, to: targetUrl });

  const start = Date.now();
  let tabId = null;
  try {
    onStep('open_tab', { url: targetUrl });
    const opened = await open_tab({ url: targetUrl, active, waitUntil: 'domcontentloaded', timeoutMs });
    tabId = opened.tabId;
    onStep('tab_opened', { tabId });

    const raw = await runOnTab({ tabId, skill, entry, onStep });

    let result = raw;
    if (typeof skill.POST_EXTRACT === 'function') {
      onStep('post_extract', {});
      result = await skill.POST_EXTRACT(tabId, raw);
    }

    let html = null;
    if (captureHtml) {
      html = await grabHtml(tabId);
      onStep('capture_html', { bytes: html ? html.length : 0 });
    }

    onStep('done', { durationMs: Date.now() - start });
    return { skillId: skill.ID, url, targetUrl, durationMs: Date.now() - start, result, steps, html };
  } catch (err) {
    // Auto-heal: attach the live DOM so the orchestrator can hand it back for
    // diagnosis even when the extraction itself blew up.
    if (captureHtml && tabId !== null) {
      try { err.html = await grabHtml(tabId); } catch { /* best effort */ }
    }
    err.steps = steps;
    throw err;
  } finally {
    if (tabId !== null && !keepTab) {
      try { await close_tab({ tabId }); } catch { /* tab already gone */ }
    }
  }
}

/**
 * Extract the page the user is already looking at, without opening or
 * navigating anything. This is the "does the registry still work here?"
 * button: it runs the exact pipeline a scheduled job would run, so a result
 * here means a job would succeed, and a failure here is the same failure.
 *
 * @param {object} [params]
 * @param {string} [params.kind]   Force a page type instead of matching the URL
 * @param {boolean} [params.scroll=true] Honour the entry's scroll plan. Turning
 *        it off keeps the user's scroll position but will under-report lists.
 */
export async function extract_current_page({ kind = null, scroll = true } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) { const e = new Error('no active tab to read'); e.code = 'NO_TAB'; throw e; }
  const url = tab.url || '';
  if (!/^https?:/.test(url)) {
    const e = new Error(`this tab is not a web page (${url.split(':')[0] || 'unknown'}:) — open the page you want to check first`);
    e.code = 'BAD_PARAMS';
    throw e;
  }

  const steps = [];
  const onStep = (label, info = {}) => steps.push({ label, ...info, at: Date.now() });
  const start = Date.now();

  let entry;
  try {
    entry = await resolveEntry({ url, pageType: pageTypeFromKind(kind) });
  } catch (e) {
    if (e.code === 'REGISTRY_MISS') {
      const known = (e.known || []).join(', ');
      const miss = new Error(
        `No page type in the registry matches this URL. Nothing was read.`
        + (known ? ` Published types: ${known}.` : ''),
      );
      miss.code = 'NO_PAGE_TYPE';
      miss.url = url;
      miss.known = e.known || [];
      throw miss;
    }
    throw e;
  }

  const skill = skillFromEntry(entry, url);
  onStep('registry_entry', {
    page_type: entry.page_type,
    ui_locale: entry.ui_locale,
    version: entry.version,
    bytes: skill.EXTRACT_JS.length,
  });

  // The entry may normalise the URL (e.g. a profile's /details/ sub-page back
  // to the profile root). We do not navigate, so say so rather than pretend.
  if (skill.normalizedUrl && skill.normalizedUrl !== url) {
    onStep('url_not_normalized', { would_use: skill.normalizedUrl, reading: url });
  }

  const quiet = { ...skill, SCROLL: scroll ? skill.SCROLL : { strategy: 'window', steps: [], delayMs: 0 } };
  const result = await runOnTab({ tabId: tab.id, skill: quiet, entry, onStep });
  onStep('done', { durationMs: Date.now() - start });

  return {
    url,
    tabTitle: tab.title || null,
    pageType: entry.page_type,
    uiLocale: entry.ui_locale,
    registryVersion: entry.version,
    scrolled: Boolean(scroll && skill.SCROLL),
    durationMs: Date.now() - start,
    result,
    steps,
  };
}

// Backwards-compatible alias.
export const linkedin_extract = social_extract;
