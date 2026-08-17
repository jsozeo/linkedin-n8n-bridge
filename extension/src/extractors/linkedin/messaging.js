// LinkedIn messaging extractor — list the most recent conversations.
//
// The requested flow was "start on /feed/ and click Messaging in the top nav".
// In practice clicking that entry triggers a FULL page navigation, which
// destroys the CDP execution context mid-evaluate ("Inspected target navigated
// or closed") so the extraction can never return. Opening /messaging/ directly
// produces the exact same destination in the same logged-in session, so we
// rewrite the target URL via normalizeUrl and read the conversation rail there.
//
// LinkedIn's messaging rail still uses stable Ember component classes
// (.msg-conversation-*) but we also fall back to href-based detection
// (a[href*="/messaging/thread/"]) so a class rename doesn't break extraction.

import { evalAsyncScript } from './_helpers.js';

export const ID = 'linkedin.messaging';
export const STEP_KEYS = ['get_conversations'];
export const URL_PATTERN = /linkedin\.com\/(feed\/?$|messaging)/i;

// Always land on the messaging inbox, whatever URL the job passes (e.g. /feed/).
export function normalizeUrl() {
  return 'https://www.linkedin.com/messaging/';
}

export const WAIT_SELECTORS = ['main', 'a[href*="/messaging/thread/"]'];

// The async EXTRACT scrolls the conversation rail itself.
export const SCROLL = { strategy: 'window', steps: [], delayMs: 400 };

export const AWAIT_PROMISE = true;

const MAX_CONVERSATIONS = 20;

export const EXTRACT_JS = evalAsyncScript(`
  const MAX = ${MAX_CONVERSATIONS};
  // The 2026 inbox renders conversations as <li class="msg-conversation-listitem">
  // wrapping a .msg-conversation-card — NOT as /messaging/thread/ anchors.
  const cardEls = () => {
    let els = $$('.msg-conversation-listitem');
    if (!els.length) els = $$('.msg-conversation-card').map((c) => c.closest('li') || c);
    return els;
  };

  // We are opened directly on /messaging/ (see normalizeUrl) — no in-page click,
  // which would trigger a full navigation and destroy this eval context.
  // ── Wait for the conversation rail to render ───────────────────────────────
  const WAIT_DEADLINE = Date.now() + 12000;
  while (Date.now() < WAIT_DEADLINE && cardEls().length === 0) {
    await sleep(400);
  }
  await sleep(800);

  const TIME_RE = /^(\\d{1,2}:\\d{2}\\s?(AM|PM)?|\\d{1,2}\\s?(min|h|hr|d|w|mo|y)|Now|Just now|Yesterday|Hier|[A-Z][a-zà-ÿ]{2,8}\\.?\\s?\\d{0,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})$/i;

  // Parse ONE card. Returns null for occluded/empty placeholders (no name) so
  // the virtualized list doesn't pollute results with blank rows.
  const parseCard = (card) => {
    const nameEl = $1('.msg-conversation-card__participant-names, .msg-conversation-listitem__participant-names', card);
    const snippetEl = $1('.msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet-body', card);
    const timeEl = $1('.msg-conversation-card__time-stamp, time', card);
    const lines = (card.innerText || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);

    let name = txt(nameEl);
    if (!name) name = lines.find((l) => l.length > 1 && l.length < 80 && !TIME_RE.test(l)) || null;
    if (!name) return null; // occluded / not yet rendered

    let time = txt(timeEl);
    if (!time) time = lines.find((l) => TIME_RE.test(l)) || null;

    let snippet = txt(snippetEl);
    if (!snippet) {
      snippet = lines
        .filter((l) => l !== name && l !== time && !TIME_RE.test(l))
        .sort((a, b) => b.length - a.length)[0] || null;
    }
    // Snippet is usually prefixed with the sender ("You: …" / "<Name>: …").

    const inLink = $1('a[href*="/in/"]', card);
    const profileUrl = inLink ? canonicalLi((inLink.getAttribute('href') || '').split('?')[0]) : null;

    const avatarImg = $$('img', card).find((img) => { const s = img.getAttribute('src') || ''; return s && !s.startsWith('data:'); });
    const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : null;

    const statusTxt = txt($1('.msg-conversation-card__conversation-status', card)) || '';
    const unread = !!$1('.msg-conversation-card__unread-count, .notification-badge--show, [aria-label*="unread" i]', card)
      || /unread|non lu/i.test((card.getAttribute('class') || '') + ' ' + statusTxt);
    const sponsored = /\\bsponsored\\b|sponsoris/i.test(card.innerText || '');

    return {
      name, snippet, time, unread, sponsored,
      participant_profile_url: profileUrl,
      avatar_url: avatarUrl,
    };
  };

  // ── Harvest incrementally while scrolling ──────────────────────────────────
  // The rail is virtualized: only ~14 cards live in the DOM at once, and top
  // cards get recycled as you scroll down. So we extract on every scroll step
  // and MERGE, keyed by the ember card id (stable within a session) with a
  // name+time fallback, until we have MAX filled rows or run out of runway.
  const findRail = () => {
    const seed = $1('.msg-conversations-container__conversations-list') || cardEls()[0];
    let el = seed, guard = 0;
    while (el && guard++ < 25) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8) return el;
      el = el.parentElement;
    }
    return $1('.msg-conversations-container__conversations-list') || document.scrollingElement || document.documentElement;
  };
  const rail = findRail();

  const results = new Map();
  const harvest = () => {
    for (const li of cardEls()) {
      const cardEl = $1('.msg-conversation-card', li) || li;
      const cardId = (cardEl && cardEl.id) || li.id || null;
      const parsed = parseCard(li);
      if (!parsed) continue;
      const key = cardId || (parsed.name + '|' + (parsed.time || ''));
      if (!results.has(key)) results.set(key, { card_id: cardId, ...parsed });
    }
  };

  harvest();
  const SCROLL_DEADLINE = Date.now() + 12000;
  let stale = 0;
  while (Date.now() < SCROLL_DEADLINE && stale < 4 && results.size < MAX) {
    const before = results.size;
    try { rail.scrollTop = Math.min(rail.scrollTop + rail.clientHeight * 0.9, rail.scrollHeight); rail.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
    await sleep(650);
    harvest();
    if (results.size <= before) stale++; else stale = 0;
  }

  const conversations = [...results.values()].slice(0, MAX);

  const _probe = {
    onMessaging: /\\/messaging(\\/|$)/.test(location.pathname),
    listitems: $$('.msg-conversation-listitem').length,
    cards: $$('.msg-conversation-card').length,
    harvested: results.size,
    railTag: rail && rail.tagName,
    railClass: rail && (rail.getAttribute && rail.getAttribute('class') || '').slice(0, 60),
  };

  return {
    conversations,
    count: conversations.length,
    url: location.href,
    title: document.title,
    _probe,
  };
`);
