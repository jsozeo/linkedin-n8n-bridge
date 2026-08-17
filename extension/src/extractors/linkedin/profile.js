// LinkedIn profile extractor (2026 layout).
//
// CRITICAL: scroll target is <main>, NOT window.
// On the current LinkedIn redesign, the document does not overflow at all
// (html.scrollHeight == clientHeight, body.overflowY = hidden). The actual
// scrollable container is <main> (overflowY: scroll). Scrolling the window
// is a strict no-op and never triggers lazy-load of Experience / Education /
// Skills / Recommendations / Languages sections — that's why a window-scroll
// profile run returns only About + Activity. We must scroll the <main>
// element itself.
//
// Selector strategy: we lean on Automa's proven approach:
//   - `[componentkey]` attributes (stable LinkedIn React component IDs)
//   - heading text (case-insensitive, accent-insensitive, multilingual)
//   - aria-label / data-testid (stable in their semantic intent)
// We DO NOT rely on hashed CSS class names which change every release.

import { evalScript } from './_helpers.js';

export const ID = 'linkedin.profile';
// ozeo-leadgen dispatch step(s) this skill handles. See docs/LEADGEN.md.
export const STEP_KEYS = ['get_profile'];
export const URL_PATTERN = /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+\/?(?:\?.*)?$/i;

export const WAIT_SELECTORS = ['main', 'main h1, main h2'];

// IMPORTANT: pane strategy targeting <main>. Steps 25/50/75/100 mirror
// Automa's working configuration. The runner inserts a delay between each
// step; LinkedIn's lazy-load watchers need ~1.5-2s to fire and render.
export const SCROLL = {
  strategy: 'pane',
  selector: 'main',
  steps: [25, 50, 75, 100],
  delayMs: 2000,
};

export const EXTRACT_JS = evalScript(`
  // ── Local helpers (mostly ported verbatim from the Automa workflow we
  //    validated on real profiles. Kept inline so this extractor is fully
  //    self-contained when migrated to ozeo-leadgen.) ────────────────────────
  const DATE_MON_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc)[a-z]*\\.?\\s+\\d{4}/i;
  const YEAR_RNG_RE = /\\b\\d{4}\\s*[-–]\\s*(\\d{4}|Present|now|aujourd'hui|en cours)\\b/i;
  const DURATION_RE = /\\d+\\s*(yr|mo|year|month|an|ans|mois)/i;
  const FOLLOWER_RE = /\\d[\\d,\\s\\u00a0]*\\s*(follower|connection|abonn[ée]|relation)/i;

  const looksLikeDate = (t) => DATE_MON_RE.test(t) || YEAR_RNG_RE.test(t) || DURATION_RE.test(t);

  const collectLeaf = (container, tag) => {
    if (!container) return [];
    const results = [], seen = new Set();
    container.querySelectorAll(tag).forEach((el) => {
      if (el.querySelector(tag)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const t = (el.innerText || '').trim();
      if (t && t.length > 1 && !seen.has(t)) { seen.add(t); results.push(t); }
    });
    return results;
  };
  const getTexts = (container) => {
    if (!container) return [];
    const byP = collectLeaf(container, 'p');
    return byP.length ? byP : collectLeaf(container, 'span');
  };
  const buildAbsUrl = (href) => {
    if (!href) return '';
    return href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
  };
  const findUrl = (block, pattern) => {
    if (!block) return '';
    let node = block;
    for (let i = 0; i <= 4; i++) {
      if (!node) break;
      const a = node.querySelector('a[href*="' + pattern + '"]');
      if (a) return buildAbsUrl(a.getAttribute('href'));
      node = node.parentElement;
    }
    return '';
  };

  const root = document.documentElement;

  // getSection(label): find the section block for "Experience", "Education", …
  // Strategy (in order of robustness): componentkey suffix → <section aria-label>
  //   → <section id> → heading-text + ancestor walk. Multilingual-aware.
  const getSectionByKeySuffix = (suffix) => {
    const lc = suffix.toLowerCase();
    for (const el of root.querySelectorAll('[componentkey]')) {
      const ck = (el.getAttribute('componentkey') || '').toLowerCase();
      if (ck.endsWith(lc) || ck.includes('.' + lc) || ck.includes('-' + lc)) return el;
    }
    return null;
  };
  // ── 2026 SDUI resolver (server-driven UI) ────────────────────────────────
  // The redesigned profile renders each section as a card whose componentkey
  // ends with a stable suffix, e.g.
  //   com.linkedin.sdui.profile.card.ref<URN>...ExperienceTopLevelSection
  // The visible "Experience" heading text ALSO appears inside an empty
  // ProfileNullStateCardAnchor_Experience placeholder, so a heading-text walk
  // wrongly resolves to that anchor (→ 0 entries). We therefore match the SDUI
  // card by componentkey suffix first, skipping anchor/null-state elements, and
  // pick the richest (longest innerText) match — that's the card holding the
  // entity-collection-item entries.
  const SDUI_MAP = [
    [/experience|expérience/i,        'ExperienceTopLevelSection'],
    [/education|formation/i,          'EducationTopLevelSection'],
    [/skills|compétences|competences/i, 'Skills'],
    [/licen|certificat/i,             'CertificationTopLevel'],
    [/languages|langues/i,            'LanguageTopLevel'],
    [/recommendation|recommandation/i,'RecommendationsTopLevel'],
    [/activity|activité|activite/i,   'Activity'],
    [/about|infos|propos/i,           'About'],
    [/featured|sélection|selection|une/i, 'Featured'],
    [/publication/i,                  'PublicationTopLevelSection'],
    [/courses|cours/i,                'CourseTopLevelSection'],
    [/honor|distinction/i,            'HonorsTopLevel'],
    [/volunteer|bénévol|benevol/i,    'VolunteerExperienceTopLevel'],
    [/project|projet/i,               'Projects'],
  ];
  const sduiSuffixFor = (labels) => {
    for (const [re, suf] of SDUI_MAP) if (labels.some((l) => re.test(l))) return suf;
    return null;
  };
  const getSduiCard = (suffix) => {
    let best = null, bestLen = -1;
    const re = new RegExp(suffix + '$', 'i');
    for (const el of root.querySelectorAll('[componentkey]')) {
      const ck = el.getAttribute('componentkey') || '';
      if (/anchor|nullstate/i.test(ck)) continue;
      if (!re.test(ck)) continue;
      const len = (el.innerText || '').length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    return best;
  };

  const getSection = (...labels) => {
    const suf = sduiSuffixFor(labels);
    if (suf) { const card = getSduiCard(suf); if (card) return card; }
    for (const label of labels) {
      const lc = label.toLowerCase();
      for (const el of root.querySelectorAll('section')) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase().trim();
        if (al === lc || al.includes(lc)) return el;
      }
      for (const el of root.querySelectorAll('section, div')) {
        const id = (el.getAttribute('id') || '').toLowerCase();
        if (id === lc || id.includes(lc)) return el;
      }
      const byKey = getSectionByKeySuffix(label);
      if (byKey) return byKey;
      let headingEl = null;
      for (const el of root.querySelectorAll('h1,h2,h3,h4,span')) {
        const txtv = (el.innerText || '').trim().toLowerCase();
        if (!el.querySelector('span,h1,h2,h3,h4') &&
            (txtv === lc || txtv.startsWith(lc + ' (') || txtv.startsWith(lc + ' '))) {
          headingEl = el; break;
        }
      }
      if (headingEl) {
        let node = headingEl;
        for (let i = 0; i < 14; i++) {
          node = node.parentElement;
          if (!node) break;
          if (node.tagName === 'SECTION') return node;
          const ck = (node.getAttribute('componentkey') || '').toLowerCase();
          if (ck.includes(lc)) return node;
          if (node.tagName === 'DIV' && node.querySelector('ul,li')) return node;
        }
      }
    }
    return null;
  };

  // findEntryBlocks: split a section's children into individual entries
  //   (one job, one school, one cert…).  Order of preference:
  //   1) [componentkey*="entity-collection-item"]    (most stable)
  //   2) top-level <li>                              (LinkedIn's classic list)
  //   3) heuristic: text blocks containing a date    (last resort)
  const UUID_CK_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const findEntryBlocks = (section) => {
    if (!section) return [];
    // 2026 SDUI: each entry is a child element keyed either by an
    // entity-collection-item hash (Experience) or a bare UUID componentkey
    // (Education, Certifications, …). Skip anchor/null-state placeholders, then
    // keep only the outermost candidates (drop entries nested inside another).
    const candidates = Array.from(section.querySelectorAll('[componentkey]')).filter((el) => {
      const ck = el.getAttribute('componentkey') || '';
      if (/anchor|nullstate/i.test(ck)) return false;
      return ck.includes('entity-collection-item') || UUID_CK_RE.test(ck);
    });
    const outermost = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
    if (outermost.length) return outermost;
    const topLis = Array.from(section.querySelectorAll('li'))
      .filter((el) => !el.parentElement || !el.parentElement.closest('li'));
    if (topLis.length) return topLis;
    const processed = new WeakSet(), blocks = [];
    section.querySelectorAll('span, p').forEach((el) => {
      if (el.children.length > 0) return;
      if (!looksLikeDate((el.innerText || '').trim())) return;
      let container = el;
      for (let d = 0; d < 12; d++) {
        const parent = container.parentElement;
        if (!parent || parent === section) break;
        container = parent;
        if (getTexts(container).length >= 3) break;
      }
      if (processed.has(container)) return;
      processed.add(container);
      blocks.push(container);
    });
    return blocks;
  };
  // Returns the leadgen-shaped experience object (poste/entreprise/lieu/...).
  const classifyExpTexts = (texts) => {
    let poste = '', entreprise = '', dates = '', lieu = '', description = '';
    for (const t of texts) {
      if (!poste)                              { poste = t;        continue; }
      if (!dates && looksLikeDate(t))          { dates = t;        continue; }
      if (!entreprise && !dates)               { entreprise = t;   continue; }
      if (dates && !lieu && t.length < 100)    { lieu = t;         continue; }
      if (!description && t.length >= 20)      { description = t;  }
    }
    return { poste, entreprise, dates, lieu, description };
  };

  // ── Top-card extraction ──────────────────────────────────────────────────
  const topcard = root.querySelector('[componentkey*="Topcard"], [componentkey*="topcard"]')
                || root.querySelector('section[componentkey]')
                || $1('main');
  const nameEl = topcard
    ? (topcard.querySelector('h1') || topcard.querySelector('h2'))
    : ($1('main h1') || $1('main h2'));
  const name = nameEl ? (nameEl.innerText || '').trim() : null;

  // Headline + location: walk ancestors of nameEl, keep only leaf <p>/<span>
  // text, and apply the same filtering heuristic Automa converged on.
  let headline = null, locationLine = null;
  if (nameEl) {
    let container = nameEl.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!container) break;
      const leaf = [];
      container.querySelectorAll('p, span, h1, h2, h3').forEach((el) => {
        if (el.querySelector('p,span,h1,h2,h3')) return;
        if (el.getAttribute('aria-hidden') === 'true') return;
        const t = (el.innerText || '').trim().replace(/&amp;/g, '&');
        if (t && t.length > 1) leaf.push(t);
      });
      const withoutName = leaf.filter((t) => t !== name);
      if (withoutName.length >= 3) {
        for (const t of withoutName) {
          if (/^·\\s*\\d/.test(t)) continue;
          if (FOLLOWER_RE.test(t)) continue;
          if (/^Contact info$/i.test(t)) continue;
          if (/^Add verification badge|Verify yourself|Verify identity$/i.test(t)) continue;
          if (/^(Open to|Show all|Show recent|Show more|Following|Connect|Message|Pending|Follow|More)$/i.test(t)) continue;
          if (!headline && t.includes('|'))   { headline = t; continue; }
          if (!headline && t.length > 20)     { headline = t; continue; }
          if (headline && !locationLine && t.length < 80 && t.length > 3
              && !t.includes('|') && !t.includes('·')
              && !/^(Contact|Open to|Show)/i.test(t)) {
            locationLine = t; break;
          }
        }
        if (headline) break;
      }
      container = container.parentElement;
    }
  }

  // Connections / followers count
  let connectionsCount = 0, connectionsLine = null;
  root.querySelectorAll('span, p').forEach((el) => {
    if (el.children.length) return;
    const t = (el.innerText || '').trim();
    const m = t.match(/^([\\d,]+\\+?)\\s+(follower|connection|abonn[ée]|relation)/i);
    if (m && !connectionsCount) {
      connectionsCount = parseInt(m[1].replace(/[+,]/g, ''), 10) || 0;
      connectionsLine = t;
    }
  });

  // Profile ID + canonical URN
  const urlMatch = (location.href || '').match(/\\/in\\/([^/?#]+)/);
  const profileSlug = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
  let profileUrn = null;
  const urnCandidates = [];
  root.querySelectorAll('[componentkey]').forEach((el) => {
    const m = (el.getAttribute('componentkey') || '').match(/ACoAAD?[A-Za-z0-9+/=_-]+/);
    if (m) urnCandidates.push(m[0]);
  });
  if (urnCandidates.length) {
    profileUrn = urnCandidates.sort((a, b) => a.length - b.length)[0];
  }

  // ── About ────────────────────────────────────────────────────────────────
  // First try the official screen-reader box (most stable). Falls back to
  // section text walking if LinkedIn changes the data-testid.
  let about = null;
  const aboutBox = $1('span[data-testid="expandable-text-box"]')
                || $1('main span[aria-hidden="true"]');
  if (aboutBox) about = (aboutBox.innerText || '').trim();
  if (!about) {
    const aboutSection = getSection('About', 'Infos', 'A propos', 'À propos');
    if (aboutSection) {
      const texts = getTexts(aboutSection).filter((t) => !/^(about|infos|a propos|à propos)$/i.test(t));
      if (texts.length) about = texts.join('\\n');
    }
  }
  if (about) about = about.replace(/\\s*…\\s*more$/i, '').slice(0, 4000);

  // ── Top skills (small inline pill list above the Experience section) ────
  const topSkills = [];
  const topSkillsLink = root.querySelector('a[aria-label="Show top skills"], a[aria-label*="top skills"]');
  if (topSkillsLink) {
    let node = topSkillsLink.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!node) break;
      let found = false;
      node.querySelectorAll('p, span').forEach((el) => {
        if (found) return;
        const t = (el.innerText || '').trim();
        if (t.includes('•') && !t.toLowerCase().startsWith('top skills')) {
          t.split('•').forEach((s) => {
            const sk = s.trim();
            if (sk && sk.length > 1) topSkills.push(sk);
          });
          found = true;
        }
      });
      if (found) break;
      node = node.parentElement;
    }
  }

  // ── Skills (full list section) ──────────────────────────────────────────
  const skillsItems = [];
  let skillsTotal = 0;
  const skillsSection = getSection('Skills', 'Compétences');
  if (skillsSection) {
    const headingEl2 = skillsSection.querySelector('h2, h3');
    const totalMatch = (headingEl2 ? headingEl2.innerText : '').match(/\\((\\d+)\\)/);
    if (totalMatch) skillsTotal = parseInt(totalMatch[1], 10);
    const SKILL_NOISE = new Set([
      'Skills', 'Compétences', 'Show all', 'Voir tout',
      'Show top skills', 'Endorsed', 'endorsements', 'Show',
      'Save to PDF', '+', '·'
    ]);
    // Noise patterns. Note: JS regex \\b is ASCII-only — it would NOT match
    // after non-ASCII letters like "é" in "Faculté". So we anchor school /
    // university markers at the start of the candidate string instead.
    const SKILL_NOISE_RE   = /(endorsement|endorsed by|recommendation)/i;
    const SKILL_SCHOOL_RE  = /^(faculté|université|university|école|college|institut|school)\\b/i;
    const seenSkills = new Set();
    for (const t of [...collectLeaf(skillsSection, 'p'), ...collectLeaf(skillsSection, 'span')]) {
      if (SKILL_NOISE.has(t)) continue;
      if (SKILL_NOISE_RE.test(t)) continue;
      if (SKILL_SCHOOL_RE.test(t)) continue;
      // Endorser subtitles are typically long ("Faculté X - Université Y, City")
      // — any " - " or " — " separator inside a "skill" is a strong noise signal.
      if (/\\s[-–—]\\s/.test(t) && t.length > 25) continue;
      if (/^\\d+$/.test(t) || FOLLOWER_RE.test(t) || /\\bat\\s+\\w/i.test(t) || looksLikeDate(t) || t.length > 80) continue;
      if (!seenSkills.has(t)) { seenSkills.add(t); skillsItems.push({ name: t }); }
    }
  }

  // ── Experience ──────────────────────────────────────────────────────────
  // We capture the title/org/dates/location/description AND two extras LinkedIn
  // shows below each entry on the 2026 layout:
  //   - companyLogoUrl  → first img.src inside the block (logo, not media)
  //   - skillsHint      → the "Cold email, Outbound Sales and +2 skills" line
  //                       that LinkedIn shows when an experience is tagged
  //                       with skills. Visible UI hint, not the full list.
  const experiences = [];
  const expSection = getSection('Experience', 'Expérience', 'Expériences');
  if (expSection) {
    findEntryBlocks(expSection).forEach((block) => {
      const texts = getTexts(block);
      if (texts.length < 2) return;
      const exp = classifyExpTexts(texts);
      exp.companyUrl = findUrl(block, '/company/') || null;

      const logoImg = block.querySelector('img[alt*=" logo" i], img[alt$="logo" i]')
                  || block.querySelector('img');
      exp.companyLogoUrl = logoImg ? logoImg.getAttribute('src') : null;

      // Skills hint: any text containing "skills" preceded by a comma list and
      // optionally a "+N" remainder ("Cold email, Outbound Sales and +2 skills").
      const skillsHint = texts.find((t) =>
        /\\bskills?$/i.test(t) && /(,|\\sand\\s|\\+\\d)/.test(t) && t.length < 200
      );
      exp.skillsHint = skillsHint || null;

      // Drop the skillsHint from description if it leaked in.
      if (exp.description && skillsHint && exp.description.includes(skillsHint)) {
        exp.description = exp.description.replace(skillsHint, '').trim();
      }

      experiences.push(exp);
    });
  }

  // ── Education ───────────────────────────────────────────────────────────
  // Emits the leadgen shape: { ecole, diplome, annees, activites, schoolUrl }.
  const formations = [];
  const eduSection = getSection('Education', 'Formation', 'Formations');
  if (eduSection) {
    const seenEdu = new Set();
    findEntryBlocks(eduSection).forEach((block) => {
      const texts = getTexts(block);
      const schoolLink = block.querySelector('a[href*="/school/"]');
      // Keep degree-less entries (school name only) as long as we can name the school.
      if (texts.length < 2 && !schoolLink && !texts.length) return;
      const schoolLabel = schoolLink ? (schoolLink.getAttribute('aria-label') || '').trim() : '';
      const ecole = schoolLabel || texts[0];
      let diplome = '', annees = '', activites = '';
      const rest = schoolLabel ? texts : texts.slice(1);
      for (const t of rest) {
        if (t === ecole) continue;
        if (!annees && /\\d{4}/.test(t))                       { annees = t;     continue; }
        if (!diplome && !t.toLowerCase().includes('activit'))  { diplome = t;    continue; }
        if (t.toLowerCase().includes('activit'))               { activites = t;  break; }
      }
      const key = ecole + '|' + annees;
      if (!seenEdu.has(key)) {
        seenEdu.add(key);
        formations.push({ ecole, diplome, annees, activites, schoolUrl: findUrl(block, '/school/') || null });
      }
    });
  }

  // ── Licenses & certifications ───────────────────────────────────────────
  const certifications = [];
  const certSection = getSection('Licenses & certifications', 'Licences & certifications', 'Certifications');
  if (certSection) {
    findEntryBlocks(certSection).forEach((block) => {
      const texts = getTexts(block);
      if (!texts.length) return;
      const dates = texts.find((t) => looksLikeDate(t)) || '';
      certifications.push({ title: texts[0] || '', issuer: texts[1] || '', dates });
    });
  }

  // ── Languages ───────────────────────────────────────────────────────────
  // Emits leadgen shape: [{ langue, niveau }].
  const langues = [];
  const langSection = getSection('Languages', 'Langues');
  if (langSection) {
    const langBlocks = findEntryBlocks(langSection);
    const LANG_NOISE_RE = /^(languages|langues|show all|show more|voir tout|voir plus|\\+\\d)/i;
    const isPlausibleLang = (t) => t && t.length > 1 && t.length < 60 && !LANG_NOISE_RE.test(t);
    if (langBlocks.length) {
      langBlocks.forEach((block) => {
        const texts = getTexts(block).filter(isPlausibleLang);
        if (texts.length) langues.push({ langue: texts[0], niveau: texts[1] || '' });
      });
    } else {
      const all = collectLeaf(langSection, 'span').filter(isPlausibleLang);
      for (let i = 0; i < all.length; i += 2) {
        langues.push({ langue: all[i], niveau: all[i + 1] || '' });
      }
    }
  }

  // ── Publications / Courses (kept generic, low priority) ────────────────
  const collectGeneric = (...labels) => {
    const sec = getSection(...labels);
    if (!sec) return { found: false, items: [] };
    const items = [];
    findEntryBlocks(sec).forEach((b) => {
      const t = getTexts(b);
      if (t.length) items.push({ texts: t.slice(0, 6) });
    });
    return { found: true, items };
  };
  const publications = collectGeneric('Publications').items;
  const courses      = collectGeneric('Courses', 'Cours').items;

  // ── Featured ────────────────────────────────────────────────────────────
  // Each card has a "type" tag (Post / Article / Photo / Document / Link /
  // Video / Newsletter) at the top, a title, optional preview image, a link
  // to the actual content, and a meta footer with reactions/comments counts.
  const FEATURED_TYPES = /^(Post|Article|Photo|Document|Link|Video|Newsletter|Image|Publication)$/i;
  const featured = [];
  const featuredSection = getSection('Featured', 'Sélection', 'À la une');
  if (featuredSection) {
    findEntryBlocks(featuredSection).forEach((block) => {
      const link = block.querySelector('a[href*="/feed/update/"], a[href*="/posts/"], a[href*="/pulse/"], a[href*="/article/"], a[href]');
      const url = link ? canonicalLi(link.href) : null;
      const img = block.querySelector('img[src*="feedshare"], img[src*="article"], img[src*="image"], img:not([alt*=" logo" i])');
      const imageUrl = img ? img.getAttribute('src') : null;
      const texts = getTexts(block);
      const type = texts.find((t) => FEATURED_TYPES.test(t)) || null;
      // Title = longest text that isn't a type tag or a meta count line.
      const titleCandidates = texts.filter((t) =>
        !FEATURED_TYPES.test(t) &&
        !/^\\d[\\d,]*\\s*(reaction|comment|repost)/i.test(t) &&
        !/^\\d[\\d,]*\\s*[·•]/.test(t) &&
        t.length > 5
      );
      const title = titleCandidates.sort((a, b) => b.length - a.length)[0] || null;

      // Meta counts. Featured cards usually render counts as plain text
      // "<N> reactions · <N> comments" with no aria-label.
      const blockText = (block.textContent || '').replace(/\\s+/g, ' ');
      const reactM = blockText.match(/(\\d[\\d,]*)\\s*(?:reaction|réaction)/i)
                  || blockText.match(/[·•]\\s*(\\d[\\d,]*)\\s*(?:comment|commentaire)/i);
      const commentM = blockText.match(/(\\d[\\d,]*)\\s*(?:comment|commentaire)/i);
      const reactions = reactM ? parseInt(reactM[1].replace(/,/g, ''), 10) : 0;
      const comments  = commentM ? parseInt(commentM[1].replace(/,/g, ''), 10) : 0;

      featured.push({ type, title, url, imageUrl, reactions, comments });
    });
  }

  // ── Interests ───────────────────────────────────────────────────────────
  // Shape: { category: 'Top Voices'|'Companies'|'Groups'|'Schools',
  //          items: [{ name, headline, followers, profileUrl, avatarUrl }] }
  // Only the currently-visible tab is captured (LinkedIn loads other tabs
  // on click). We do NOT click — that's a tradeoff for a single scrape.
  const interestsSection = getSection('Interests', "Centres d'intérêt", "Centres d'interet");
  let interests = { category: null, items: [] };
  if (interestsSection) {
    const selectedTab = interestsSection.querySelector('[role="tab"][aria-selected="true"], button[aria-pressed="true"]');
    interests.category = selectedTab ? (selectedTab.textContent || '').trim() : 'Top Voices';
    const itemBlocks = findEntryBlocks(interestsSection);
    itemBlocks.forEach((block) => {
      const link = block.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/groups/"], a[href*="/school/"]');
      if (!link) return;
      const profileUrl = canonicalLi(link.href);
      const img = block.querySelector('img');
      const avatarUrl = img ? img.getAttribute('src') : null;
      const altName   = img ? (img.getAttribute('alt') || '')
                                .replace(/^View\\s+/i, '')
                                .replace(/['\\u2019]s\\s+profile.*/i, '')
                                .replace(/^View company:\\s*/i, '')
                                .trim() : '';
      const texts = getTexts(block);
      const name = altName || texts.find((t) => t.length > 2 && t.length < 80 && !/follower|abonn/i.test(t) && !/\\d+\\s*(st|nd|rd|th)/i.test(t)) || null;
      const headline = texts.find((t) =>
        t !== name && t.length > 15 && !/follower|abonn/i.test(t)
        && !/^(Follow|Following|Connect|Subscribe|See connections)$/i.test(t)
        && !/\\d+\\s*(st|nd|rd|th)/i.test(t)
      ) || null;
      const followersM = (block.textContent || '').match(/(\\d[\\d,]*)\\s*(?:follower|abonn[ée])/i);
      const followers = followersM ? parseInt(followersM[1].replace(/,/g, ''), 10) : null;
      interests.items.push({ name, headline, profileUrl, avatarUrl, followers });
    });
  }

  // ── Recommendations ─────────────────────────────────────────────────────
  const recommendations = [];
  const recSection = getSection('Recommendations', 'Recommandations');
  if (recSection) {
    findEntryBlocks(recSection).forEach((block) => {
      const texts = getTexts(block);
      if (texts.length < 2) return;
      const authorLink = block.querySelector('a[href*="/in/"]');
      recommendations.push({
        author: texts[0] || '',
        relation: texts[1] || '',
        text: texts.slice(2).join('\\n'),
        authorUrl: authorLink ? canonicalLi(authorLink.href) : null,
      });
    });
  }

  // ── Activity (recent posts on the profile, max 10) ──────────────────────
  // Each activity item has a stable anchor: span[data-testid="expandable-text-box"]
  // = the actual post body. We walk up from it to find the card container,
  // then split it into structured fields. We do NOT just lump everything into
  // a single text blob (the previous approach mixed author name, headline,
  // CTA "Visit my website" and the post body together).
  //
  // Field schema per activity item:
  //   - activityId, activityUrl     : LinkedIn share/activity URN
  //   - isRepost                    : true if "<owner> reposted this" precedes
  //   - author    : { name, headline, profileUrl, avatarUrl, isCompany }
  //   - timestamp                   : "2w", "18h", "1d", "3mo", …
  //   - postText                    : clean body, no name/headline/CTA noise
  //   - reactions, comments, reposts : counts (numbers, 0 if absent)
  //   - mediaUrl                    : feedshare image / video poster
  const activity = [];
  const actSection = getSection('Activity', 'Activité');
  const ownerSlug = profileSlug ? profileSlug.toLowerCase() : null;
  if (actSection) {
    const seenActivityIds = new Set();
    const processedAct = new WeakSet();
    // Anchor on expandable-text-box (each post has exactly one). Fallback
    // to activity links if a post is a media-only repost without body.
    const anchors = [...actSection.querySelectorAll('span[data-testid="expandable-text-box"]')];
    const links   = [...actSection.querySelectorAll('a[href*="activity:"], a[href*="activity-"], a[href*="urn:li:activity"]')];

    const walkToContainer = (start) => {
      let c = start;
      for (let i = 0; i < 20; i++) {
        const p = c.parentElement;
        if (!p || p === actSection) break;
        c = p;
        // Container is "big enough" when it has both author and post body.
        const hasImg = c.querySelector('img[alt*="profile" i], img[alt*="company" i]');
        const hasTxt = c.querySelector('span[data-testid="expandable-text-box"]');
        if (hasImg && hasTxt) break;
      }
      return c;
    };

    const collectFor = (anchor) => {
      const container = walkToContainer(anchor);
      if (processedAct.has(container)) return;

      // Find the activity link inside the container to derive the id/url.
      const activityLink = container.querySelector('a[href*="urn:li:activity"], a[href*="activity:"], a[href*="activity-"]');
      const href = activityLink ? activityLink.getAttribute('href') : null;
      const idMatch = (href || '').match(/(?:activity[:\\-]|urn:li:activity:)(\\d+)/);
      if (!idMatch) return;
      const activityId = idMatch[1];
      if (seenActivityIds.has(activityId)) return;
      seenActivityIds.add(activityId);
      processedAct.add(container);

      // Post text (cleanest single source — no need to filter noise).
      const postTextEl = container.querySelector('span[data-testid="expandable-text-box"]');
      const postText = postTextEl ? (postTextEl.textContent || '').trim().replace(/\\s*…\\s*more$/i, '').slice(0, 4000) : '';

      // Repost detection. NOTE: container.textContent concatenates adjacent
      // <p>'s without separator, so "reposted thisZartonk Media" — we cannot
      // anchor with \\b. Use a permissive substring match instead.
      const containerText = (container.textContent || '').replace(/\\s+/g, ' ');
      const isRepost = /reposted this|a republié|a partagé ceci/i.test(containerText);

      // Author. Strategy:
      //   1. img[alt="View company: <X>"]              → company author
      //   2. second img[alt="View <name>'s profile"]   → person author (skip the
      //      first which is the profile owner on a repost). On a non-repost own
      //      post the only img IS the owner — author = owner = profile.
      //   3. fallback: first <a href="/in/"> that doesn't match owner slug
      const companyImg = container.querySelector('img[alt^="View company:" i]');
      let authorName = null, authorProfileUrl = null, authorAvatarUrl = null, authorIsCompany = false;
      if (companyImg) {
        authorIsCompany = true;
        authorName = (companyImg.getAttribute('alt') || '').replace(/^View company:\\s*/i, '').trim();
        authorAvatarUrl = companyImg.getAttribute('src') || null;
        const companyLink = container.querySelector('a[href*="/company/"]');
        if (companyLink) {
          // Strip subpath like /posts /people /about /jobs from company URL
          authorProfileUrl = canonicalLi(companyLink.href).replace(/\\/(posts|people|about|jobs|life|videos)\\/?$/i, '');
        }
      } else {
        const personImgs = [...container.querySelectorAll('img[alt*="profile" i]')];
        const altOf = (img) => (img.getAttribute('alt') || '')
          .replace(/^View\\s+/i, '')
          .replace(/['\\u2019\\u00b4\\u0060]s\\s+profile.*/i, '')
          .trim();
        const ownerImg = personImgs.find((img) => {
          const a = altOf(img).toLowerCase();
          return name && a && a.toLowerCase() === name.toLowerCase();
        });
        const authorImg = isRepost
          ? personImgs.find((img) => img !== ownerImg)
          : (ownerImg || personImgs[0]);
        if (authorImg) {
          authorName = altOf(authorImg);
          authorAvatarUrl = authorImg.getAttribute('src') || null;
        }
        // Resolve profile URL from a non-owner /in/ link. We exclude any link
        // whose displayed text matches the profile owner's name (handles the
        // case where ownerSlug isn't available, e.g. dry-runs or pages without
        // a canonical URL).
        const personLinks = [...container.querySelectorAll('a[href*="/in/"]')];
        const isOwnerLink = (a) => {
          const slug = (a.getAttribute('href') || '').match(/\\/in\\/([^/?#]+)/);
          if (ownerSlug && slug && slug[1].toLowerCase() === ownerSlug) return true;
          const linkText = (a.textContent || '').trim();
          if (name && linkText && linkText === name) return true;
          // Some <a> wrap an <img alt="View <owner>'s profile">
          const img = a.querySelector('img[alt]');
          if (img) {
            const a2 = (img.getAttribute('alt') || '').replace(/^View\\s+/i, '').replace(/['\\u2019]s\\s+profile.*/i, '').trim();
            if (name && a2 === name) return true;
          }
          return false;
        };
        // For reposts: the original-post author is non-owner. For non-reposts:
        // the author IS the owner (or a tagged poster on a quoted share).
        let authorLink;
        if (isRepost) {
          authorLink = personLinks.find((a) => !isOwnerLink(a));
        } else {
          authorLink = personLinks.find(isOwnerLink) || personLinks[0];
        }
        if (authorLink) authorProfileUrl = canonicalLi(authorLink.href);
      }

      // Author headline + timestamp from container <p>'s.
      // For company authors we don't try to extract a headline (companies
      // don't have one — what looked like a headline before was the post body).
      const ps = [...container.querySelectorAll('p')].map((p) => (p.textContent || '').trim()).filter(Boolean);
      const TS_RE = /^\\d+\\s*(h|d|w|mo|m|y|min|s|sec|hr)\\s*[•·]?/i;
      const CTA_RE = /^(Visit my website|Book an appointment|Subscribe|Show translation|Show more|Suivre|Follow|… more|Visit my profile)$/i;
      const REPOST_PREFIX_RE = /(reposted this|a republié|a partagé)\\b/i;
      let timestamp = '';
      let authorHeadline = null;
      for (const p of ps) {
        if (!timestamp && TS_RE.test(p)) { timestamp = p.replace(/\\s*[•·].*$/, '').trim(); continue; }
        if (REPOST_PREFIX_RE.test(p)) continue;
        if (CTA_RE.test(p)) continue;
        if (p === authorName) continue;
        if (/^•\\s*\\d+(st|nd|rd|th)/i.test(p)) continue;
        if (/^\\d+(st|nd|rd|th)\\+?$/i.test(p)) continue;
        if (authorIsCompany) continue;  // companies have no headline
        if (postText && p.startsWith(postText.slice(0, 30))) continue;  // post body leak
        if (postText && postText.startsWith(p.slice(0, 30))) continue;
        if (!authorHeadline && p.length > 8 && p.length < 300 && p !== postText) {
          authorHeadline = p;
        }
      }

      // Engagement counts. Prefer button aria-labels (most reliable on post
      // detail pages); fall back to text patterns ("31 reactions",
      // "7 comments • 3 reposts" — common on activity preview cards).
      const ariaInt = (sel) => {
        const el = container.querySelector(sel);
        if (!el) return 0;
        const lbl = el.getAttribute('aria-label') || el.textContent || '';
        const m = lbl.match(/(\\d[\\d,]*)/);
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
      };
      let reactions = ariaInt('button[aria-label*="reaction" i], button[aria-label*="réaction" i]');
      let comments  = ariaInt('button[aria-label*="comment" i], a[aria-label*="comment" i], button[aria-label*="commentaire" i]');
      let reposts   = ariaInt('button[aria-label*="repost" i], a[aria-label*="repost" i], button[aria-label*="republi" i]');
      if (!reactions) {
        const m = containerText.match(/(\\d[\\d,]*)\\s*(?:reaction|réaction)/i);
        if (m) reactions = parseInt(m[1].replace(/,/g, ''), 10);
      }
      if (!comments) {
        const m = containerText.match(/(\\d[\\d,]*)\\s*(?:comment|commentaire)/i);
        if (m) comments = parseInt(m[1].replace(/,/g, ''), 10);
      }
      if (!reposts) {
        const m = containerText.match(/(\\d[\\d,]*)\\s*(?:repost|republi)/i);
        if (m) reposts = parseInt(m[1].replace(/,/g, ''), 10);
      }

      // Media (image preview or video poster).
      const mediaImg = container.querySelector('img[src*="feedshare"], img[src*="video"], img[src*="dms.licdn.com/image-shrink"]');
      const mediaUrl = mediaImg ? mediaImg.getAttribute('src') : null;

      activity.push({
        activityId,
        activityUrl: href ? buildAbsUrl(href) : ('https://www.linkedin.com/feed/update/urn:li:activity:' + activityId + '/'),
        isRepost,
        timestamp,
        author: {
          name: authorName,
          headline: authorHeadline,
          profileUrl: authorProfileUrl,
          avatarUrl: authorAvatarUrl,
          isCompany: authorIsCompany,
        },
        postText,
        reactions, comments, reposts,
        mediaUrl,
      });
    };

    anchors.forEach(collectFor);
    // Some posts (pure media reposts) have no expandable-text-box. Cover them
    // via the activity links, but only if they're not yet collected.
    links.forEach(collectFor);
  }

  // Output shape aligned with ozeo-leadgen /webhook/d1-profile ingest
  // (see docs/SCHEMAS.md → linkedin.profile / get_profile).
  // PK is NOT set here — the worker injects it from inputData before POST.
  return {
    // Identity & canonical references
    linkedinUrl:    location.href,
    profileId:      profileSlug,
    profileUrn,

    // Display
    nom:            name,
    headline,
    localisation:   locationLine,
    connectionsCount,
    profileImgUrl:  $1('main img[src*="profile-displayphoto"]')?.src || null,
    backgroundImage: $1('main img[src*="profile-displaybackgroundimage"]')?.src || null,
    about,

    // Lists matching the ingest schema (jsonb / text[] columns)
    topSkills,                                     // string[]
    skills:         skillsItems.map((s) => s.name), // string[]
    skillsTotal,
    experiences,                                   // [{poste, entreprise, dates, lieu, description, companyUrl, ...}]
    formations,                                    // [{ecole, diplome, annees, activites, schoolUrl}]
    certifications,                                // [{title, issuer, dates}]
    langues,                                       // [{langue, niveau}]
    activity,                                      // [{activityId, activityUrl, timestamp, postText, reactions, comments, ...}]

    // Extras (silently dropped by ingest, kept for orchestrator-side debugging)
    canonical:      $1('link[rel="canonical"]')?.href || null,
    title:          document.title,
    connectionsLine,
    featured:       { found: featured.length > 0, items: featured },
    recommendations,
    publications,
    courses,
    interests:      { category: interests.category, items: interests.items || [] },
    metrics: {
      htmlLength: document.documentElement.outerHTML.length,
      textLength: (document.body.innerText || '').length,
      mainScrollTop: (() => { const m = $1('main'); return m ? m.scrollTop : 0; })(),
      mainScrollHeight: (() => { const m = $1('main'); return m ? m.scrollHeight : 0; })(),
    },
  };
`);
