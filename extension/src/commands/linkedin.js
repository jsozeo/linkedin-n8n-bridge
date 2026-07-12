// High-level LinkedIn extraction command.
//
// Runs the generic pipeline (open → wait → scroll → evaluate → close) using an
// extractor from src/linkedin/. Works both from n8n tasks
// (`{ type: 'linkedin_extract', params: { url } }`) and from the side panel's
// manual mode.

import { open_tab, close_tab } from './tab.js';
import { wait_for_selector } from './navigation.js';
import { scroll as scrollCmd } from './scroll.js';
import { evaluate_js } from './evaluate.js';
import { resolveSkill, listSkills } from '../linkedin/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function list_linkedin_skills() {
  return { skills: listSkills() };
}

/**
 * @param {object} params
 * @param {string} params.url             LinkedIn URL to extract from
 * @param {string} [params.kind]          Force an extractor ('profile', 'peopleCompany', 'posts', 'comments', 'jobs')
 * @param {boolean} [params.active=false] Open the tab in the foreground (nice for manual runs)
 * @param {boolean} [params.keepTab=false] Leave the tab open after extraction
 * @param {number} [params.timeoutMs=45000]
 */
export async function linkedin_extract({ url, kind, active = false, keepTab = false, timeoutMs = 45_000 } = {}) {
  if (!url) { const e = new Error('linkedin_extract: `url` is required'); e.code = 'BAD_PARAMS'; throw e; }

  const skill = resolveSkill({ url, kind });
  if (!skill) {
    const e = new Error(kind
      ? `linkedin_extract: unknown kind "${kind}"`
      : `linkedin_extract: no extractor matches ${url}`);
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

    // Scroll pass (never scroll back to top — LinkedIn virtualizes sections).
    const s = (typeof skill.pickScroll === 'function' ? skill.pickScroll(targetUrl) : null)
      || skill.SCROLL
      || { strategy: 'window', steps: [20, 40, 60, 80, 100], delayMs: 1500 };
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
    const { value: raw } = await evaluate_js({
      tabId,
      expression: skill.EXTRACT_JS,
      awaitPromise: skill.AWAIT_PROMISE === true,
    });

    let result = raw;
    if (typeof skill.POST_EXTRACT === 'function') {
      onStep('post_extract', {});
      result = await skill.POST_EXTRACT(tabId, raw);
    }

    onStep('done', { durationMs: Date.now() - start });
    return { skillId: skill.ID, url, targetUrl, durationMs: Date.now() - start, result, steps };
  } finally {
    if (tabId !== null && !keepTab) {
      try { await close_tab({ tabId }); } catch { /* tab already gone */ }
    }
  }
}
