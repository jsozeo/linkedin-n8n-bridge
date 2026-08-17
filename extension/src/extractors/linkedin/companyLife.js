// LinkedIn company LIFE extractor — /company/<slug>/life/.
// The Life tab shows culture content: leaders, employee testimonials, photo
// gallery, and free-text culture sections. First pass; refine from DOM.

import { evalScript } from './_helpers.js';

export const ID = 'linkedin.companyLife';
export const STEP_KEYS = ['get_company_life'];
export const URL_PATTERN = /linkedin\.com\/company\/[^/?#]+\/life\/?/i;

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/company\/([^/]+)(?:\/(?:about|people|posts|jobs|overview)\/?)?\/?$/i);
    if (m) { u.pathname = `/company/${m[1]}/life/`; return u.toString(); }
    return url;
  } catch { return url; }
}

export const WAIT_SELECTORS = ['main', 'main h1, main h2'];
export const SCROLL = { strategy: 'pane', selector: 'main', steps: [25, 50, 75, 100], delayMs: 1500 };

export const EXTRACT_JS = evalScript(`
  const clean = (s) => (s == null ? null : String(s).replace(/\\s+/g, ' ').trim() || null);
  const main = $1('main') || document.body;

  // Leaders / featured people: /in/ cards with a name + title line.
  const seen = new Set();
  const leaders = [];
  for (const a of $$('main a[href*="/in/"]')) {
    const href = canonicalLi(a.href);
    if (!href || seen.has(href)) continue;
    let card = a;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      card = card.parentElement;
      if ((card.innerText || '').split(/\\r?\\n/).filter((s) => s.trim()).length >= 2) break;
    }
    const lines = (card.innerText || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
    const img = $1('img', card);
    const name = clean(a.innerText) || lines[0] || (img ? (img.getAttribute('alt') || '').replace(/^View\\s+/i, '').replace(/['\\u2019]s.*/,'').trim() : null);
    const title = lines.find((l) => l !== name && l.length > 3) || null;
    if (!name) continue;
    seen.add(href);
    leaders.push({ name, title, profileUrl: href, avatarUrl: img ? img.getAttribute('src') : null });
  }

  // Testimonials: block quotes / long paragraphs attributed to a person.
  const testimonials = $$('main blockquote, main p')
    .map((e) => clean(e.innerText))
    .filter((t) => t && t.length > 60)
    .slice(0, 20);

  // Gallery: non-logo images under main.
  const photos = $$('main img')
    .map((i) => i.getAttribute('src') || '')
    .filter((s) => s && !s.startsWith('data:') && !/profile-displayphoto|company-logo/.test(s))
    .slice(0, 30);

  const headings = $$('main h2, main h3').map((h) => clean(h.innerText)).filter(Boolean);

  return {
    url: location.href,
    title: document.title,
    leaders,
    testimonials,
    photos,
    headings,
    count: leaders.length,
    _probe: { inAnchors: $$('main a[href*="/in/"]').length, mainScrollHeight: main.scrollHeight, mainClientHeight: main.clientHeight },
  };
`);
