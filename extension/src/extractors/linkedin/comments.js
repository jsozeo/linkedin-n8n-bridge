import { evalAsyncScript } from './_helpers.js';

export const ID = 'linkedin.comments';
// ozeo-leadgen dispatch step(s).
export const STEP_KEYS = ['get_comments'];
// Post permalinks (all resolve to the same UpdateDetail SDUI screen):
//   /feed/update/urn:li:activity:<id>/
//   /feed/update/urn:li:share:<id>/
//   /feed/update/urn:li:ugcPost:<id>/
//   /posts/<slug>-<id>-<token>/
export const URL_PATTERN = /linkedin\.com\/(feed\/update\/urn:li:(activity|share|ugcPost):\d+\/?|posts\/[^/?#]+\/?|in\/[^/]+\/recent-activity\/comments\/?)/i;

// LinkedIn migrated the post-detail view to Server-Driven UI (SDUI): hashed
// class names, `id="workspace"` <main>, and comment rows keyed by
// `id="replaceableComment_urn:li:comment:(...)"`. We anchor on those stable
// ids / data-testids / aria-labels — never on the (hashed) classes.
export const WAIT_SELECTORS = ['main'];

// Wait until the SDUI screen has hydrated (a comment row, the composer, or the
// SDUI screen marker is present) before extracting.
export const WAIT_PREDICATE_JS = `!!document.querySelector('[id^="replaceableComment_urn:li:comment:"], [aria-label="Text editor for creating comment"], [data-sdui-screen]')`;

// The comment list is a virtualized LazyColumn that appends more comments as
// the page scrolls. The extractor itself drives the scroll+harvest loop (below),
// so the outer pipeline only needs a light nudge to trigger the first batch.
export const SCROLL = { strategy: 'window', steps: [60, 100], delayMs: 1200 };

// EXTRACT_JS scrolls + harvests in a loop, so it returns a Promise the runner
// must await.
export const AWAIT_PROMISE = true;

export const EXTRACT_JS = evalAsyncScript(`
  const COMMENT_SEL = '[id^="replaceableComment_urn:li:comment:"]';
  const LOAD_RE = /^(Load more comments|Show more comments|View more comments|Voir plus de commentaires|Charger plus de commentaires|Load more results|Show more results)$/i;

  // Curly (U+2019) or straight apostrophe, used across LinkedIn aria-labels.
  const APOS = '[\\u2019\\u0027]';
  const stripLocale = (u) => u ? u.replace(/\\/(en|fr|de|es|it|pt|nl|zh|ja|ru|ar|tr|pl)$/i, '') : u;
  const TIME_RE = /^(\\d+)\\s?(s|m|h|d|w|mo|y|min|mins|hour|hours|day|days|week|weeks|month|months|year|years)(\\sago)?$/i;

  // ── Parse a single comment card ─────────────────────────────────────────
  function parseComment(root) {
    const bodyEl = root.querySelector('[data-testid="expandable-text-box"]');

    // Actor: LinkedIn renders two /in/ links per comment — one wraps the avatar
    // <figure>/<img>, the other wraps the name + headline text. We want the
    // textual one, and we must exclude @mention links inside the comment body.
    const inLinks = $$('a[href*="/in/"]', root)
      .filter((a) => !bodyEl || !bodyEl.contains(a));
    const actorLink = inLinks.find((a) => a.querySelector('p'))
                   || inLinks.find((a) => !a.querySelector('figure, img'))
                   || inLinks[0] || null;

    // Name: prefer the avatar img alt ("View <Name>'s profile") — cleanest.
    let name = null;
    const avatarImg = root.querySelector('img[alt^="View "]');
    if (avatarImg) {
      const m = (attr(avatarImg, 'alt') || '').match(new RegExp('^View (.+?)' + APOS + 's profile$'));
      if (m) name = m[1].trim();
    }
    if (!name) {
      const opt = root.querySelector('[aria-label^="View more options for "]');
      const am = opt && (attr(opt, 'aria-label') || '').match(new RegExp('^View more options for (.+?)' + APOS + 's comment'));
      if (am) name = am[1].trim();
    }
    if (!name && actorLink) {
      // Fallback: first <p>, drop trailing "Premium Profile"/degree noise.
      const p0 = actorLink.querySelector('p');
      const raw = p0 ? (p0.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      name = raw.split(/\\s+(?:Premium Profile|Influencer|Verified|\\u2022|1st|2nd|3rd)\\b/)[0].trim() || null;
    }

    // Headline: the last <p> inside the textual actor link (name is the first).
    let headline = null;
    if (actorLink) {
      const ps = $$('p', actorLink);
      if (ps.length >= 2) headline = txt(ps[ps.length - 1]);
    }
    if (headline) headline = headline.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim() || null;

    // Profile URL + vmid
    const href = actorLink ? actorLink.href : (inLinks[0] ? inLinks[0].href : null);
    const profileUrl = href ? stripLocale(canonicalLi(href)) : null;
    let vmid = null;
    if (profileUrl) {
      const vm = /\\/in\\/([^/?#]+)/.exec(profileUrl);
      if (vm) { vmid = vm[1]; try { vmid = decodeURIComponent(vmid); } catch (_) {} }
    }

    // Comment body text (strip the "…more" expander suffix).
    let text = bodyEl ? (txt(bodyEl) || '') : '';
    text = text.replace(/\\s*\\u2026\\s*more$/i, '').replace(/\\s*\\bmore$/i, '').trim().slice(0, 4000);

    // Timestamp ("3d", "2 weeks ago") — short token outside the body.
    let timeAgo = null;
    for (const el of $$('span, time', root)) {
      if (bodyEl && bodyEl.contains(el)) continue;
      const t = (el.textContent || '').trim();
      if (t.length <= 14 && TIME_RE.test(t)) { timeAgo = t; break; }
    }

    // Reactions on the comment (best effort).
    let reactionsCount = 0;
    const reactBtn = root.querySelector('[aria-label="Open reactions menu"]');
    if (reactBtn) {
      const scope = reactBtn.closest('div') ? reactBtn.parentElement : root;
      const near = scope ? (scope.textContent || '') : '';
      const rm = near.match(/(\\d[\\d.,]*)/);
      if (rm) reactionsCount = parseInt(rm[1].replace(/[^\\d]/g, ''), 10) || 0;
    }

    // Comment URN from the row id.
    const id = root.id || '';
    const commentUrn = /urn:li:comment:\\([^)]*\\)/.test(id)
      ? id.replace(/^replaceableComment_/, '') : null;

    if (!name && !profileUrl) return null;
    return {
      vmid,
      profile_url:     profileUrl,
      full_name:       name,
      tag_line:        headline,
      profile_img_url: avatarImg ? (avatarImg.getAttribute('src') || null) : null,
      text,
      reactionCount:   reactionsCount,
      timeAgo,
      comment_urn:     commentUrn,
    };
  }

  // ── Scroll + harvest loop (handles virtualized LazyColumn) ──────────────
  const acc = new Map(); // comment_urn -> item (survives node recycling)
  const harvest = () => {
    for (const root of $$(COMMENT_SEL)) {
      const it = parseComment(root);
      const key = it && (it.comment_urn || it.profile_url);
      if (it && key && !acc.has(key)) acc.set(key, it);
    }
  };

  const DEADLINE = Date.now() + 16000;
  let stale = 0;
  harvest();
  while (Date.now() < DEADLINE && stale < 5) {
    const before = acc.size;
    // Click any explicit "load more" button if present.
    const btns = $$('button').filter((b) => !b.disabled && LOAD_RE.test((b.textContent || '').trim()));
    for (const b of btns) { try { b.scrollIntoView({ block: 'center' }); b.click(); } catch (_) {} }
    // Drive the lazy list: scroll page bottom, and pull the last comment in.
    const roots = $$(COMMENT_SEL);
    if (roots.length) { try { roots[roots.length - 1].scrollIntoView({ block: 'center' }); } catch (_) {} }
    try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (_) {}
    await sleep(1300);
    harvest();
    if (acc.size <= before) stale++; else stale = 0;
  }
  const items = [...acc.values()];

  // ── Parent post (best effort — ingest only needs comments) ──────────────
  const commentRoots = $$(COMMENT_SEL);
  const inComment = (el) => commentRoots.some((r) => r.contains(el));

  let postAuthorName = null;
  const ctrl = $1('[aria-label^="Open control menu for post by "]');
  if (ctrl) {
    const m = (attr(ctrl, 'aria-label') || '').match(/Open control menu for post by (.+)$/);
    if (m) postAuthorName = m[1].trim();
  }
  const postBodyEl = $$('[data-testid="expandable-text-box"]').find((e) => !inComment(e)) || null;
  const postText = postBodyEl ? (txt(postBodyEl) || '').replace(/\\s*\\u2026\\s*more$/i, '').slice(0, 6000) : null;

  const parseCount = (re) => {
    for (const el of $$('span, p')) {
      if (inComment(el)) continue;
      const t = (el.textContent || '').trim();
      const m = t.match(re);
      if (m) return parseInt(m[1].replace(/[^\\d]/g, ''), 10);
    }
    return null;
  };
  const commentsCount = parseCount(/^([\\d.,]+)\\s+comments?$/i);
  const reactionsCount = parseCount(/^([\\d.,]+)\\s+reactions?$/i);

  const urn = (location.href.match(/urn:li:(?:activity|share|ugcPost):(\\d+)/) || [])[1] || null;
  const post = {
    author: postAuthorName ? { name: postAuthorName } : null,
    text: postText,
    reactionsCount,
    commentsCount,
    activityUrn: urn ? 'urn:li:activity:' + urn : null,
    url: location.href,
  };

  // Output shape aligned with ozeo-leadgen get_comments (ingest reads .comments).
  return {
    postUrl:        location.href,
    reactionCount:  reactionsCount || 0,
    commentCount:   commentsCount != null ? commentsCount : items.length,
    comments:       items,
    // Extras (debug)
    post,
    count:          items.length,
    url:            location.href,
    title:          document.title,
  };
`);
