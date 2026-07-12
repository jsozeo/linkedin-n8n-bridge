// LinkedIn company-people extractor.
//
// Strategy ported from the validated Automa workflow:
//   - Open /company/<slug>/people/ (not /company/<slug>/ which is the
//     overview tab; we auto-rewrite via normalizeUrl()).
//   - Scroll the WINDOW four times (25/50/75/100%) to trigger lazy-loading of
//     additional people cards.
//   - Extract company top-card meta (name, logo, industry, location, followers,
//     employees, companyId) + people list (.org-people-profile-card__profile-info).
//
// Stable LinkedIn class names used here are part of the company-pages design
// system that LinkedIn keeps backwards-compatible because they are referenced
// by recruiter / sales-navigator features.

import { evalAsyncScript } from './_helpers.js';

export const ID = 'linkedin.peopleCompany';
// ozeo-leadgen dispatch step(s) this skill handles.
//   - get_company              → use the `company` slice of the output
//   - get_people_from_company  → use the `people` slice (wrapped as { profiles })
export const STEP_KEYS = ['get_company', 'get_people_from_company'];
// Match both the overview URL and the dedicated /people/ tab, plus search
// results that filter people by currentCompany.
export const URL_PATTERN = /linkedin\.com\/(company\/[^/?#]+(\/people)?|search\/results\/people)/i;

// Rewrite a bare /company/<slug>/ URL to /company/<slug>/people/ so the
// extractor lands on the right tab. Leave /people/ and search URLs alone.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/company\/([^/]+)\/?$/i);
    if (m) {
      u.pathname = `/company/${m[1]}/people/`;
      return u.toString();
    }
    return url;
  } catch { return url; }
}

export const WAIT_SELECTORS = ['main', '.org-top-card-summary__title, .org-people-profile-card__profile-info'];

export const SCROLL = { strategy: 'window', steps: [25, 50, 75, 100], delayMs: 2500 };

// We click "Show more results" buttons in-page so we need promise awaiting.
export const AWAIT_PROMISE = true;

export const EXTRACT_JS = evalAsyncScript(`
  // ── "Show more results" loop ─────────────────────────────────────────────
  // The /company/<slug>/people/ tab paginates with a button at the bottom of
  // the list. We click it repeatedly with a stale-rounds break-out (Automa's
  // proven pattern) so we don't loop forever if the click stops working.
  const SHOW_MORE_RE = /^(Show more results?|Voir plus de r[ée]sultats?|See more results?|Show more)$/i;
  const findShowMore = () => Array.from(document.querySelectorAll('button'))
    .find((b) => SHOW_MORE_RE.test((b.textContent || '').trim()) && !b.disabled);
  const countCards = () => document.querySelectorAll('main a[href*="/in/"]').length;
  let stale = 0, attempts = 0;
  while (attempts < 20 && stale < 3) {
    const prev = countCards();
    const btn = findShowMore();
    if (!btn) break;
    try {
      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
      btn.click();
    } catch (_) { break; }
    await sleep(1800);
    const next = countCards();
    if (next <= prev) stale++; else stale = 0;
    attempts++;
  }
  // Final settle once the click loop ends.
  await sleep(500);

  // ── Company top card ─────────────────────────────────────────────────────
  // 2026 layout: the legacy class names (.org-top-card-*) are gone in the
  // /people/ tab. We fall back to semantic markers: <h1> for the name (or
  // first <h2> in main), structured text leafs for the meta pills.
  const bodyHtml = document.body.innerHTML;
  const companyId = (bodyHtml.match(/urn:li:company:(\\d+)/) || [])[1] || null;

  const titleEl = $1('main h1') || $1('.org-top-card-summary__title') || $1('main h2');
  const companyName = txt(titleEl);

  // Logo: usually the FIRST image in <main> with an alt mentioning "logo"
  // (e.g. "Airbus Aircraft logo") or simply the company name.
  const logoImg = $1('main img[alt*=" logo" i]')
              || $1('.org-top-card-primary-content__logo img')
              || $1('.org-top-card-primary-content__logo-container img')
              || (companyName ? $1('main img[alt*="' + companyName.split(' ')[0] + '"]') : null);
  const logoUrl = logoImg ? logoImg.getAttribute('src') : null;

  // Top-card pills: industry, HQ, followers, employees. They appear in this
  // order on the company-overview / people page. The DOM still uses the
  // legacy class on some accounts; otherwise we collect the four short <p>'s
  // immediately after the company title.
  // NB: variable named 'hq' (not 'location') to avoid shadowing window.location.
  const legacyInfo = $$('.org-top-card-summary-info-list__info-item').map((el) => txt(el));
  let industry = null, hq = null, followersRaw = null, employeesRaw = null;
  if (legacyInfo.length >= 1) {
    industry     = legacyInfo[0] || null;
    hq           = legacyInfo[1] || null;
    followersRaw = legacyInfo[2] || null;
    employeesRaw = legacyInfo[3] || null;
  } else if (titleEl) {
    // Find the title's containing card and collect leaf <p> texts inside it.
    let card = titleEl;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      card = card.parentElement;
      if (card.querySelectorAll('p').length >= 4) break;
    }
    const pTxts = $$('p', card)
      .filter((el) => !el.querySelector('p'))
      .map((el) => (el.innerText || el.textContent || '').trim())
      .filter(Boolean);
    // First entries are usually the four meta pills.
    industry     = pTxts.find((t) => /Manufacturing|Software|Services|Technology|Industry|Information|Banking|Pharmaceutical|Aerospace|Retail|Defense|Energy|Aviation/i.test(t)) || null;
    hq           = pTxts.find((t) => /, |Region|Metropolitan|Greater/.test(t) && t.length < 80 && t !== industry) || null;
    followersRaw = pTxts.find((t) => /follower|abonn[ée]/i.test(t)) || null;
    employeesRaw = pTxts.find((t) => /employee|salari[ée]|associated member/i.test(t)) || null;
  }

  const tagline = txt($1('.org-top-card-summary__tagline')) || null;

  // "X associated members" heading appears above the people list. We parse
  // the number from the heading text since the format varies by locale.
  const membersHeader = $$('h2, h3').find((h) =>
    /associated members|abonn[ée]s|employ[ée]s|salari[ée]s/i.test(h.innerText || ''));
  const totalMembersRaw = membersHeader ? (membersHeader.innerText || '').trim() : '';
  // Robust int parse: extract digits + comma blocks ("4,039") and strip commas.
  const totalMembersMatch = totalMembersRaw.match(/(\\d[\\d,]*)/);
  const totalMembers = totalMembersMatch
    ? parseInt(totalMembersMatch[1].replace(/,/g, ''), 10)
    : null;

  // ── People list ──────────────────────────────────────────────────────────
  // The 2026 layout uses hashed CSS class names, so we cannot rely on
  // .org-people-profile-card__profile-info or .artdeco-entity-lockup__*.
  // Strategy: a "people card" is the smallest ancestor of an /in/ profile
  // link that ALSO contains an action button labelled "Connect", "Message",
  // "Pending", "Following", "Follow" or their FR equivalent. Mutual-connection
  // mentions inside another person's card do NOT have such a button so they
  // are filtered out naturally.
  const ACTION_BTN_RE = /^(Connect|Message|Pending|Following|Follow|Suivre|Connecter|Envoyer|Suivi|En attente)$/i;
  const hasActionBtn = (el) => {
    if (!el || !el.querySelectorAll) return false;
    const btns = el.querySelectorAll('button');
    for (const b of btns) {
      if (ACTION_BTN_RE.test((b.textContent || '').trim())) return true;
    }
    return false;
  };
  // A card is the smallest ancestor of an /in/ link that ALSO has both:
  //   1. an action button (Connect / Message / …)
  //   2. >= 40 chars of visible text — the button-only inline wrapper isn't
  //      enough; we need the surrounding wrapper with name + headline + location.
  // After matching, we also bubble up one extra level if the parent still has
  // a single /in/ link (helps capture LinkedIn's deeper wrapper without
  // bleeding into sibling cards).
  const isCardLike = (el) => {
    if (!hasActionBtn(el)) return false;
    const txtv = (el.innerText || el.textContent || '').trim();
    return txtv.length >= 40;
  };
  // Find each card: walk up from the /in/ link, stop at the SMALLEST ancestor
  // containing an action button AND staying within a single person's wrapper
  // (i.e. its set of /in/ slugs has cardinality 1). This avoids the "first
  // card swallows the company top card" boundary-bleed bug we saw in dry-run.
  const slugsInside = (el) => {
    const set = new Set();
    el.querySelectorAll('a[href*="/in/"]').forEach((l) => {
      const m = (l.getAttribute('href') || '').match(/\\/in\\/([^/?#]+)/);
      if (m) set.add(m[1]);
    });
    return set;
  };
  const cards = [];
  const seenCards = new Set();
  for (const a of $$('main a[href*="/in/"]')) {
    let node = a, found = null;
    for (let i = 0; i < 14; i++) {
      const p = node.parentElement;
      if (!p) break;
      node = p;
      // Stop as soon as we capture another person's link (we've gone too far).
      if (slugsInside(node).size > 1) break;
      if (isCardLike(node)) { found = node; break; }
    }
    if (!found) continue;
    if (!seenCards.has(found)) { seenCards.add(found); cards.push(found); }
  }
  // Fallback to legacy class selector for older accounts still on the old
  // layout (some LinkedIn locales lag behind the rollout).
  if (cards.length === 0) {
    for (const c of $$('.org-people-profile-card__profile-info')) cards.push(c);
  }

  const seen = new Set();
  const people = [];
  const ACTION_TEXTS = new Set(['Connect','Message','Pending','Following','Follow','Suivre','Connecter','En attente','Envoyer un message','Suivi','+ Follow','View profile']);
  const BADGE_TEXTS  = new Set(['Premium','Verified','Top Voice','Executive Top Voice','Influencer','Open to work','LinkedIn Member']);
  for (const card of cards) {
    const linkEl = card.querySelector('a[href*="/in/"]');
    if (!linkEl) continue;
    const rawHref = linkEl.getAttribute('href') || '';
    const profileUrl = canonicalLi(rawHref.split('?')[0]);
    if (!profileUrl || seen.has(profileUrl)) continue;
    seen.add(profileUrl);

    const miniUrnMatch = rawHref.match(/miniProfileUrn=([^&]+)/);
    const miniUrn = miniUrnMatch ? decodeURIComponent(miniUrnMatch[1]) : null;
    const slugMatch = profileUrl.match(/\\/in\\/([^/?#]+)/);
    const slug = slugMatch ? slugMatch[1] : null;

    // Avatar: prefer non-placeholder images. LinkedIn lazy-loads with a 1x1
    // base64 GIF before the real avatar URL is set.
    const avatarImgs = $$('img', card);
    const realAvatar = avatarImgs.find((img) => {
      const s = img.getAttribute('src') || '';
      return s && !s.startsWith('data:');
    });
    const avatarImg = realAvatar || avatarImgs[0];
    const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : null;

    // Read the card as visible lines. innerText respects \\n between block
    // elements, which works regardless of whether LinkedIn uses <p> or <span>.
    // textContent is a fallback for jsdom-style environments.
    const rawText = (card.innerText || card.textContent || '');
    const lines = rawText.split(/\\r?\\n/).map((s) => s.trim()).filter((s) => s.length > 0);

    // Strip action / badge labels and obvious noise.
    // The aria-description "Xrd+ degree connection" / "Xst degree connection"
    // shows up as plain text in some locales — strip it.
    const useful = lines.filter((t) =>
      !ACTION_TEXTS.has(t) &&
      !BADGE_TEXTS.has(t) &&
      !/^(View|Show|See|Connect|Message|Follow|Suivre)$/i.test(t) &&
      !/degree connection$/i.test(t) &&
      !/^Status is (online|offline|away)$/i.test(t) &&
      t !== '·'
    );

    // Classify each visible line. The 2026 layout puts the degree ("· 2nd")
    // on its own line, separate from the name, so we test for several patterns
    // independently rather than positionally.
    const NAME_DEGREE_INLINE_RE = /^(.+?)\\s*[·•]\\s*(1st|2nd|3rd|1er|2e|3e)\\+?$/i;
    const DEGREE_ONLY_RE        = /^[·•]?\\s*(1st|2nd|3rd|1er|2e|3e)\\+?$/i;
    const LOCATION_RE           = /(, |Metropolitan|Region|R[ée]gion|Greater)/;
    const MUTUAL_RE             = /mutual connections?$|is a mutual connection$/i;
    const CURRENT_RE            = /^Current:\\s*/i;

    let name = null, degree = null, headline = null, locationLine = null, currentRole = null, mutualConnections = null;
    for (const t of useful) {
      // 1. inline "Name · 2nd"
      const m = t.match(NAME_DEGREE_INLINE_RE);
      if (!name && m && !DEGREE_ONLY_RE.test(t)) { name = m[1].trim(); degree = m[2]; continue; }
      // 2. degree alone on a line ("· 2nd")
      if (!degree) {
        const dm = t.match(DEGREE_ONLY_RE);
        if (dm) { degree = dm[1]; continue; }
      }
      // 3. mutuals
      if (!mutualConnections && MUTUAL_RE.test(t)) { mutualConnections = t; continue; }
      // 4. current role
      if (!currentRole && CURRENT_RE.test(t)) { currentRole = t.replace(CURRENT_RE, '').trim(); continue; }
      // 5. location (has comma/region marker, short)
      if (!locationLine && LOCATION_RE.test(t) && t.length < 100 && t !== name) { locationLine = t; continue; }
      // 6. NAME first — the first plain short line that's not yet classified.
      //    LinkedIn always puts the name as the very first item in the card.
      if (!name && t.length > 1 && t.length < 80 && !DEGREE_ONLY_RE.test(t) && !/^\\d+\\s/.test(t)) { name = t; continue; }
      // 7. headline — anything substantial after name has been captured
      if (!headline && t !== name && t.length > 4 && !DEGREE_ONLY_RE.test(t) && !/^\\d+\\s/.test(t)) { headline = t; continue; }
    }
    // Name from link aria-label fallback (handles cases where <p> is missing).
    if (!name) {
      const alt = (avatarImg?.getAttribute('alt') || linkEl.getAttribute('aria-label') || '').replace(/^View\\s+/i, '').replace(/['\\u2019]s\\s+profile.*/i, '').trim();
      if (alt) name = alt;
    }

    // Each people row carries the leadgen ingest aliases inline so the
    // worker doesn't need a per-field rename. ozeo-ingest is alias-tolerant
    // (snake_case wins, camelCase is also accepted — see SCHEMAS.md).
    people.push({
      vmid:            slug,
      profile_url:     profileUrl,
      full_name:       name,
      tag_line:        headline,
      profile_img_url: avatarUrl,
      // Extras (ignored by ingest, kept for orchestrator-side scoring)
      degree,
      localisation:    locationLine,
      currentRole,
      mutualConnections,
      miniUrn,
    });
  }

  // Output shape:
  //   - company: ozeo-leadgen /webhook/d2-company payload (rooted at top
  //     when stepKey === 'get_company').
  //   - people:  list wrapped server-side as { profiles: people } when
  //              stepKey === 'get_people_from_company'.
  // PK + linkedinUrl resolution stay the responsibility of the worker.
  return {
    company: {
      linkedinUrl:  companyId ? 'https://www.linkedin.com/company/' + companyId + '/' : location.href,
      nom:          companyName,
      headline:     tagline,
      localisation: hq,
      about:        null,                // not extracted from /people tab
      // Reserved jsonb columns — kept empty for now, ozeo-d2-company tolerates
      experiences:    [],
      formations:     [],
      certifications: [],
      langues:        [],
      skills:         [],
      // Extras (debug / not persisted)
      companyId,
      logoUrl,
      tagline,
      industry,
      followersLine: followersRaw,
      employeesLine: employeesRaw,
      totalMembersLine: totalMembersRaw || null,
      totalMembers,
    },
    people,
    count: people.length,
    // Diagnostics
    url: location.href,
    title: document.title,
  };
`);
