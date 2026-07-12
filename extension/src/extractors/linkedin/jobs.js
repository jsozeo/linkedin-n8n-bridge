import { evalScript } from './_helpers.js';

export const ID = 'linkedin.jobs';
// ozeo-leadgen dispatch step(s).
export const STEP_KEYS = ['get_jobs'];
// /jobs/                                → home feed (window scroll)
// /jobs/search/?keywords=...            → split pane (left pane scroll)
// /jobs/search-results/?keywords=...    → split pane (used by ozeo-leadgen)
// /jobs/collections/<topic>/            → split pane (left pane scroll)
// /jobs/view/<id>/                      → single job detail (window scroll)
export const URL_PATTERN = /linkedin\.com\/jobs(\/(search|collections|view)(?:-results)?\b|\/?$)/i;

// We wait either for the home feed or for the split-pane results list.
export const WAIT_SELECTORS = [
  'main',
  '[data-testid="JobsHomeFeedModuleListCollection"], a[href*="/jobs/view/"]',
];

// Default (jobs home) → window scroll
export const SCROLL = { strategy: 'window', steps: [20, 40, 60, 80, 100], delayMs: 2000 };

// Pane selector used on /jobs/search and /jobs/collections — these layouts
// host the result list inside a vertically scrollable <div> that wraps a <ul>.
// LinkedIn's class names are hashed but the structural selector below
// (a div that DIRECTLY parents a <ul> containing many /jobs/view/ links) is
// uniquely identifying. We expose it via a small marker injected on the fly.
const PANE_MARKER_JS = `
  (() => {
    // Find the <ul> with the most /jobs/view/ links — that's the results list.
    let bestUl = null, bestCount = 0;
    for (const ul of document.querySelectorAll('main ul')) {
      const n = ul.querySelectorAll('a[href*="/jobs/view/"]').length;
      if (n > bestCount) { bestCount = n; bestUl = ul; }
    }
    if (!bestUl || bestCount < 3) return null;
    // Walk to its nearest scrollable ancestor.
    let node = bestUl;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.clientHeight + 16 < node.scrollHeight) break;
      node = node.parentElement;
    }
    if (!node || node === document.body) node = bestUl.parentElement;
    node.setAttribute('data-bridge-scroll-pane', '1');
    return '[data-bridge-scroll-pane="1"]';
  })()
`;

export function pickScroll(url) {
  if (/\/jobs\/(search|collections)(?:-results)?/i.test(url)) {
    return {
      strategy: 'pane',
      // The runner will pass this through to the scroll command. If the marker
      // isn't yet set, the first scroll will fail soft and we fall back to
      // window; but in practice the WAIT_SELECTORS guarantee the pane exists
      // by then. The extractor sets the marker via PANE_PREP_JS below.
      selector: '[data-bridge-scroll-pane="1"]',
      steps: [20, 40, 60, 80, 100],
      delayMs: 2500,
    };
  }
  return null; // fall back to default SCROLL (window)
}

// Inject the marker before scrolling. We piggyback on WAIT_PREDICATE_JS for
// this — it runs once after WAIT_SELECTORS, just before the scroll phase.
export const WAIT_PREDICATE_JS = `
  (() => {
    const isSplit = /\\/jobs\\/(search|collections)(?:-results)?/.test(location.href);
    if (!isSplit) return true;  // home / detail → no marker needed
    const sel = ${PANE_MARKER_JS};
    return !!sel;
  })()
`;

export const EXTRACT_JS = evalScript(`
  // Helpers to clean common LinkedIn job-card strings.
  const stripDismiss = (s) => (s || '').replace(/^Dismiss\\s+/, '').replace(/\\s+job$/, '').trim();

  // Collect every job card by walking /jobs/view/<id> anchors and grouping
  // them by canonical jobId.
  const allLinks = $$('main a[href*="/jobs/view/"]');
  const byId = new Map();
  for (const a of allLinks) {
    const m = a.href.match(/\\/jobs\\/view\\/(\\d+)/);
    if (!m) continue;
    const id = m[1];
    if (!byId.has(id)) byId.set(id, { id, href: 'https://www.linkedin.com/jobs/view/' + id + '/', links: [] });
    byId.get(id).links.push(a);
  }

  const items = [];
  for (const job of byId.values()) {
    // Walk up from the first link to find the card root: the smallest ancestor
    // that contains a "Dismiss <Title> job" aria-label, OR (fallback) a sibling
    // image (company logo).
    let card = job.links[0];
    for (let i = 0; i < 8 && card.parentElement; i++) {
      card = card.parentElement;
      if ($1('[aria-label^="Dismiss "][aria-label$=" job"]', card)) break;
      if ($1('img', card) && $1('a[href*="/company/"]', card)) break;
    }

    // Title — prefer the Dismiss aria-label (clean, no badges), fallback to link text
    const dismissBtn = $1('[aria-label^="Dismiss "][aria-label$=" job"]', card);
    const titleFromAria = dismissBtn ? stripDismiss(attr(dismissBtn, 'aria-label')) : null;
    const titleFromLink = txt(job.links.find((a) => txt(a)) || null);
    const title = titleFromAria || titleFromLink || null;

    // Company: prefer the link, fallback to a text line that doesn't look
    // like title/location/badge.
    const companyLink = $1('a[href*="/company/"]', card);
    let companyName = companyLink
      ? (txt(companyLink) || attr(companyLink, 'aria-label')?.replace(/^View company:\\s*/, ''))
      : null;
    const companyHref = companyLink ? canonicalLi(companyLink.href) : null;

    // Location, salary, "Easy apply", "Promoted", "Actively hiring" badges live
    // as short text lines in the card body. We split on \\n and classify.
    const lines = (card.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    // LinkedIn duplicates titles (visible + visually-hidden) so we also drop
    // lines that are "title" repeated end-to-end ("Product OwnerProduct Owner").
    const dupTitle = title ? title + title : null;
    const dropExact = new Set([title, companyName, dupTitle,
      'Easy Apply', 'Candidature simplifiée', 'Postuler facilement',
      'Save', 'Saved', 'Apply', 'Postuler', 'People', 'Verified', 'Hybrid', 'Remote', 'Sur site',
      'Promoted', 'Recommandé', 'Actively hiring', 'En cours de recrutement',
    ].filter(Boolean));
    const useful = lines.filter((l) => !dropExact.has(l) && !/^Dismiss /i.test(l));

    // If we don't have a /company/ link, the company name sits as plain text
    // right after the (often duplicated) title line. We bubble the FIRST
    // non-title line that is NOT obviously a location / badge / status.
    if (!companyName) {
      const LOC_HINT = /^[•·]?\\s*$|^\\d|^Posted |^Recommended |^[\\d.,]+\\s*(applicants?|candidat)|^(EMEA|APAC|Worldwide|Europe|United |France|Belgique|Suisse|Germany)|\\(Remote\\)|\\(Hybrid\\)|\\(On-site\\)|\\((Sur site|T[ée]l[ée]travail)\\)|Easy Apply|Candidature simplifi|Sponsored|Promoted|Recommandé|Actively (hiring|reviewing)|En cours de recrutement|Be an early applicant|People you may know|People \\.\\.\\.|Verified/i;
      const TITLE_RE = title ? new RegExp('^' + title.replace(/[\\\\^$.*+?()\\[\\]{}|]/g, '\\\\$&'), 'i') : null;
      const firstUseful = useful.find((l) => {
        if (!l || l.length < 2 || l.length > 120) return false;
        if (TITLE_RE && TITLE_RE.test(l)) return false;
        if (LOC_HINT.test(l)) return false;
        if (/^(Save|Saved|Apply|Postuler|People|Verified)$/i.test(l)) return false;
        // skip plain location lines ("Paris, ...", "Île-de-France, France ...")
        if (/^[A-ZÀ-Ÿ][\\w\\s'’-]+,\\s/.test(l)) return false;
        return true;
      });
      if (firstUseful) companyName = firstUseful;
    }
    const company = companyName ? { name: companyName, href: companyHref } : null;

    // Location pattern: short line with a comma OR country/city tokens. Exclude
    // any line that overlaps with "<City> ago" or button-only labels.
    const locationLine = useful.find((l) => {
      if (!l || l.length > 90) return false;
      if (l === companyName) return false;
      if (/^\\d+\\s/.test(l)) return false;          // "1 hour ago" etc
      if (/applicant|alumni|connection|matches your|skill/i.test(l)) return false;
      return (/, [A-Z]/.test(l)
        || /\\b(France|Belgique|Suisse|United|Germany|Spain|Italy|Switzerland|Belgium|Luxembourg|Netherlands|Portugal|Canada|UK|USA)\\b/.test(l)
        || /^(Paris|Lyon|Marseille|Toulouse|Bordeaux|Lille|Nantes|Strasbourg|Nice|Rennes|Montpellier|Grenoble|Aix-en-Provence|Brussels|London|Madrid|Berlin)/i.test(l)
        || /(Metropolitan Area|Region|R[ée]gion|Area)$/i.test(l));
    }) || null;

    // Compute badges on the ORIGINAL lines — "useful" has them filtered out.
    const easyApply = lines.some((l) => /^(Easy Apply|Candidature simplifiée|Postuler facilement)$/i.test(l));
    const promoted  = lines.some((l) => /^(Promoted|Recommandé)$/i.test(l));
    const actHiring = lines.some((l) => /(Actively hiring|En cours de recrutement)/i.test(l));
    const workMode  = lines.find((l) => /^(Remote|Hybrid|On-site|Sur site|Hybride|Télétravail)$/i.test(l)) || null;

    // Salary range, if shown
    const salary = useful.find((l) =>
      /[€$£]/.test(l) || /\\b(EUR|USD|GBP)\\b/.test(l) || /\\bper (year|hour|month)\\b/i.test(l)
    ) || null;

    // Posted-time hint ("2d", "3 days ago", "Reposted 4d ago")
    const postedAgo = useful.find((l) => /\\b(\\d+\\s?(d|h|w|mo|y)\\b|hours? ago|days? ago|weeks? ago|months? ago|Reposted)/i.test(l)) || null;

    // Logo URL (the company image inside the card, when present)
    const logoImg = $1('img', card);
    const logo = logoImg ? (logoImg.getAttribute('src') || null) : null;

    // Emit one row matching the ozeo-leadgen 'jobs' shape. Field aliases
    // accepted by ingest are listed in docs/SCHEMAS.md → get_jobs.
    items.push({
      jobId:        job.id,
      url:          job.href,
      title,
      company:      company?.name || null,
      companyUrl:   company?.href || null,
      location:     locationLine,
      posted:       postedAgo,
      logo,
      salary,
      workMode,
      easyApply,
      promoted,
      activelyHiring: actHiring,
    });
  }

  // Search context (only on /jobs/search) → keywords, location, total count
  const searchKeywords = $1('input[name="keywords"]')?.value ||
                         new URLSearchParams(location.search).get('keywords') || null;
  const searchLocation = $1('input[name="location"]')?.value ||
                         new URLSearchParams(location.search).get('location') || null;
  const resultsHeader = txtOf('main h1') || txtOf('main h2');

  return {
    // Wrap so the worker can POST directly without restructuring.
    jobsCount:    items.length,
    payload:      items,

    // Diagnostics
    url:          location.href,
    title:        document.title,
    variant:      /\\/jobs\\/(search|collections)(?:-results)?/i.test(location.href) ? 'search' :
                  /\\/jobs\\/view\\//i.test(location.href) ? 'detail' : 'home',
    search:       { keywords: searchKeywords, location: searchLocation },
    resultsHeader,
  };
`);
