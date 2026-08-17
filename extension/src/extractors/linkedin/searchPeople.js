// LinkedIn people-search extractor.
//
// Handles the global people search results page:
//   /search/results/people/?keywords=…&origin=…
//
// The list shows ~10 results per page and paginates with a "Next" button at the
// bottom (NOT infinite scroll, NOT a "show more" button). We extract the current
// page, then click "Next" and merge, bounded by a wall-clock budget so the whole
// run finishes before the MV3 service worker is torn down (~30s).
//
// 2026 layout hashes CSS class names, so cards are found semantically: the
// smallest ancestor of an /in/ profile link that also holds an action button
// (Connect / Message / Follow / …) and enough visible text.

import { evalAsyncScript } from './_helpers.js';

export const ID = 'linkedin.searchPeople';
export const STEP_KEYS = ['search_people'];
export const URL_PATTERN = /linkedin\.com\/search\/results\/people/i;

export const WAIT_SELECTORS = ['main', 'a[href*="/in/"]'];

// A light window scroll pre-warms lazy images; the async EXTRACT drives the
// real pagination itself.
export const SCROLL = { strategy: 'window', steps: [60, 100], delayMs: 1200 };

// EXTRACT clicks "Next" between pages, so the runner must await the promise.
export const AWAIT_PROMISE = true;

export const EXTRACT_JS = evalAsyncScript(`
  const BADGE_TEXTS  = new Set(['Premium','Verified','Top Voice','Executive Top Voice','Influencer','Open to work','LinkedIn Member']);
  const NAME_DEGREE_INLINE_RE = /^(.+?)\\s*[·•]\\s*(1st|2nd|3rd|1er|2e|3e)\\+?$/i;
  const DEGREE_ONLY_RE        = /^[·•]?\\s*(1st|2nd|3rd|1er|2e|3e)\\+?$/i;
  const LOCATION_RE           = /(, |Metropolitan|Region|R[ée]gion|Greater|Area)/;
  const CURRENT_RE            = /^Current:\\s*/i;
  const MUTUAL_RE             = /mutual connection|connexion(s)? en commun|is a mutual/i;

  // The person's own /in/ link on a search card carries visible text (the
  // name). Mutual-connection links are avatars only (no visible text) — so we
  // count NAME links (visible text) to find the card boundary, NOT raw slugs.
  const slug = (href) => { const m = (href || '').match(/\\/in\\/([^/?#]+)/); return m ? m[1] : null; };
  const nameLinksInside = (el) => {
    let n = 0;
    el.querySelectorAll('a[href*="/in/"]').forEach((l) => {
      if ((l.textContent || '').trim().length >= 2) n++;
    });
    return n;
  };
  // Action buttons on search cards are icon-only with an aria-label like
  // "Invite <Name> to connect" / "Message <Name>" / "Follow <Name>".
  const ACTION_ARIA_RE = /^(Invite .+ to connect|Message |Follow |Suivre |Se connecter|Envoyer un message|Message\\b)/i;
  const hasActionBtn = (el) => {
    for (const b of el.querySelectorAll('button, a')) {
      const al = (b.getAttribute && b.getAttribute('aria-label')) || '';
      if (ACTION_ARIA_RE.test(al)) return true;
      const t = (b.textContent || '').trim();
      if (/^(Connect|Message|Follow|Following|Pending|Suivre|Suivi|En attente)$/i.test(t)) return true;
    }
    return false;
  };

  const results = new Map();

  const extractPage = () => {
    // Seed cards from the person's NAME link (an /in/ link with visible text).
    const nameLinks = $$('main a[href*="/in/"]').filter((a) => (a.textContent || '').trim().length >= 2);
    const cards = [];
    const seenCards = new Set();
    for (const a of nameLinks) {
      let node = a, found = null;
      for (let i = 0; i < 16; i++) {
        const p = node.parentElement;
        if (!p) break;
        node = p;
        // Went too far — the ancestor now covers a second person.
        if (nameLinksInside(node) > 1) break;
        const textLen = (node.innerText || node.textContent || '').trim().length;
        if (hasActionBtn(node) && textLen >= 20) { found = node; }
      }
      // Fallback: no action button found (e.g. own profile) — take the closest
      // ancestor with a decent amount of text that still holds one name link.
      if (!found) {
        node = a;
        for (let i = 0; i < 8; i++) {
          const p = node.parentElement; if (!p) break; node = p;
          if (nameLinksInside(node) > 1) break;
          if ((node.innerText || '').trim().length >= 30) { found = node; break; }
        }
      }
      if (found && !seenCards.has(found)) { seenCards.add(found); cards.push(found); }
    }

    for (const card of cards) {
      // The primary link is the name link with the longest visible text.
      const inLinks = $$('a[href*="/in/"]', card).filter((l) => (l.textContent || '').trim().length >= 2);
      const linkEl = inLinks.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0]
                   || card.querySelector('a[href*="/in/"]');
      if (!linkEl) continue;
      let sl = slug(linkEl.getAttribute('href') || '');
      if (!sl) continue;
      try { sl = decodeURIComponent(sl); } catch (_) {}
      const profileUrl = 'https://www.linkedin.com/in/' + sl;
      if (results.has(profileUrl)) continue;

      const avatarImgs = $$('img', card);
      const realAvatar = avatarImgs.find((img) => { const s = img.getAttribute('src') || ''; return s && !s.startsWith('data:'); });
      const avatarUrl = (realAvatar || avatarImgs[0]) ? (realAvatar || avatarImgs[0]).getAttribute('src') : null;

      // Clean name: prefer an action button aria-label ("Invite <Name> to
      // connect" / "Message <Name>"), else the (often doubled) link text.
      let name = null;
      for (const b of card.querySelectorAll('button, a')) {
        const al = (b.getAttribute && b.getAttribute('aria-label')) || '';
        let m = al.match(/^Invite (.+?) to connect$/i) || al.match(/^Message (.+?)(?:,| \\u2022|$)/i)
             || al.match(/^Follow (.+)$/i);
        if (m) { name = m[1].trim(); break; }
      }
      if (!name) {
        let raw = (linkEl.textContent || '').replace(/\\s+/g, ' ').trim();
        const half = raw.slice(0, Math.floor(raw.length / 2));
        if (raw.length > 2 && raw === half + half) raw = half;
        if (raw && raw.length < 80) name = raw;
      }

      const lines = (card.innerText || card.textContent || '')
        .split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
      const useful = lines.filter((t) =>
        !BADGE_TEXTS.has(t) &&
        !/^(View|Show|See|Connect|Message|Follow|Following|Pending|Suivre|Suivi|Voir|Envoyer un message|Se connecter)$/i.test(t) &&
        !/degree connection$/i.test(t) &&
        !/^Status is (online|offline|away)$/i.test(t) &&
        t !== '·' && t !== '•');

      let degree = null, headline = null, locationLine = null, currentRole = null, mutual = null;
      for (const t of useful) {
        // "Name · 2nd" line: grab the degree, never treat it as a headline.
        const ndm = t.match(NAME_DEGREE_INLINE_RE);
        if (ndm && !DEGREE_ONLY_RE.test(t)) {
          if (!name) name = ndm[1].trim();
          if (!degree) degree = ndm[2];
          continue;
        }
        if (!degree) { const dm = t.match(DEGREE_ONLY_RE); if (dm) { degree = dm[1]; continue; } }
        if (name && t === name) continue;
        if (!mutual && MUTUAL_RE.test(t)) { mutual = t; continue; }
        if (!currentRole && CURRENT_RE.test(t)) { currentRole = t.replace(CURRENT_RE, '').trim(); continue; }
        if (!locationLine && LOCATION_RE.test(t) && t.length < 100 && t !== name && !MUTUAL_RE.test(t)) { locationLine = t; continue; }
        if (!headline && t !== name && t.length > 3 && !/^\\d+\\s/.test(t) && !MUTUAL_RE.test(t) && !DEGREE_ONLY_RE.test(t)) { headline = t; continue; }
      }

      results.set(profileUrl, {
        vmid:            sl,
        profile_url:     profileUrl,
        full_name:       name,
        tag_line:        headline,
        profile_img_url: avatarUrl,
        degree,
        localisation:    locationLine,
        currentRole,
        mutualConnections: mutual,
      });
    }
  };

  // ── Paginate ───────────────────────────────────────────────────────────────
  // Bounded so the whole extract stays under the MV3 SW budget (~30s).
  const DEADLINE = Date.now() + 18000;
  const findNext = () => document.querySelector('button[data-testid*="pagination-controls-next"]:not([disabled])')
    || Array.from(document.querySelectorAll('button')).find((b) => !b.disabled &&
      /^(Next|Suivant)$/i.test(((b.getAttribute('aria-label') || b.textContent) || '').trim()));

  window.scrollTo(0, document.body.scrollHeight);
  await sleep(800);
  extractPage();

  let pages = 1;
  while (Date.now() < DEADLINE && pages < 5) {
    const next = findNext();
    if (!next) break;
    const before = results.size;
    try { next.scrollIntoView({ behavior: 'instant', block: 'center' }); next.click(); } catch (_) {}
    await sleep(1800);
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);
    extractPage();
    pages++;
    if (results.size <= before) break;
  }

  const query = new URLSearchParams(location.search).get('keywords') || null;
  const resultsHeader = txtOf('main h1') || txtOf('main h2') || null;
  const people = [...results.values()];

  const _probe = {
    inLinks: $$('main a[href*="/in/"]').length,
    pagesVisited: pages,
    hasPagination: !!findNext() || $$('button[aria-label*="Page" i]').length > 0,
  };

  return {
    query,
    resultsHeader,
    people,
    count: people.length,
    url: location.href,
    title: document.title,
    _probe,
  };
`);
