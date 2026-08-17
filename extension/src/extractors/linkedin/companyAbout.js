// LinkedIn company ABOUT extractor — /company/<slug>/about/.
// The About tab renders the full Overview definition list (website, industry,
// company size, HQ, founded, specialties) plus the full about paragraph.

import { evalScript } from './_helpers.js';
import { COMPANY_INFO_BODY } from './_companyInfo.js';

export const ID = 'linkedin.companyAbout';
export const STEP_KEYS = ['get_company_about'];
export const URL_PATTERN = /linkedin\.com\/company\/[^/?#]+\/about\/?/i;

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/company\/([^/]+)(?:\/(?:people|posts|jobs|life|overview)\/?)?\/?$/i);
    if (m) { u.pathname = `/company/${m[1]}/about/`; return u.toString(); }
    return url;
  } catch { return url; }
}

export const WAIT_SELECTORS = ['main', 'main h1, main h2'];
export const SCROLL = { strategy: 'pane', selector: 'main', steps: [40, 80, 100], delayMs: 1200 };

export const EXTRACT_JS = evalScript(COMPANY_INFO_BODY);
