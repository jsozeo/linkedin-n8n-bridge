// High-level social-media extraction command.
//
// Runs the generic pipeline (open → wait → scroll → evaluate → close) using an
// extractor from src/extractors/<platform>/. Works both from automation tasks
// (`{ type: 'social_extract', params: { url } }`) and from the side panel's
// manual mode. Currently ships LinkedIn extractors; more platforms plug into
// src/extractors/index.js as they land.

import { open_tab, close_tab } from './tab.js';
import { wait_for_selector } from './navigation.js';
import { scroll as scrollCmd } from './scroll.js';
import { evaluate_js } from './evaluate.js';
import { resolveSkill, listSkills } from '../extractors/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function list_social_skills() {
  return { skills: listSkills() };
}

// DEV auto-heal loop: fetch the extractor body from the test orchestrator so
// parsers can be fixed remotely (in S3) without reloading the extension. The
// endpoint returns the exact EXTRACT_JS IIFE string. Falls back to the bundled
// skill.EXTRACT_JS on any failure. No-op in the public build (no extractorUrl).
async function resolveExtractJs(skill, extractorUrl, onStep) {
  if (!extractorUrl) return skill.EXTRACT_JS;
  try {
    const res = await fetch(extractorUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text && text.trim().length > 20) {
      onStep('remote_extractor', { bytes: text.length });
      return text;
    }
    throw new Error('empty body');
  } catch (e) {
    onStep('remote_extractor_failed', { message: e.message });
    return skill.EXTRACT_JS;
  }
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

  const skill = resolveSkill({ url, kind, platform });
  if (!skill) {
    const e = new Error(kind
      ? `social_extract: unknown kind "${kind}"`
      : `social_extract: no extractor matches ${url}`);
    e.code = 'NO_SKILL'; throw e;
  }

  const steps = [];
  const onStep = (label, info = {}) => steps.push({ label, ...info, at: Date.now() });

  const targetUrl = (typeof skill.normalizeUrl === 'function') ? skill.normalizeUrl(url) : url;
  if (targetUrl !== url) onStep('url_normalized', { from: url, to: targetUrl });

  const start = Date.now();
  let tabId = null;
  try {
    onStep('open_tab', { url: targetUrl });
    const opened = await open_tab({ url: targetUrl, active, waitUntil: 'domcontentloaded', timeoutMs });
    tabId = opened.tabId;
    onStep('tab_opened', { tabId });

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
    const s = (typeof skill.pickScroll === 'function' ? skill.pickScroll(targetUrl) : null)
      || skill.SCROLL
      || { strategy: 'window', steps: [20, 40, 60, 80, 100], delayMs: 1500 };

    const extractJs = await resolveExtractJs(skill, extractorUrl, onStep);

    let raw;
    if (s.strategy === 'infinite') {
      raw = await infiniteScrollExtract({ tabId, skill, s, onStep, extractJs });
    } else {
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
      ({ value: raw } = await evaluate_js({
        tabId,
        expression: extractJs,
        awaitPromise: skill.AWAIT_PROMISE === true,
      }));
    }

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

// Backwards-compatible alias.
export const linkedin_extract = social_extract;
