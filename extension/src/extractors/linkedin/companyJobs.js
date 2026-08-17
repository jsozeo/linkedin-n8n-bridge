// LinkedIn company JOBS extractor — /company/<slug>/jobs/.
// Lists the jobs a company has posted (title, location, workplace type, posted
// date, canonical job URL + id). First pass; refine from captured DOM.

import { evalScript } from './_helpers.js';

export const ID = 'linkedin.companyJobs';
export const STEP_KEYS = ['get_company_jobs'];
export const URL_PATTERN = /linkedin\.com\/company\/[^/?#]+\/jobs\/?/i;

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/company\/([^/]+)(?:\/(?:about|people|posts|life|overview)\/?)?\/?$/i);
    if (m) { u.pathname = `/company/${m[1]}/jobs/`; return u.toString(); }
    return url;
  } catch { return url; }
}

export const WAIT_SELECTORS = ['main', 'main .job-card-square__title, main a[href*="/jobs/view/"], main h1'];
export const SCROLL = { strategy: 'pane', selector: 'main', steps: [30, 60, 100], delayMs: 1500 };

export const EXTRACT_JS = evalScript(`
  const clean = (s) => (s == null ? null : String(s).replace(/\\s+/g, ' ').trim() || null);
  const main = $1('main') || document.body;

  // Screen-reader-only field labels that LinkedIn injects before each value.
  const JUNK = /^(Job Title|Company Name|Job Location|Location|Intitul|Nom de l|Lieu|Entreprise)/i;

  const jobIdFrom = (a) => {
    const href = a.getAttribute('href') || '';
    let m = href.match(/\\/jobs\\/view\\/(\\d+)/) || href.match(/currentJobId=(\\d+)/);
    return m ? m[1] : null;
  };

  const seen = new Set();
  const jobs = [];

  // 2026: company jobs render as job-card-square cards (Ember); the title sits
  // in .job-card-square__title. Older/other pages still use /jobs/view/ links.
  let cards = $$('main .job-card-square, main .job-card-square__link');
  if (!cards.length) cards = $$('main a[href*="/jobs/view/"]');

  for (const el of cards) {
    const anchor = el.matches('a') ? el : (el.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="], a') || el);
    const jobId = jobIdFrom(anchor);
    const key = jobId || clean(el.innerText) || Math.random().toString();
    if (seen.has(key)) continue;
    seen.add(key);

    const raw = (el.innerText || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
    // Drop sr-only labels ("Job Title", "Company Name", …) + consecutive dups.
    const lines = [];
    for (const l of raw) { if (JUNK.test(l)) continue; if (lines[lines.length - 1] === l) continue; lines.push(l); }

    // Positional after cleanup: [title, company, location, (workplace/posted)].
    const title = lines[0] || null;
    const rest = lines.slice(1);
    const workplaceType = rest.find((l) => /^(Remote|Hybrid|On-?site|T[ée]l[ée]travail|Sur site|Hybride)$/i.test(l)) || null;
    const posted = rest.find((l) => /(ago|il y a|day|week|month|hour|jour|semaine|mois|heure|Reposted|Republi)/i.test(l)) || null;
    const meta = rest.filter((l) => l !== workplaceType && l !== posted);
    const company = meta[0] || null;
    const location = meta[1] || null;

    const jobUrl = jobId ? 'https://www.linkedin.com/jobs/view/' + jobId + '/' : null;
    jobs.push({ jobId, jobUrl, title, company, location, workplaceType, posted });
  }

  return {
    url: location.href,
    title: document.title,
    count: jobs.length,
    jobs,
    _probe: {
      squareCards: $$('main .job-card-square, main .job-card-square__link').length,
      viewAnchors: $$('main a[href*="/jobs/view/"]').length,
      mainScrollHeight: main.scrollHeight, mainClientHeight: main.clientHeight,
    },
  };
`);
