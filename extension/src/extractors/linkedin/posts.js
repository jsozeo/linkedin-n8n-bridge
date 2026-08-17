// LinkedIn posts list extractor.
//
// Handles three page types:
//   - /in/<slug>/recent-activity/all/         (someone's recent posts)
//   - /in/<slug>/recent-activity/shares/      (someone's shares only)
//   - /feed/                                  (your own home feed)
//   - /search/results/content/?keywords=…     (LinkedIn content search)
//
// Single-post permalinks (/feed/update/…, /posts/…) go through `linkedin.comments`
// which extracts the post + its comments.

import { evalScript } from './_helpers.js';

export const ID = 'linkedin.posts';
// ozeo-leadgen dispatch step(s) handled by this skill.
export const STEP_KEYS = ['get_post'];
export const URL_PATTERN = /linkedin\.com\/(in\/[^/]+\/recent-activity\/(all|shares)|feed|search\/results\/content)/i;

// `[data-testid="mainFeed"]` is the stable feed container on web LinkedIn 2026.
export const WAIT_SELECTORS = ['main', '[data-testid="mainFeed"]'];

// Infinite/virtualized list: scroll to the bottom repeatedly, extracting and
// merging after each scroll (LinkedIn recycles off-screen cards). The runner
// stops once no new posts appear for `stableRounds` rounds or after `maxSteps`.
// maxSteps/delay are an upper bound; the runner also enforces a wall-clock
// budget (budgetMs) so the loop always finishes before the MV3 service worker
// is torn down (~30s) — otherwise no capture is posted on high-volume feeds.
export const SCROLL = { strategy: 'infinite', maxSteps: 15, delayMs: 1400, stableRounds: 3, budgetMs: 22000 };

// Field the runner merges/dedupes across scroll rounds.
export const ITEMS_KEY = 'posts';

export const EXTRACT_JS = evalScript(`
  // ── Helpers ──────────────────────────────────────────────────────────────
  // Parse an aria-label like "1,234 reactions" / "12 comments" / "3 reposts"
  // into a JS number. Returns 0 when no leading digit run is present.
  const parseCount = (label) => {
    if (!label) return 0;
    const m = String(label).match(/([\\d,.]+)/);
    return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) || 0 : 0;
  };

  // Resolve a relative timeAgo string ("2d", "3h", "1 mo") to an epoch-ms
  // value relative to the page load. Best-effort — the absolute timestamp
  // is also embedded in the post URN but is harder to extract reliably.
  const NOW = Date.now();
  const UNIT_MS = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8, mo: 2.628e9, y: 3.154e10 };
  const parsePostEpochMs = (ts) => {
    if (!ts) return null;
    const m = String(ts).match(/^(\\d+)\\s?(s|m|h|d|w|mo|y|min|hour|day|week|month|year)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase().replace(/^min$/, 'm').replace(/^hour$/, 'h').replace(/^day$/, 'd').replace(/^week$/, 'w').replace(/^month/, 'mo').replace(/^year/, 'y');
    const ms = UNIT_MS[u] || 0;
    return NOW - n * ms;
  };

  // Extract the LinkedIn activity URN from anywhere in a string ("urn:li:activity:…").
  const URN_RE = /urn:li:(?:activity|ugcPost):(\\d+)/i;
  const findUrnIn = (s) => (s && URN_RE.exec(s)) ? URN_RE.exec(s)[1] : null;

  // ── Anchor each post card ────────────────────────────────────────────────
  const feed = $1('[data-testid="mainFeed"]') || $1('main');
  if (!feed) return { url: location.href, count: 0, posts: [] };

  const anchors = $$('[aria-label^="Open control menu for post by "]', feed);
  const seen = new Set();
  const posts = [];

  for (const anchor of anchors) {
    // Card root. The legacy Ember feed (company /posts/, some locales) wraps each
    // post in .feed-shared-update-v2 — use it directly. Otherwise (new SDUI feed)
    // walk up to the smallest ancestor holding the body + reactions widget.
    let card = anchor.closest('.feed-shared-update-v2, [data-urn^="urn:li:activity"]');
    if (!card) {
      card = anchor;
      for (let i = 0; i < 10 && card.parentElement; i++) {
        card = card.parentElement;
        if (card === feed || card === document.body) break;
        const hasBody  = $1('[data-testid="expandable-text-box"]', card);
        const hasReact = $1('[aria-label="Open reactions menu"]', card);
        if (hasBody && hasReact) break;
      }
    }
    if (seen.has(card)) continue;
    seen.add(card);

    // ── Author identity ───────────────────────────────────────────────────
    const authorRaw = attr(anchor, 'aria-label') || '';
    const name = authorRaw.replace(/^Open control menu for post by /, '').trim();

    const candidates = $$('a[href*="/in/"], a[href*="/company/"]', card);
    const authorLink = candidates.find((a) => {
      const t = (a.textContent || '').trim();
      return t === name || t.startsWith(name);
    }) || null;
    const authorHref = authorLink ? canonicalLi(authorLink.href) : null;
    const isCompanyAuthor = !!(authorHref && /\\/company\\//.test(authorHref));

    const vmid = (authorHref && /\\/in\\/([^/?#]+)/.exec(authorHref))
                  ? /\\/in\\/([^/?#]+)/.exec(authorHref)[1] : null;

    // Profile image (the author avatar — not the post media)
    const avatarImg = $1('img[src*="profile-displayphoto"], img[alt*=" headshot" i], img[alt*=" avatar" i]', card)
                   || $1('img', card);
    const profileImgUrl = avatarImg ? (avatarImg.getAttribute('src') || null) : null;

    // ── Author tagline (the line below the name) ──────────────────────────
    // Walk the author-link's parent and look for short text that's not the
    // author name, not a relative timestamp, and not a "•" separator.
    let tagLine = null;
    const headerParent = authorLink ? authorLink.parentElement : null;
    if (headerParent) {
      const lines = (headerParent.innerText || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
      tagLine = lines.find((s) =>
        s !== name &&
        s.length > 3 && s.length < 200 &&
        !/^\\d+\\s?(s|m|h|d|w|mo|y|min|hour|day|week|month|year)/i.test(s) &&
        !/^[·•]+$/.test(s)
      ) || null;
    }

    // ── Post body ─────────────────────────────────────────────────────────
    // New feed: [data-testid="expandable-text-box"]. Legacy Ember feed:
    // .update-components-text (inside .feed-shared-inline-show-more-text).
    const textContent = (
      txtOf('[data-testid="expandable-text-box"]', card)
      || txtOf('.update-components-text', card)
      || txtOf('.feed-shared-inline-show-more-text', card)
      || ''
    ).slice(0, 8000) || null;

    // ── Card text (used for the text-based fallbacks below) ───────────────
    const cardText = card.innerText || '';

    // ── Canonical post URL ────────────────────────────────────────────────
    // On search-result cards there is no data-urn and no /feed/update anchor.
    // The only reliable URN source is the componentkey wrapping the post body,
    // which encodes it as ...ContentUrnUgcPostUrn(...userGeneratedContentId=<id>)
    // or ...ContentUrnShareUrn(...shareId=<id>). Any of ugcPost/share/activity
    // resolves as a /feed/update/ permalink.
    const ckUrn = (() => {
      const els = $$('[componentkey*="ContentId="], [componentkey*="shareId="], [componentkey*="activityId="]', card);
      for (const el of els) {
        const ck = el.getAttribute('componentkey') || '';
        let m = ck.match(/userGeneratedContentId=(\\d+)/); if (m) return 'urn:li:ugcPost:' + m[1];
        m = ck.match(/activityId=(\\d+)/);                 if (m) return 'urn:li:activity:' + m[1];
        m = ck.match(/shareId=(\\d+)/);                    if (m) return 'urn:li:share:' + m[1];
      }
      return null;
    })();

    let postUrl = ($$('a[href*="/feed/update/urn:li:"]', card).map((a) => a.href).find(Boolean)) || null;
    if (postUrl) postUrl = postUrl.split('?')[0];
    if (!postUrl && ckUrn) postUrl = 'https://www.linkedin.com/feed/update/' + ckUrn + '/';
    if (!postUrl) {
      let urn = findUrnIn(attr(anchor, 'data-urn'))
             || findUrnIn(attr(card, 'data-urn'))
             || findUrnIn(attr(card, 'data-id'));
      if (!urn) {
        const u = $$('a[href]', card).map((a) => a.getAttribute('href') || '').find((h) => URN_RE.test(h));
        if (u) urn = findUrnIn(u);
      }
      if (urn) postUrl = 'https://www.linkedin.com/feed/update/urn:li:activity:' + urn + '/';
    }

    // LinkedIn snowflake IDs encode creation time in the high bits
    // (id >> 22 = epoch-ms) — exact, unlike the relative "1m" label.
    let postEpochMsFromId = null;
    const idFromUrn = (postUrl || ckUrn || '').match(/(\\d{15,})/);
    if (idFromUrn) {
      try { const ms = Number(BigInt(idFromUrn[1]) >> 22n); if (ms > 1e12 && ms < 4e12) postEpochMsFromId = ms; } catch (e) {}
    }

    // ── Timestamp ─────────────────────────────────────────────────────────
    const headerText = headerParent ? (headerParent.innerText || '').split(/\\r?\\n/).map((s) => s.trim()) : [];
    let postDate = headerText.find((s) => /^\\d+\\s?(s|m|h|d|w|mo|y|min|hour|day|week|month|year)/i.test(s)) || null;
    // Search cards don't put the time in the header — fall back to the compact
    // token ("74d", "3h") found anywhere in the card.
    if (!postDate) { const tm = cardText.match(/\\b(\\d+)(s|m|h|d|w|mo|y)\\b/); if (tm) postDate = tm[0]; }
    const postEpochMs = postEpochMsFromId != null ? postEpochMsFromId : parsePostEpochMs(postDate);

    // ── Reactions / comments / reposts ────────────────────────────────────
    // The feed exposes counts in aria-labels; search cards expose them only as
    // visible text ("2 comments"). Requiring a leading digit avoids matching
    // body copy like "drop a comment".
    const reactionsLabel = attr($1('[aria-label*=" reaction"]', card), 'aria-label');
    const commentsLabel  = attr($1('[aria-label*=" comment"], [aria-label*=" commentaire"]', card), 'aria-label');
    const repostsLabel   = attr($1('[aria-label*=" repost"]', card), 'aria-label');
    const countFromText  = (re) => { const m = cardText.match(re); return m ? (parseInt(m[1].replace(/[.,]/g, ''), 10) || 0) : 0; };
    const reactionCount  = parseCount(reactionsLabel) || countFromText(/(\\d[\\d.,]*)\\s+reactions?/i);
    const commentCount   = parseCount(commentsLabel)  || countFromText(/(\\d[\\d.,]*)\\s+comments?/i);
    const repostCount    = parseCount(repostsLabel)   || countFromText(/(\\d[\\d.,]*)\\s+reposts?/i);

    // ── Repost / promoted flags ───────────────────────────────────────────
    const isRepost = /\\b(reposted this|a republi[ée] ceci|shared a post|a partag[ée] une publication)\\b/i.test(card.innerText || '');
    const isAd     = !!$1('[aria-label="Why am I seeing this ad?"], [aria-label="Hide or report this ad"]', card);

    // ── Company / external link in the card ───────────────────────────────
    const companyLink = $$('a[href*="/company/"]', card).map((a) => a.href).find(Boolean) || null;
    const companyUrl  = companyLink ? canonicalLi(companyLink) : null;
    const companyName = companyLink
      ? (($1('a[href*="/company/"]', card)?.textContent || '').trim() || null)
      : null;

    // External CTA ("Read more on x.com")
    const externalLink = $$('a[href]', card)
      .map((a) => a.href)
      .find((h) => !/linkedin\\.com/.test(h) && /^https?:/.test(h)) || null;

    // ── Media preview ─────────────────────────────────────────────────────
    const allImgs = $$('img', card).filter((img) => {
      const s = img.src || '';
      return s && !s.startsWith('data:') && !s.includes('profile-displayphoto');
    });
    const mediaImage = allImgs[0]?.src || null;

    // ── Emit one row matching the ozeo-leadgen 'posts' shape (camelCase) ──
    // PK is set by the worker (post#<urn>#<campaign>).
    posts.push({
      // Author identity
      name,
      fullName:     name,
      vmid,
      profileUrl:   isCompanyAuthor ? null : authorHref,
      tagLine,
      profileImgUrl,

      // Post content
      textContent,
      postUrl,
      postDate,
      postEpochMs,
      isRepost,

      // Company link (if the post mentions one)
      companyName,
      companyUrl,

      // Engagement
      reactionCount,
      commentCount,
      comments: [],          // resolved by a separate get_comments step

      // Extras (silently dropped by ingest; useful for orchestrator scoring)
      repostCount,
      reactionsLabel,
      commentsLabel,
      repostsLabel,
      externalLink,
      mediaImage,
      isAd,
      authorIsCompany: isCompanyAuthor,
    });
  }

  // Diagnostic probe — only when we found nothing, so we can see *why*
  // (wrong container, different DOM on /search/, or an auth wall).
  const _debug = posts.length ? undefined : {
    href:            location.href,
    title:           document.title,
    hasMainFeed:     !!$1('[data-testid="mainFeed"]'),
    hasMain:         !!$1('main'),
    controlMenuEN:   $$('[aria-label^="Open control menu for post by "]').length,
    controlMenuAny:  $$('[aria-label*="control menu" i]').length,
    expandableText:  $$('[data-testid="expandable-text-box"]').length,
    urnEls:          $$('[data-urn*="urn:li:activity"]').length,
    urnAnchors:      $$('a[href*="urn:li:activity"]').length,
    viewNameEls:     $$('[data-view-name]').length,
    looksLikeAuthwall: /\\/(login|authwall|checkpoint)/i.test(location.href) || /sign in|log in|s.identifier/i.test((document.title || '')),
    bodyTextLen:     (document.body && document.body.innerText || '').length,
  };

  // ── Drive the real scroll container ──────────────────────────────────────
  // LinkedIn's content search scrolls <main> (an overflow:auto element), NOT
  // the window. social.js's window scroll is a no-op here, so the extractor
  // advances the container itself: each round we step down ~one viewport and
  // fire a scroll event; the runner's inter-round delay lets the LazyColumn
  // fetch + render the next batch, which the next round extracts and merges.
  const findScroller = () => {
    let el = feed;
    let guard = 0;
    while (el && guard++ < 30) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const _scroller = findScroller();
  const _isDocScroller = _scroller === document.scrollingElement || _scroller === document.documentElement || _scroller === document.body;
  let _scrollInfo = null;
  try {
    const viewport = _isDocScroller ? window.innerHeight : _scroller.clientHeight;
    const before = _isDocScroller ? window.scrollY : _scroller.scrollTop;
    // ~1.6 viewports/round: fewer rounds to reach the end (bundled maxSteps=25)
    // while staying under LinkedIn's render buffer so no card is skipped.
    const step = Math.round(viewport * 1.6);
    if (_isDocScroller) window.scrollBy(0, step);
    else _scroller.scrollTop = Math.min(_scroller.scrollHeight, _scroller.scrollTop + step);
    try { _scroller.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
    const after = _isDocScroller ? window.scrollY : _scroller.scrollTop;
    _scrollInfo = { before, after, step, moved: after - before };
  } catch (e) { _scrollInfo = { error: String(e) }; }

  // ── Scroll diagnostics (survives the merge — see social.js) ──────────────
  const _probe = (() => {
    try {
      return {
        cards: anchors.length,
        scroller: {
          tag: _scroller.tagName,
          testid: _scroller.getAttribute && _scroller.getAttribute('data-testid'),
          isDoc: _isDocScroller,
          sh: _scroller.scrollHeight, ch: _scroller.clientHeight, top: _scroller.scrollTop,
        },
        scrollInfo: _scrollInfo,
        hasLazyColumn: !!$1('[data-testid="lazy-column"]'),
        loaders: $$('[data-testid="loader"]').length,
        endMarker: /no more results|end of results|you.?re all caught up|plus de r[eé]sultats/i.test((feed.innerText || '')),
      };
    } catch (e) { return { probeError: String(e) }; }
  })();

  return {
    url:    location.href,
    title:  document.title,
    count:  posts.length,
    posts,
    _debug,
    _probe,
  };
`);
