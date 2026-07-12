// Snippet de helpers JS injectés dans la page via `evaluate_js`.
// Tous nos extracteurs commencent par "(() => { ${HELPERS}; …; })()".
// Les helpers SUPPOSENT que `document` et `location` existent — on est dans la page.
//
// Note : LinkedIn 2026 hash maintenant ses classes CSS (_8ec6348b, etc.).
// On évite donc TOUT sélecteur par classe utilitaire. On s'appuie sur :
//   - role / aria-label / aria-labelledby     (sémantique, très stable)
//   - id ('about', 'experience', 'workspace') (anchors LinkedIn, stables)
//   - tag + texte d'un <h2>                   (section titles : "About", "Experience"...)
//   - patterns d'href (/in/, /company/, /jobs/view/, urn:li:activity:…)
//   - data-testid / data-test-*                (rare mais quand présent, golden)
export const HELPERS = `
  const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const $1  = (sel, root = document) => root.querySelector(sel);
  const txt = (el) => el ? (el.innerText || el.textContent || '').trim() : null;
  const txtOf = (sel, root = document) => txt($1(sel, root));
  const attr = (el, name) => el ? el.getAttribute(name) : null;

  // Find an <h2> whose visible text starts with one of the candidates
  // (case-insensitive, accent-stripped). Returns the heading element or null.
  const norm = (s) => (s || '').normalize('NFD').replace(/\\p{Diacritic}/gu, '').trim().toLowerCase();
  const findHeading = (candidates) => {
    const wanted = candidates.map(norm);
    for (const h of $$('main h2, main h3, h2, h3')) {
      const t = norm(txt(h));
      if (wanted.some((w) => t === w || t.startsWith(w + ' ') || t.startsWith(w + '\\u00a0'))) return h;
    }
    return null;
  };

  // Walk forward from a heading and collect everything until the next heading
  // at the same or higher level. Useful to scope a "section" without relying on
  // hashed wrapper class names.
  const sectionAfter = (heading) => {
    if (!heading) return null;
    const stopLevel = parseInt(heading.tagName.slice(1), 10);
    // The heading typically sits inside a section/div wrapper. We walk its
    // ancestor that LinkedIn uses as the section container: closest <section>,
    // or the nearest sibling block. We default to the heading's grand-parent
    // since LinkedIn renders sections as <h2><div>…content…</div></h2>'s sibling.
    let container = heading.closest('section') || heading.parentElement;
    // safety: never return the whole <main>
    if (container && container.id === 'workspace') container = heading.parentElement;
    return container;
  };

  // Resolve the canonical LinkedIn profile/company URL from a link, stripping
  // tracking params (?miniProfileUrn=…&trackingId=…).
  const canonicalLi = (href) => {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      if (!/linkedin\\.com$/i.test(u.hostname)) return href;
      return u.origin + u.pathname.replace(/\\/$/, '');
    } catch { return href; }
  };
`;

// Wrap an extractor body so it can use HELPERS and return a JSON-serializable value.
export function evalScript(body) {
  return `(() => { ${HELPERS}\n${body} })()`;
}

// Async variant for extractors that need to await in-page actions (clicking
// "Show more" buttons, waiting for lazy-load XHRs, etc.). The body MUST be an
// async function body that returns a value; we invoke an IIFE that returns a
// Promise, then the runner picks it up with `awaitPromise: true`.
export function evalAsyncScript(body) {
  return `(async () => { ${HELPERS}\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n${body} })()`;
}
