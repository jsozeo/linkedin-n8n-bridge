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

// Infinite scroll. 20% increments with 2.5 s pauses give the network time to paginate.
export const SCROLL = { strategy: 'window', steps: [20, 40, 60, 80, 100], delayMs: 2500 };

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
  const URN_RE = /urn:li:activity:(\\d+)/i;
  const findUrnIn = (s) => (s && URN_RE.exec(s)) ? URN_RE.exec(s)[1] : null;

  // ── Anchor each post card ────────────────────────────────────────────────
  const feed = $1('[data-testid="mainFeed"]') || $1('main');
  if (!feed) return { url: location.href, count: 0, posts: [] };

  const anchors = $$('[aria-label^="Open control menu for post by "]', feed);
  const seen = new Set();
  const posts = [];

  for (const anchor of anchors) {
    // Walk up to the card root: smallest ancestor that contains both the
    // anchor and the post body / reactions widget.
    let card = anchor;
    for (let i = 0; i < 10 && card.parentElement; i++) {
      card = card.parentElement;
      if (card === feed || card === document.body) break;
      const hasBody  = $1('[data-testid="expandable-text-box"]', card);
      const hasReact = $1('[aria-label="Open reactions menu"]', card);
      if (hasBody && hasReact) break;
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
    const textContent = (txtOf('[data-testid="expandable-text-box"]', card) || '').slice(0, 8000) || null;

    // ── URN / canonical post URL ──────────────────────────────────────────
    // The activity URN appears in: the anchor's data-urn, the card's
    // data-id, or any inner anchor that points to /feed/update/urn:li:activity:.
    let urn = findUrnIn(attr(anchor, 'data-urn'))
           || findUrnIn(attr(card, 'data-urn'))
           || findUrnIn(attr(card, 'data-id'));
    if (!urn) {
      // Scan child anchors as a last resort.
      const u = $$('a[href]', card).map((a) => a.getAttribute('href') || '').find((h) => URN_RE.test(h));
      if (u) urn = findUrnIn(u);
    }
    const postUrl = urn ? 'https://www.linkedin.com/feed/update/urn:li:activity:' + urn + '/' : null;

    // ── Timestamp ─────────────────────────────────────────────────────────
    const headerText = headerParent ? (headerParent.innerText || '').split(/\\r?\\n/).map((s) => s.trim()) : [];
    const postDate = headerText.find((s) => /^\\d+\\s?(s|m|h|d|w|mo|y|min|hour|day|week|month|year)/i.test(s)) || null;
    const postEpochMs = parsePostEpochMs(postDate);

    // ── Reactions / comments / reposts (parsed numbers) ───────────────────
    const reactionsLabel = attr($1('[aria-label*=" reaction"]', card), 'aria-label');
    const commentsLabel  = attr($1('[aria-label*=" comment"], [aria-label*=" commentaire"]', card), 'aria-label');
    const repostsLabel   = attr($1('[aria-label*=" repost"]', card), 'aria-label');
    const reactionCount  = parseCount(reactionsLabel);
    const commentCount   = parseCount(commentsLabel);
    const repostCount    = parseCount(repostsLabel);

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

  return {
    url:    location.href,
    title:  document.title,
    count:  posts.length,
    posts,
  };
`);
