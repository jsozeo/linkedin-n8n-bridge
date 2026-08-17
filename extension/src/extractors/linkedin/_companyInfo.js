// Shared "company info" extractor body used by both the Overview (bare
// /company/<slug>/) and the About (/company/<slug>/about/) skills. Both pages
// render the same Overview definition list + about paragraph; only the tab
// (and therefore how much is present) differs. Kept as a plain body string so
// each skill wraps it with evalScript() (which injects HELPERS).

export const COMPANY_INFO_BODY = `
  const clean = (s) => (s == null ? null : String(s).replace(/\\s+/g, ' ').trim() || null);
  const main = $1('main') || document.body;

  const companyId = (document.body.innerHTML.match(/urn:li:(?:organization|company):(\\d+)/) || [])[1] || null;
  const slug = (location.pathname.match(/\\/company\\/([^/?#]+)/) || [])[1] || null;

  const nameEl = $1('main h1') || $1('main h2');
  const nom = clean(nameEl && nameEl.innerText);
  const logoImg = $1('main img[alt*=" logo" i]') || (nom ? $1('main img[alt*="' + nom.split(' ')[0] + '"]') : null) || $1('main img');
  const logoUrl = logoImg ? (logoImg.getAttribute('src') || null) : null;

  // Parse counts like "1,393,044", "1M", "10K+", "1 393 044".
  const parseCount = (s) => {
    if (s == null) return null;
    const m = String(s).match(/([\\d.,\\s\\u00a0]+)\\s*([KMB])?/i);
    if (!m) return null;
    const suf = (m[2] || '').toUpperCase();
    let n;
    if (suf) { n = parseFloat(m[1].replace(',', '.')); }
    else { n = parseInt(m[1].replace(/[^\\d]/g, ''), 10); }
    if (isNaN(n)) return null;
    if (suf === 'K') n *= 1e3; else if (suf === 'M') n *= 1e6; else if (suf === 'B') n *= 1e9;
    return Math.round(n);
  };

  // 2026 header card: below the <h1> the tagline/industry, headquarters,
  // "<N> followers" and "<N> employees" are stacked as unlabeled leaf lines.
  // Read them positionally from the smallest ancestor of <h1> that contains
  // "followers" (the header card), skipping metric/relationship lines.
  let hIndustry = null, hHq = null, hFollowers = null, hEmployees = null;
  {
    let card = nameEl;
    while (card && card.parentElement && card !== main && !/follower|abonn/i.test(card.innerText || '')) card = card.parentElement;
    const extras = [];
    if (card && card !== document.body) card.querySelectorAll('*').forEach((el) => {
      if (el.children.length) return;
      const t = clean(el.innerText);
      if (!t || t.length < 3) return;
      if (nom && t === nom) return;
      if (/follower|abonn/i.test(t)) { if (hFollowers == null) hFollowers = parseCount(t); return; }
      if (/employee|salari|members|associ/i.test(t)) { if (hEmployees == null) hEmployees = parseCount(t); return; }
      if (/follow this page|connection|relation|other/i.test(t)) return;
      extras.push(t);
    });
    hIndustry = extras[0] || null;
    hHq = extras[1] || null;
  }

  const LABELS = {
    website:      /^(Website|Site web)$/i,
    phone:        /^(Phone|T[ée]l[ée]phone)$/i,
    industry:     /^(Industry|Secteur)$/i,
    companySize:  /^(Company size|Taille de l.?entreprise|Effectif)$/i,
    headquarters: /^(Headquarters|Si[èe]ge social|Si[èe]ge)$/i,
    founded:      /^(Founded|Cr[ée][ée]e? en|Ann[ée]e de cr[ée]ation)$/i,
    specialties:  /^(Specialties|Sp[ée]cialit[ée]s)$/i,
    type:         /^(Type)$/i,
  };
  const out = { website:null, phone:null, industry:null, companySize:null, headquarters:null, founded:null, specialties:null, type:null };

  const dts = $$('main dt');
  if (dts.length) {
    for (const dt of dts) {
      const label = clean(dt.innerText) || '';
      const dd = dt.nextElementSibling && dt.nextElementSibling.tagName === 'DD' ? dt.nextElementSibling : null;
      const val = dd ? clean(dd.innerText) : null;
      for (const k in LABELS) if (LABELS[k].test(label)) out[k] = val;
    }
  }
  if (Object.values(out).every((v) => v == null)) {
    const lines = [];
    main.querySelectorAll('h3, dt, dd, p, span, a').forEach((el) => {
      if (el.querySelector('h3, dt, dd, p, span, a')) return;
      const t = clean(el.innerText);
      if (t) lines.push({ t, el });
    });
    for (let i = 0; i < lines.length; i++) {
      for (const k in LABELS) {
        if (out[k] == null && LABELS[k].test(lines[i].t)) {
          const next = lines[i + 1];
          if (next) out[k] = (k === 'website' && lines[i].el.querySelector && lines[i].el.querySelector('a')) ? lines[i].el.querySelector('a').href : next.t;
        }
      }
    }
  }
  const extLink = $$('main a[href^="http"]').map((a) => a.href)
    .find((h) => !/linkedin\\.com/.test(h) && !/lnkd\\.in/.test(h)) || null;
  if (!out.website && extLink) out.website = extLink;

  // Merge the header-card positional values (fill gaps only).
  if (!out.industry) out.industry = hIndustry;
  if (!out.headquarters) out.headquarters = hHq;

  let about = null;
  const aboutBox = $1('main span[data-testid="expandable-text-box"]');
  if (aboutBox) about = clean(aboutBox.innerText);
  if (!about) {
    const p = $$('main p').map((e) => clean(e.innerText)).find((t) => t && t.length > 80);
    about = p || null;
  }
  // Reject Premium/upsell boxes that hijack the about paragraph.
  if (about && /free trial|premium|reactivate|try again|cancel anytime|remind you/i.test(about)) about = null;

  const bodyTxt = (main.innerText || '');
  const followersM = bodyTxt.match(/([\\d.,\\s\\u00a0]+)\\s*(followers|abonn[ée]s)/i);
  const followers = hFollowers != null ? hFollowers
    : (followersM ? parseInt(followersM[1].replace(/[^\\d]/g, ''), 10) || null : null);
  const employeesM = bodyTxt.match(/([\\d.,\\s\\u00a0]+)\\s*(employees|associated members|salari[ée]s|employ[ée]s)/i);
  const employeesOnLinkedIn = hEmployees != null ? hEmployees
    : (employeesM ? parseInt(employeesM[1].replace(/[^\\d]/g, ''), 10) || null : null);

  return {
    linkedinUrl:  companyId ? 'https://www.linkedin.com/company/' + companyId + '/' : location.href,
    slug,
    companyId,
    nom,
    logoUrl,
    about,
    website:      out.website,
    phone:        out.phone,
    industry:     out.industry,
    companySize:  out.companySize,
    headquarters: out.headquarters,
    founded:      out.founded,
    specialties:  out.specialties,
    type:         out.type,
    followers,
    employeesOnLinkedIn,
    url:   location.href,
    title: document.title,
    _probe: { hasDl: dts.length, mainScrollHeight: main.scrollHeight, mainClientHeight: main.clientHeight },
  };
`;
