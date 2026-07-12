import { evalAsyncScript } from './_helpers.js';

export const ID = 'linkedin.comments';
// ozeo-leadgen dispatch step(s).
export const STEP_KEYS = ['get_comments'];
// Three URL shapes:
//   /feed/update/urn:li:activity:<id>/       — single post permalink (post + N comments)
//   /posts/<slug>_<title>-<id>-<token>/      — single post vanity URL (same content)
//   /in/<slug>/recent-activity/comments/     — list of comments made by a person
export const URL_PATTERN = /linkedin\.com\/(feed\/update\/urn:li:activity:\d+\/?|posts\/[^/?#]+\/?|in\/[^/]+\/recent-activity\/comments\/?)/i;

export const WAIT_SELECTORS = ['main', '[aria-label$="\u2019s comment"], [aria-label$="\'s comment"]'];

// Comments paginate via a "Load more comments" button. We scroll the
// window to reveal it, then click it programmatically before each step.
export const SCROLL = { strategy: 'window', steps: [25, 50, 75, 100], delayMs: 2500 };

// We click "Load more comments" repeatedly in-page, so the extractor returns a
// Promise that the runner must await.
export const AWAIT_PROMISE = true;

export const EXTRACT_JS = evalAsyncScript(`
  // ── "Load more comments" loop ────────────────────────────────────────────
  // The single-post page shows ~5 comments initially and offers a button to
  // load more. Sometimes a "View previous reply" / "Show more replies" button
  // appears on nested threads. We click them all with a stale-rounds guard.
  const LOAD_RE = /^(Load more comments|Voir plus de commentaires|Show more comments|View more comments|Charger plus de commentaires|Voir d.?autre.?? commentaires?|Show more replies|Voir d.?autre.?? r[ée]ponses?|View previous repl(?:y|ies)|View \\d+ previous repl(?:y|ies))$/i;
  const countAnchors = () => document.querySelectorAll(
    '[aria-label$="\\u2019s comment"], [aria-label$="\\'s comment"], [aria-label^="Reply to "]'
  ).length;
  let stale = 0, attempts = 0;
  while (attempts < 30 && stale < 3) {
    const prev = countAnchors();
    const btns = Array.from(document.querySelectorAll('button'))
      .filter((b) => !b.disabled && LOAD_RE.test((b.textContent || '').trim()));
    if (btns.length === 0) break;
    for (const btn of btns) {
      try {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
      } catch (_) {}
    }
    await sleep(1500);
    const next = countAnchors();
    if (next <= prev) stale++; else stale = 0;
    attempts++;
  }
  await sleep(500);


  // Anchor each comment on the "Reply to <Author>'s comment" aria-label,
  // present exactly once per comment regardless of nesting. LinkedIn renders
  // the apostrophe as a curly quote (U+2019), not a straight one.
  const replyButtons = $$('[aria-label^="Reply to "]')
    .filter((el) => /[\\u2019\\u0027]s comment$/.test(attr(el, 'aria-label') || ''));

  // Parent post (single-post permalink).
  // The page exposes ONE .feed-shared-update-v2 wrapper that contains both the
  // post AND the comments list. We scope post-only fields by excluding nodes
  // inside .comments-comments-list.
  const postCard = $1('.feed-shared-update-v2') || $1('.fie-impression-container');
  const commentsListEl = $1('.comments-comments-list');

  let post = null;
  if (postCard) {
    // Author: LinkedIn renders TWO author links in the post header:
    //   1. A graphic-only link with aria-label "View <Name>'s graphic link"
    //   2. A textual link with aria-label "View: <Name> [Verified •] <degree>
    //      <Headline>" (colon after View) — this is the one we want because
    //      its aria-label gives us BOTH the clean name AND the headline.
    const headerLinks = $$('a[href*="/in/"], a[href*="/company/"]', postCard)
      .filter((a) => !commentsListEl || !commentsListEl.contains(a));
    // Prefer the link whose aria-label starts with "View:" (textual link).
    let authorLink = headerLinks.find((a) => /^View:/.test(attr(a, 'aria-label') || ''))
                  || headerLinks.find((a) => (a.textContent || '').trim().length > 0)
                  || headerLinks[0]
                  || null;
    let authorName = null, authorHeadline = null;
    if (authorLink) {
      const aria = attr(authorLink, 'aria-label') || '';
      // 1) Try the structured aria-label first
      const m = aria.match(/^View:\\s+(.+?)\\s+(?:Verified\\s*[•·]\\s*)?(?:1st|2nd|3rd|You|Vous)\\s+(.+)$/i);
      if (m) {
        authorName = m[1].trim();
        authorHeadline = m[2].trim();
      } else {
        // 2) Fallback: textContent is often "Name" duplicated (visible+hidden)
        const raw = (authorLink.textContent || '').replace(/\\s+/g, ' ').trim();
        const half = raw.slice(0, Math.floor(raw.length / 2));
        if (raw.length > 2 && raw === half + half) authorName = half;
        else if (raw.length >= 2 && raw.length < 80) authorName = raw;
        else if (aria) authorName = aria.replace(/^View:?\\s*/, '').split(/[•·]/)[0].trim();
      }
    }
    const authorHref = authorLink ? canonicalLi(authorLink.href).replace(/\\/(posts|people|about|jobs|life|videos)\\/?$/i, '') : null;
    const isCompanyAuthor = !!(authorLink && /\\/company\\//.test(authorLink.href));
    if (isCompanyAuthor) authorHeadline = null;

    // Body: pick the LONGEST .update-components-text element OUTSIDE the
    // comments list. Falls back to nothing if none.
    const bodyCandidates = $$('.update-components-text', postCard)
      .filter((el) => !commentsListEl || !commentsListEl.contains(el));
    const bodyEl = bodyCandidates.reduce((best, e) => {
      const len = (e.innerText || e.textContent || '').length;
      return (!best || len > ((best.innerText || best.textContent || '').length)) ? e : best;
    }, null);
    const text = bodyEl ? (txt(bodyEl) || '').slice(0, 6000) : null;

    // Timestamp ("6h", "2d") — first Nx[smhdwy] line in the post header.
    // We restrict to text BEFORE the comments list by walking lines.
    const headerLines = (postCard.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const commentsHead = commentsListEl ? (commentsListEl.innerText || '').split('\\n')[0]?.trim() : null;
    const cutIdx = commentsHead ? headerLines.indexOf(commentsHead) : -1;
    const headerOnly = cutIdx > 0 ? headerLines.slice(0, cutIdx) : headerLines;
    const timeAgo = headerOnly.find((s) => /^\\d+\\s?(s|m|h|d|w|mo|y)\\b/i.test(s))
                 || headerOnly.find((s) => /^Edited\\s*[•·]\\s*\\d+\\s?(s|m|h|d|w|mo|y)\\b/i.test(s))
                 || null;

    // Social counts row — unique container at post level (.social-details-social-counts).
    // We prefer aria-labels on action links/buttons inside (they have the form
    // "20 comments on <Name>'s post"); the visible LI text is a fallback.
    const counts = $1('.social-details-social-counts', postCard);
    const parseCount = (s) => {
      if (!s) return null;
      const m = s.replace(/\\u00a0/g, ' ').match(/([\\d.,]+)\\s*(K|M|k|m)?/);
      if (!m) return null;
      let n = parseFloat(m[1].replace(/[,.](?=\\d{3}\\b)/g, '').replace(',', '.'));
      if (Number.isNaN(n)) return null;
      if (/k/i.test(m[2] || '')) n *= 1_000;
      if (/m/i.test(m[2] || '')) n *= 1_000_000;
      return Math.round(n);
    };

    let reactionsCount = null, commentsCount = null, repostsCount = null;
    let reactionsLine = null, commentsLine = null, repostsLine = null;
    if (counts) {
      // 1) Aria-labels on internal buttons/links (most reliable)
      const labels = $$('[aria-label]', counts).map((el) => attr(el, 'aria-label') || '');
      const aria = {
        reactions: labels.find((l) => /\\b(others|autres)\\b/i.test(l) && /^\\D/.test(l))
                || labels.find((l) => /\\d+\\s+(reactions?|r[ée]actions?)/i.test(l))
                || null,
        comments: labels.find((l) => /^\\d[\\d,.\\s]*\\s+(comments?|commentaires?)\\b/i.test(l)) || null,
        reposts:  labels.find((l) => /^\\d[\\d,.\\s]*\\s+(reposts?|republications?|partages?)\\b/i.test(l)) || null,
      };
      // 2) Class-targeted LIs as fallback
      const reactionsLi = $1('.social-details-social-counts__reactions', counts);
      const commentsLi  = $1('.social-details-social-counts__comments', counts);
      const repostsLi   = $$('li', counts).find((li) =>
        /(repost|republication|partage)/i.test(li.textContent || '')) || null;
      reactionsLine = aria.reactions || (reactionsLi ? txt(reactionsLi) : null);
      commentsLine  = aria.comments  || (commentsLi  ? txt(commentsLi)  : null);
      repostsLine   = aria.reposts   || (repostsLi   ? txt(repostsLi)   : null);
      // Numerics. Two aria-label shapes occur:
      //   - "<Name> and 59 others" → 60 reactions
      //   - "23 reactions"          → 23 reactions
      const reactWithOthers = reactionsLine && reactionsLine.match(/\\band\\s+([\\d.,]+)\\s+(?:others?|autres?)\\b/i);
      const reactPlain      = reactionsLine && reactionsLine.match(/^\\s*([\\d.,]+)\\s+(reactions?|r[ée]actions?)\\b/i);
      if (reactWithOthers) reactionsCount = (parseCount(reactWithOthers[1]) || 0) + 1;
      else if (reactPlain) reactionsCount = parseCount(reactPlain[1]);
      else if (reactionsLi) reactionsCount = parseCount((reactionsLi.textContent || '').trim().split(/\\s|\\n/)[0]);
      commentsCount = parseCount(commentsLine);
      repostsCount  = parseCount(repostsLine);
    }

    // Activity URN
    const urn = (location.href.match(/urn:li:activity:(\\d+)/) || [])[1]
             || (attr(postCard, 'data-urn') || '').match(/urn:li:activity:(\\d+)/)?.[1]
             || ($$('a[href*="urn:li:activity:"]', postCard).map((a) => (a.href.match(/urn:li:activity:(\\d+)/) || [])[1]).find(Boolean) || null);

    // Media preview (first non-avatar img outside comments)
    const mediaImage = $$('img', postCard)
      .filter((i) => !commentsListEl || !commentsListEl.contains(i))
      .map((i) => i.src || '')
      .find((s) => s && !/profile-displayphoto/.test(s)) || null;

    post = {
      author: authorName ? { name: authorName, href: authorHref, headline: authorHeadline } : null,
      timeAgo,
      text,
      reactionsCount,
      commentsCount,
      repostsCount,
      reactionsLine,
      commentsLine,
      repostsLine,
      mediaImage,
      activityUrn: urn ? 'urn:li:activity:' + urn : null,
      url: urn ? 'https://www.linkedin.com/feed/update/urn:li:activity:' + urn + '/' : location.href,
    };
  }

  const items = [];
  const seen = new Set();

  for (const btn of replyButtons) {
    const label = attr(btn, 'aria-label') || '';
    // "Reply to <Author>'s comment" → extract Author (handles curly + straight quote)
    const m = label.match(/^Reply to (.+)[\\u2019\\u0027]s comment$/);
    const author = m ? m[1].trim() : null;
    if (!author) continue;

    // Walk up until we hit a parent that ALSO contains "Open options for <author>'s comment"
    // → that's the comment card. Bound the walk.
    let card = btn;
    const escForAttr = author.replace(/"/g, '\\\\"');
    for (let i = 0; i < 12 && card.parentElement; i++) {
      card = card.parentElement;
      const sel1 = '[aria-label="Open options for ' + escForAttr + '\\u2019s comment"]';
      const sel2 = '[aria-label="Open options for ' + escForAttr + '\\'s comment"]';
      if ($1(sel1, card) || $1(sel2, card)) break;
    }
    if (seen.has(card)) continue;
    seen.add(card);

    // Author headline (job title) → "View: <Author> [Verified •] <degree> <Title>"
    // aria-label on the textual author link. Same parsing as for the parent post.
    const headlineEl = $1('[aria-label^="View: ' + escForAttr + ' "]', card);
    const headlineAria = headlineEl ? attr(headlineEl, 'aria-label') : null;
    let headline = null;
    if (headlineAria) {
      // "You" appears on the viewing user's own profile, "Author" on the post
      // author's comments, plus the usual degree markers.
      const hm = headlineAria.match(/^View:\\s+(.+?)\\s+(?:Verified\\s*[•·]\\s*)?(?:1st|2nd|3rd|Author|You|Vous)\\s+(.+)$/i);
      if (hm) headline = hm[2].trim();
      else headline = headlineAria.replace(/^View:\\s+[^,]+,\\s*/, '').replace(/^View:\\s+/, '').trim() || null;
    }
    // Decode HTML entities (LinkedIn occasionally bleeds &amp; through aria-labels).
    if (headline) headline = headline.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

    // Author profile link (use the textual one — same heuristic as the post)
    const inLinks = $$('a[href*="/in/"]', card);
    const authorLink = inLinks.find((a) => /^View:/.test(attr(a, 'aria-label') || ''))
                    || inLinks[0] || null;
    const authorHref = authorLink ? canonicalLi(authorLink.href).replace(/\\/(posts|people|about|jobs)\\/?$/i, '') : null;

    // Reactions count on the comment
    const reactEl = $1('[aria-label*=" reaction"], [aria-label*=" r\\u00e9action"]', card);
    const reactionsLabel = reactEl ? attr(reactEl, 'aria-label') : null;
    const reactNum = reactionsLabel && reactionsLabel.match(/^([\\d.,]+)/);
    const reactionsCount = reactNum ? parseInt(reactNum[1].replace(/[^\\d]/g, ''), 10) : null;

    // Text body: prefer the .comments-comment-item__main-content / similar
    // scoped element; fallback to the card text minus name/headline/timeago/buttons.
    const bodyEl2 = $1('.comments-comment-item__main-content, .comments-comment-item-content-body, .feed-shared-main-content', card)
                 || $1('.update-components-text', card);
    const raw = (card.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const dropExact = new Set([author, 'Like', 'Reply', 'Reactions', 'Author', 'Verified', '·', '•']);
    const filtered = raw.filter((l) =>
      !dropExact.has(l) &&
      !/^(\\d+ (Like|Reply|reaction|comment))/i.test(l) &&
      !/^\\d+\\s?(s|m|h|d|w|mo|y)\\b/i.test(l) &&            // remove timeago
      !/^[•·]\\s*(1st|2nd|3rd)\\+?$/i.test(l) &&            // remove degree
      !/^Verified\\s*[•·]\\s*(1st|2nd|3rd)\\+?$/i.test(l) &&
      (headline ? l !== headline.replace(/&amp;/g, '&') : true)
    );
    const body = bodyEl2 ? (txt(bodyEl2) || '').slice(0, 4000) : filtered.join('\\n').slice(0, 4000);

    // Time-ago heuristic
    const timeAgo = raw.find((s) => /^\\d+\\s?(s|m|h|d|w|mo|y|min|hour|day|week|month|year)/i.test(s)) || null;

    // Per-commenter row matching the leadgen comments[] shape.
    // ingest is alias-tolerant — snake_case keys win when both present.
    const vmid = (authorHref && /\\/in\\/([^/?#]+)/.exec(authorHref))
                  ? /\\/in\\/([^/?#]+)/.exec(authorHref)[1] : null;
    const profileImg = $1('img[src*="profile-displayphoto"], img', card);
    const profileImgUrl = profileImg ? (profileImg.getAttribute('src') || null) : null;

    items.push({
      vmid,
      profile_url:     authorHref,
      full_name:       author,
      tag_line:        headline,
      profile_img_url: profileImgUrl,
      text:            body,
      reactionCount:   reactionsCount || 0,
      timeAgo,
      // Debug
      reactionsLabel,
    });
  }

  // Output shape aligned with ozeo-leadgen get_comments:
  //   { PK, postUrl, reactionCount, commentCount, comments: [...] }
  // PK is injected by the worker from inputData.
  return {
    postUrl:        post?.url || location.href,
    reactionCount:  post?.reactionsCount || 0,
    commentCount:   post?.commentsCount  || items.length,
    comments:       items,
    // Extras (debug — not persisted by ingest)
    post,
    count:          items.length,
    url:            location.href,
    title:          document.title,
  };
`);
