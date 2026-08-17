// LinkedIn company OVERVIEW extractor — the bare /company/<slug>/ landing tab.
// Extracts the company's own identity + the Overview info it surfaces on the
// home tab. Full details live on /about/ (see companyAbout.js).

import { evalScript } from './_helpers.js';
import { COMPANY_INFO_BODY } from './_companyInfo.js';

export const ID = 'linkedin.company';
export const STEP_KEYS = ['get_company_overview'];
export const URL_PATTERN = /linkedin\.com\/company\/[^/?#]+\/?$/i;

// Keep the bare overview tab; strip any known sub-tab back to /company/<slug>/.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/company\/([^/]+)(?:\/(?:about|people|posts|jobs|life|overview)\/?)?\/?$/i);
    if (m) { u.pathname = `/company/${m[1]}/`; return u.toString(); }
    return url;
  } catch { return url; }
}

export const WAIT_SELECTORS = ['main', 'main h1, main h2'];
export const SCROLL = { strategy: 'pane', selector: 'main', steps: [40, 80, 100], delayMs: 1200 };

export const EXTRACT_JS = evalScript(COMPANY_INFO_BODY);
