// LinkedIn write actions: like a post, like a comment, like a reply, comment
// on a post, reply to a comment, send a connection invitation.
//
// Three rules shape every handler here.
//
// 1. Clicks go through CDP Input.* (via mouse.js), never element.click(), so
//    the page sees isTrusted events. The existing extractors use .click() for
//    pagination, which is fine for reading but not for writing.
// 2. No selector is hardcoded. Everything resolves through the cloud registry
//    in ../selectors.js, so a LinkedIn DOM change is a JSON push, not a build.
// 3. Nothing reaches LinkedIn before checkBudget() clears it, and the budget
//    is consumed only once the action is confirmed in the DOM.
//
// Every handler accepts `dryRun: true`, which walks the whole path — open the
// tab, resolve the target, scroll it into view — and stops short of the click.
// That is how you validate a selector change without spending an action.

import { open_tab, close_tab } from './tab.js';
import { wait_for_selector } from './navigation.js';
import { mouse_move, mouse_click } from './mouse.js';
import { type_text } from './keyboard.js';
import { evalInPage } from '../cdp.js';
import { sel, refreshSelectors } from '../selectors.js';
import { checkBudget, consumeBudget, jitter, sleep } from '../guard.js';

const jss = (s) => JSON.stringify(s);
const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_PARAMS'; throw e; };

// ---------------------------------------------------------------------------
// In-page target resolution
// ---------------------------------------------------------------------------

// Walks a candidate list and returns the viewport geometry of the first hit,
// after scrolling it into view.
//   scope   — restrict the search to the container whose id/data-id/data-urn
//             contains `scopeMatch` (one comment row, or one post).
//   exclude — skip any hit sitting inside one of these. A post permalink
//             carries a "React Like" button per comment as well as its own, so
//             without this a post-level like can land on a comment.
// A candidate is either a CSS string or { css?, text? }. The text form exists
// because SDUI renders some controls ("See previous replies") as plain divs
// with no label at all, so the only stable handle is what the user reads.
const LOCATE_JS = `
function __ozeoClickable(el) {
  // The label is often on an inner <svg>, not on the control. Climb to whatever
  // actually takes the click, so one selector covers both shapes.
  return el.closest('button, [role="button"], a[href], [role="link"]') || el;
}
function __ozeoVisible(el) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function __ozeoMatches(root, cand) {
  if (typeof cand === 'string') return [...root.querySelectorAll(cand)];
  const out = [];
  if (cand.css) out.push(...root.querySelectorAll(cand.css));
  if (cand.text) {
    const want = cand.text.trim().toLowerCase();
    for (const el of root.querySelectorAll('button, [role="button"], div, span, a')) {
      if (el.children.length) continue;                 // leaf nodes only
      if ((el.textContent || '').trim().toLowerCase() === want) out.push(el);
    }
  }
  return out;
}
function __ozeoReport(el, cand) {
  const c = __ozeoClickable(el);
  const r = c.getBoundingClientRect();
  const label = c.getAttribute('aria-label') || el.getAttribute('aria-label') || '';
  return {
    selector: typeof cand === 'string' ? cand : JSON.stringify(cand),
    centerX: r.x + r.width / 2,
    centerY: r.y + r.height / 2,
    label,
    pressed: c.getAttribute('aria-pressed'),
    disabled: c.disabled === true || c.getAttribute('aria-disabled') === 'true',
    tag: c.tagName.toLowerCase(),
    text: (c.innerText || '').trim().slice(0, 80),
  };
}
function __ozeoLocate(cands, scopeSel, scopeMatch, excludeSel) {
  let root = document;
  if (scopeSel && scopeSel.length) {
    const rows = [];
    for (const s of scopeSel) rows.push(...__ozeoMatches(document, s));
    root = scopeMatch
      ? rows.find((r) => {
          const keys = (r.id || '') + '|' + (r.getAttribute('data-id') || '') + '|' + (r.getAttribute('data-urn') || '');
          return keys.includes(scopeMatch);
        })
      : rows[0];
    if (!root) return { error: 'scope_not_found', tried: rows.length };
  }
  const banned = [];
  for (const s of (excludeSel || [])) banned.push(...__ozeoMatches(document, s));
  const inBanned = (el) => banned.some((b) => b.contains(el));

  for (const cand of cands) {
    for (const el of __ozeoMatches(root, cand)) {
      if (inBanned(el)) continue;
      const c = __ozeoClickable(el);
      if (inBanned(c)) continue;
      if (!__ozeoVisible(c)) continue;
      c.scrollIntoView({ block: 'center', behavior: 'instant' });
      return __ozeoReport(el, cand);
    }
  }
  return { error: 'not_found' };
}`;

// probe.js injects the same helpers, so the inspector and the write actions can
// never disagree about what "matches" or "visible" means.
export const LOCATE_SOURCE = LOCATE_JS;

async function locate(tabId, candidates, { scope = null, scopeMatch = '', exclude = null } = {}) {
  if (!candidates.length) return { error: 'no_candidates' };
  const expr = `(() => { ${LOCATE_JS}
    return __ozeoLocate(${jss(candidates)}, ${scope ? jss(scope) : 'null'}, ${jss(scopeMatch)}, ${exclude ? jss(exclude) : 'null'});
  })()`;
  // Geometry settles a beat after scrollIntoView; re-read rather than guess.
  const first = await evalInPage(tabId, expr);
  if (first?.error) return first;
  await sleep(250);
  return (await evalInPage(tabId, expr)) || first;
}

// Finding the submit control is its own problem. LinkedIn only renders it once
// the box has text, so it can never be read off a capture of a fresh page, and
// a fixed selector is guesswork. Instead we anchor on the editor — which is
// stable — and look outward for the one enabled control that is not a known
// accessory. The result reports how it was found so a confirmed selector can be
// promoted into the registry.
const FIND_SUBMIT_JS = `
function __ozeoFindSubmit(boxCands, submitCands, accessoryCands, scopeSel, scopeMatch) {
  let root = document;
  if (scopeSel && scopeSel.length && scopeMatch) {
    const rows = [];
    for (const s of scopeSel) rows.push(...__ozeoMatches(document, s));
    const row = rows.find((r) => ((r.id || '') + '|' + (r.getAttribute('data-id') || '')).includes(scopeMatch));
    if (row) root = row;
  }

  // 1. Known candidates win, restricted to the scope we were given.
  for (const cand of submitCands) {
    for (const el of __ozeoMatches(root, cand)) {
      const c = __ozeoClickable(el);
      if (c.disabled || c.getAttribute('aria-disabled') === 'true') continue;
      if (!__ozeoVisible(c)) continue;
      c.scrollIntoView({ block: 'center', behavior: 'instant' });
      return Object.assign(__ozeoReport(el, cand), { how: 'registry' });
    }
  }

  // 2. Fall back to the shape of the composer.
  let box = null;
  for (const cand of boxCands) { const m = __ozeoMatches(root, cand); if (m.length) { box = m[0]; break; } }
  if (!box) return { error: 'composer_not_found' };

  const accessories = [];
  for (const cand of accessoryCands) accessories.push(...__ozeoMatches(document, cand));
  const isAccessory = (el) => accessories.some((a) => a === el || a.contains(el) || el.contains(a));

  // Widen from the editor until something plausible appears. The submit is
  // rendered as a sibling of the accessory row, a level or two above the box.
  let container = box;
  for (let up = 0; up < 6; up++) {
    container = container.parentElement;
    if (!container) break;
    const found = [...container.querySelectorAll('button, [role="button"]')].filter((c) => {
      if (c.disabled || c.getAttribute('aria-disabled') === 'true') return false;
      if (c.contains(box) || box.contains(c)) return false;
      if (isAccessory(c)) return false;
      return __ozeoVisible(c);
    });
    if (found.length) {
      // Right-most, then lowest: submit sits at the end of the accessory row.
      found.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.top - ra.top) || (rb.left - ra.left);
      });
      const c = found[0];
      c.scrollIntoView({ block: 'center', behavior: 'instant' });
      return Object.assign(__ozeoReport(c, 'composer-shape'), {
        how: 'heuristic', levelsUp: up + 1, alternatives: found.length,
        candidates: found.slice(0, 5).map((e) => ({
          tag: e.tagName.toLowerCase(),
          label: e.getAttribute('aria-label') || '',
          text: (e.innerText || '').trim().slice(0, 30),
          testid: e.getAttribute('data-testid') || '',
        })),
      });
    }
  }
  return { error: 'submit_not_found' };
}`;

async function findSubmit(tabId, { scope = null, scopeMatch = '' } = {}) {
  const expr = `(() => { ${LOCATE_JS}
    ${FIND_SUBMIT_JS}
    return __ozeoFindSubmit(
      ${jss(await sel('linkedin.composer.box'))},
      ${jss(await sel('linkedin.composer.submit'))},
      ${jss(await sel('linkedin.composer.accessories'))},
      ${scope ? jss(scope) : 'null'}, ${jss(scopeMatch)});
  })()`;
  return await evalInPage(tabId, expr);
}

/**
 * Has this reaction control been activated?
 * SDUI pages carry no aria-pressed — the state is spelled out in the label
 * ("Reaction button state: no reaction" vs "… Like"), so fall back to that.
 */
function isReacted(target, unreactedWords) {
  if (target.pressed === 'true') return true;
  if (target.pressed === 'false') return false;
  const label = String(target.label || '').toLowerCase();
  if (!label) return null;
  return !unreactedWords.some((w) => label.includes(String(w).toLowerCase()));
}

/** Post permalinks embed the activity urn; it is how we pin a post-level action. */
function activityUrn(url) {
  const m = /urn:li:(?:activity|share|ugcPost):(\d+)/.exec(String(url || ''));
  return m ? m[0] : '';
}

/** Trusted click: glide the cursor in, then press. */
async function humanClick(tabId, target) {
  await mouse_move({
    tabId,
    x: target.centerX,
    y: target.centerY,
    startX: Math.max(10, target.centerX - jitter(180)),
    startY: Math.max(10, target.centerY - jitter(140)),
    steps: 12 + Math.floor(Math.random() * 8),
    stepDelayMs: jitter(16),
  });
  await sleep(jitter(220));
  await mouse_click({ tabId, x: target.centerX, y: target.centerY, holdMs: jitter(70) });
}

/** Type into a contenteditable at a human cadence. */
async function humanType(tabId, text) {
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    await type_text({ tabId, text: word, delayMs: jitter(85) });
    await sleep(jitter(120));
  }
}

// ---------------------------------------------------------------------------
// Tab lifecycle shared by every action
// ---------------------------------------------------------------------------

async function onPage(url, { active, keepTab, waitFor }, fn) {
  if (!url) bad('url is required');
  await refreshSelectors();                      // picks up a selector push without a reload
  const steps = [];
  const step = (label, info = {}) => steps.push({ label, ...info, at: Date.now() });

  const { tabId } = await open_tab({ url, active, waitUntil: 'domcontentloaded', timeoutMs: 45_000 });
  step('tab_open', { tabId, url });
  try {
    for (const s of waitFor || ['main']) {
      try { await wait_for_selector({ tabId, selector: s, timeoutMs: 20_000 }); step('wait_ok', { selector: s }); }
      catch { step('wait_miss', { selector: s }); }
    }
    await sleep(jitter(1200));                   // let the feed hydrate before touching it
    const data = await fn(tabId, step);
    return { ...data, steps };
  } catch (e) {
    e.steps = steps;
    throw e;
  } finally {
    if (!keepTab) { try { await close_tab({ tabId }); } catch { /* already gone */ } }
  }
}

function notFound(what, where) {
  const e = new Error(`${what} not found on ${where} — the selector registry is probably stale`);
  e.code = 'NOT_FOUND';
  throw e;
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

async function doLike(tabId, step, { path, scope, scopeMatch, exclude, unlike, dryRun, what }) {
  const cands = await sel(path);
  const unreacted = await sel('linkedin.reaction.unreactedLabel');
  const where = { scope, scopeMatch, exclude };
  const t = await locate(tabId, cands, where);
  if (t.error) notFound(what, t.error);
  step('target', { selector: t.selector, label: t.label, tag: t.tag });

  const already = isReacted(t, unreacted);
  if (already === !unlike) {
    step('noop', { reason: unlike ? 'already unliked' : 'already liked' });
    return { ok: true, changed: false, alreadyLiked: already, target: t.label };
  }
  if (dryRun) return { ok: true, changed: false, dryRun: true, target: t.label, selector: t.selector };

  await checkBudget('like');
  await humanClick(tabId, t);
  await sleep(jitter(1300));

  const after = await locate(tabId, cands, where);
  const now = after.error ? null : isReacted(after, unreacted);
  // `null` means the page exposes no readable state; the click went out but we
  // refuse to claim success we cannot see, and we do not spend budget on it.
  const confirmed = now === !unlike;
  if (confirmed) await consumeBudget('like');
  step('after', { label: after.label, reacted: now, confirmed });

  return {
    ok: confirmed,
    changed: confirmed,
    stateUnreadable: now === null,
    target: t.label,
    selector: t.selector,
  };
}

export async function linkedin_like_post({ url, unlike = false, dryRun = false, active = false, keepTab = false } = {}) {
  const exclude = await sel('linkedin.commentRowMarkers');
  return onPage(url, { active, keepTab, waitFor: ['main'] }, async (tabId, step) =>
    doLike(tabId, step, {
      path: 'linkedin.post.likeButton',
      scope: await sel('linkedin.post.root'), scopeMatch: activityUrn(url),
      exclude, unlike, dryRun, what: 'post like button',
    }));
}

export async function linkedin_like_comment({ url, commentUrn, unlike = false, dryRun = false, active = false, keepTab = false } = {}) {
  if (!commentUrn) bad('commentUrn is required (e.g. urn:li:comment:(activity:123,456))');
  const scope = await sel('linkedin.comment.row');
  return onPage(url, { active, keepTab, waitFor: ['main'] }, (tabId, step) =>
    doLike(tabId, step, {
      path: 'linkedin.comment.likeButton', scope, scopeMatch: commentUrn,
      unlike, dryRun, what: `like button for ${commentUrn}`,
    }));
}

// A reply is itself a comment with its own urn, so the same row lookup works.
// The only extra work is expanding the replies list first.
export async function linkedin_like_reply({ url, replyUrn, parentUrn, unlike = false, dryRun = false, active = false, keepTab = false } = {}) {
  if (!replyUrn) bad('replyUrn is required');
  const scope = await sel('linkedin.comment.row');
  return onPage(url, { active, keepTab, waitFor: ['main'] }, async (tabId, step) => {
    await expandReplies(tabId, step, parentUrn);
    return doLike(tabId, step, {
      path: 'linkedin.comment.likeButton', scope, scopeMatch: replyUrn,
      unlike, dryRun, what: `like button for reply ${replyUrn}`,
    });
  });
}

/** Replies are collapsed by default; click every "show previous replies". */
async function expandReplies(tabId, step, parentUrn) {
  const cands = await sel('linkedin.comment.showMoreReplies');
  if (!cands.length) return;
  for (let i = 0; i < 4; i++) {
    const t = await locate(tabId, cands, parentUrn
      ? { scope: await sel('linkedin.comment.row'), scopeMatch: parentUrn }
      : {});
    if (t.error) break;
    await humanClick(tabId, t);
    step('expand_replies', { round: i + 1 });
    await sleep(jitter(1400));
  }
}

// ---------------------------------------------------------------------------
// Comments and replies
// ---------------------------------------------------------------------------

async function writeComment(tabId, step, { openPath, scope, scopeMatch, exclude, text, dryRun, what }) {
  const opener = await locate(tabId, await sel(openPath), { scope, scopeMatch, exclude });
  if (opener.error) notFound(what, opener.error);
  await humanClick(tabId, opener);
  step('composer_open', { selector: opener.selector });
  await sleep(jitter(1400));

  // Once the reply composer is open it lives inside the comment row, so the
  // same scope keeps us off the post-level composer at the top of the page.
  const where = scopeMatch ? { scope, scopeMatch } : { exclude };
  const boxCands = await sel('linkedin.composer.box');
  const box = await locate(tabId, boxCands, where);
  if (box.error) notFound('comment composer', box.error);

  if (dryRun) return { ok: true, posted: false, dryRun: true, composer: box.selector };

  await checkBudget('comment');
  await humanClick(tabId, box);
  await sleep(jitter(500));
  await humanType(tabId, text);
  step('typed', { chars: text.length });
  await sleep(jitter(900));

  // Only now does the submit control exist, so look for it after typing.
  const submit = await findSubmit(tabId, { scope, scopeMatch });
  if (submit.error) {
    step('submit_missing', submit);
    const e = new Error(`submit button not found (${submit.error}) — run selectors_probe with prepare:"comment" on this URL to see what the composer renders once there is text`);
    e.code = 'NOT_FOUND';
    throw e;
  }
  step('submit_found', { how: submit.how, label: submit.label, text: submit.text, levelsUp: submit.levelsUp });
  await humanClick(tabId, submit);
  await sleep(jitter(2200));

  // Confirmed when the composer has emptied out again.
  const empty = await evalInPage(tabId, `(() => {
    for (const s of ${jss(boxCands)}) {
      const el = document.querySelector(s);
      if (el) return (el.innerText || '').trim().length === 0;
    }
    return false;
  })()`);
  if (empty) await consumeBudget('comment');
  step('submitted', { confirmed: !!empty });

  return { ok: !!empty, posted: !!empty, chars: text.length };
}

export async function linkedin_comment_post({ url, text, dryRun = false, active = false, keepTab = false } = {}) {
  if (!text || !text.trim()) bad('text is required');
  const exclude = await sel('linkedin.commentRowMarkers');
  return onPage(url, { active, keepTab, waitFor: ['main'] }, (tabId, step) =>
    writeComment(tabId, step, {
      openPath: 'linkedin.post.commentButton', exclude, text, dryRun, what: 'comment button',
    }));
}

export async function linkedin_reply_comment({ url, commentUrn, text, dryRun = false, active = false, keepTab = false } = {}) {
  if (!commentUrn) bad('commentUrn is required');
  if (!text || !text.trim()) bad('text is required');
  const scope = await sel('linkedin.comment.row');
  return onPage(url, { active, keepTab, waitFor: ['main'] }, (tabId, step) =>
    writeComment(tabId, step, {
      openPath: 'linkedin.comment.replyButton', scope, scopeMatch: commentUrn,
      text, dryRun, what: `reply button for ${commentUrn}`,
    }));
}

// ---------------------------------------------------------------------------
// Connection invitation
// ---------------------------------------------------------------------------

export async function linkedin_invite({ url, note = '', dryRun = false, active = false, keepTab = false } = {}) {
  return onPage(url, { active, keepTab, waitFor: ['main'] }, async (tabId, step) => {
    const pending = await locate(tabId, await sel('linkedin.profile.pendingMarker'));
    if (!pending.error) {
      step('noop', { reason: 'invitation already pending' });
      return { ok: true, sent: false, alreadyPending: true };
    }

    // Connect sits on the action bar on some profiles and under "More" on others.
    let connect = await locate(tabId, await sel('linkedin.profile.connectButton'));
    if (connect.error) {
      const more = await locate(tabId, await sel('linkedin.profile.moreButton'));
      if (more.error) notFound('Connect button (and More menu)', more.error);
      await humanClick(tabId, more);
      step('more_menu');
      await sleep(jitter(900));
      connect = await locate(tabId, await sel('linkedin.profile.moreConnectItem'));
      if (connect.error) notFound('Connect entry in the More menu', connect.error);
    }

    if (dryRun) return { ok: true, sent: false, dryRun: true, selector: connect.selector };

    await checkBudget('invite');
    await humanClick(tabId, connect);
    step('connect_clicked', { selector: connect.selector });
    await sleep(jitter(1600));

    if (note && note.trim()) {
      const addNote = await locate(tabId, await sel('linkedin.profile.addNote'));
      if (!addNote.error) {
        await humanClick(tabId, addNote);
        await sleep(jitter(800));
        const box = await locate(tabId, await sel('linkedin.profile.noteBox'));
        if (!box.error) { await humanClick(tabId, box); await humanType(tabId, note.trim()); step('note_typed'); }
      }
      const send = await locate(tabId, await sel('linkedin.profile.sendInvite'));
      if (send.error) notFound('Send invitation button', send.error);
      await humanClick(tabId, send);
    } else {
      // Prefer the explicit no-note path; fall back to the generic send.
      let send = await locate(tabId, await sel('linkedin.profile.sendWithoutNote'));
      if (send.error) send = await locate(tabId, await sel('linkedin.profile.sendInvite'));
      if (send.error) notFound('Send button in the invitation modal', send.error);
      await humanClick(tabId, send);
    }
    await sleep(jitter(2400));

    const after = await locate(tabId, await sel('linkedin.profile.pendingMarker'));
    const confirmed = !after.error;
    if (confirmed) await consumeBudget('invite');
    step('sent', { confirmed });

    // Leave no modal behind if the confirmation never appeared.
    if (!confirmed) {
      const x = await locate(tabId, await sel('linkedin.profile.dismissModal'));
      if (!x.error) await humanClick(tabId, x);
    }
    return { ok: confirmed, sent: confirmed, withNote: !!(note && note.trim()) };
  });
}
