// LinkedIn company-search extractor.
//
// Handles the global company search results page:
//   /search/results/companies/?keywords=…&origin=…
//
// Same shape as people search: ~10 results/page, paginated with a "Next" button.
// A company card is the smallest ancestor of a /company/<slug> link that also
// holds a Follow / Following action button and enough visible text.

import { evalAsyncScript } from './_helpers.js';

export const ID = 'linkedin.searchCompanies';
export const STEP_KEYS = ['search_companies'];
export const URL_PATTERN = /linkedin\.com\/search\/results\/companies/i;

export const WAIT_SELECTORS = ['main', 'a[href*="/company/"]'];

export const SCROLL = { strategy: 'window', steps: [60, 100], delayMs: 1200 };

export const AWAIT_PROMISE = true;

export const EXTRACT_JS = evalAsyncScript(`
  const ACTION_BTN_RE = /^(Follow|Following|Unfollow|Suivre|Suivi|Ne plus suivre|Visit website|Visiter le site)$/i;
  const ACTION_TEXTS = new Set(['Follow','Following','Unfollow','Suivre','Suivi','Ne plus suivre','Visit website','Visiter le site','+ Follow','Message']);

  const hasActionBtn = (el) => {
    if (!el || !el.querySelectorAll) return false;
    for (const b of el.querySelectorAll('button')) {
      if (ACTION_BTN_RE.test((b.textContent || '').trim())) return true;
    }
    return false;
  };
  const companiesInside = (el) => {
    const set = new Set();
    el.querySelectorAll('a[href*="/company/"]').forEach((l) => {
      const m = (l.getAttribute('href') || '').match(/\\/company\\/([^/?#]+)/);
      if (m) set.add(m[1]);
    });
    return set;
  };
  const isCardLike = (el) => {
    if (companiesInside(el).size !== 1) return false;
    if (!hasActionBtn(el)) return false;
    return ((el.innerText || el.textContent || '').trim().length >= 25);
  };

  const parseCount = (s) => {
    if (!s) return null;
    const m = String(s).replace(/\\u00a0/g, ' ').match(/([\\d.,]+)\\s*(K|M|k|m)?/);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/[.,](?=\\d{3}\\b)/g, '').replace(',', '.'));
    if (Number.isNaN(n)) return null;
    if (/k/i.test(m[2] || '')) n *= 1e3;
    if (/m/i.test(m[2] || '')) n *= 1e6;
    return Math.round(n);
  };

  const results = new Map();

  const extractPage = () => {
    const cards = [];
    const seenCards = new Set();
    for (const a of $$('main a[href*="/company/"]')) {
      let node = a, found = null;
      for (let i = 0; i < 14; i++) {
        const p = node.parentElement;
        if (!p) break;
        node = p;
        if (companiesInside(node).size > 1) break;
        if (isCardLike(node)) { found = node; break; }
      }
      if (found && !seenCards.has(found)) { seenCards.add(found); cards.push(found); }
    }

    for (const card of cards) {
      const linkEl = card.querySelector('a[href*="/company/"]');
      if (!linkEl) continue;
      const rawHref = linkEl.getAttribute('href') || '';
      const companyUrl = canonicalLi(rawHref.split('?')[0]);
      if (!companyUrl || results.has(companyUrl)) continue;
      const slugMatch = companyUrl.match(/\\/company\\/([^/?#]+)/);
      const slug = slugMatch ? slugMatch[1] : null;

      const logoImgs = $$('img', card);
      const realLogo = logoImgs.find((img) => { const s = img.getAttribute('src') || ''; return s && !s.startsWith('data:'); });
      const logoUrl = (realLogo || logoImgs[0]) ? (realLogo || logoImgs[0]).getAttribute('src') : null;

      // The /company/ anchor wraps the WHOLE card, so link text is useless.
      // Parse from visible lines instead. Layout:
      //   <name> / <industry> / <location?> / Follow / <description> /
      //   <X followers> / <… follow this page> / <N jobs>
      const lines = (card.innerText || card.textContent || '')
        .split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);

      const isAction = (t) => /^(Follow|Following|Unfollow|Suivre|Suivi|Ne plus suivre|Message|Visit website|Visiter le site|\\+ Follow)$/i.test(t);
      const followerRe = /([\\d.,]+\\s*[KM]?)\\s*(followers?|abonn[ée]s?)/i;
      const jobsRe = /^(\\d[\\d.,]*)\\s+(jobs?|emplois?|offres?)/i;
      const followPageRe = /follows? this page|suit cette page|abonn[ée]s? à cette page/i;

      let name = lines[0] || null;
      if (name) { const half = name.slice(0, Math.floor(name.length / 2)); if (name.length > 2 && name === half + half) name = half; }

      // Meta = the lines between the name and the first action button.
      const actionIdx = lines.findIndex(isAction);
      const meta = (actionIdx > 1 ? lines.slice(1, actionIdx) : lines.slice(1, 3))
        .filter((t) => !followerRe.test(t) && !jobsRe.test(t) && !followPageRe.test(t));
      let industry = null, location = null;
      if (meta.length) {
        // "Industry • City" inline, or [industry, location] on separate lines.
        if (/[•·]/.test(meta[0])) {
          const parts = meta[0].split(/\\s*[•·]\\s*/).map((s) => s.trim()).filter(Boolean);
          industry = parts[0] || null;
          location = parts.slice(1).join(', ') || meta[1] || null;
        } else {
          industry = meta[0] || null;
          location = meta[1] || null;
        }
      }

      const followersLine = lines.find((t) => followerRe.test(t)) || null;
      const followers = followersLine ? parseCount((followersLine.match(followerRe) || [])[1]) : null;

      const jobsLine = lines.find((t) => jobsRe.test(t)) || null;
      const jobs = jobsLine ? parseInt((jobsLine.match(jobsRe) || [])[1].replace(/[^\\d]/g, ''), 10) : null;

      // Description: longest line after the action button that isn't
      // followers / jobs / "… follow this page".
      const afterAction = actionIdx >= 0 ? lines.slice(actionIdx + 1) : lines.slice(1);
      const description = afterAction
        .filter((t) => t !== name && !followerRe.test(t) && !jobsRe.test(t) && !followPageRe.test(t) && !isAction(t) && t.length > 20)
        .sort((a, b) => b.length - a.length)[0] || null;

      results.set(companyUrl, {
        name,
        company_url: companyUrl,
        slug,
        industry,
        location,
        followersLine,
        followers,
        jobs,
        description,
        logo_url: logoUrl,
      });
    }
  };

  const DEADLINE = Date.now() + 18000;
  const findNext = () => Array.from(document.querySelectorAll('button'))
    .find((b) => !b.disabled &&
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
  const companies = [...results.values()];

  const _probe = {
    companyLinks: $$('main a[href*="/company/"]').length,
    pagesVisited: pages,
  };

  return {
    query,
    resultsHeader,
    companies,
    count: companies.length,
    url: location.href,
    title: document.title,
    _probe,
  };
`);
