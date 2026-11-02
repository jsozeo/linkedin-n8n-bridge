// One-shot migration: everything the extension knows about LinkedIn moves to
// the cloud registry, so the bundle stops carrying business logic and the
// remote machine stops needing a reload.
//
//   node test-server/migrate-to-registry.mjs            # show what would go
//   node test-server/migrate-to-registry.mjs --publish  # actually publish
//
// The extractor sources are published VERBATIM. The point of this migration is
// that behaviour does not change, so anything that would rewrite the JS is out
// of scope — only the surrounding metadata is translated, and only where it was
// a function that cannot be stored as data.

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ENDPOINT = process.env.BRIDGE_ENDPOINT || 'https://l75fzlo5pc.execute-api.eu-west-3.amazonaws.com';
const TOKEN = process.env.BRIDGE_TOKEN || 'smbridge_test_7Kd93PqL2xTn';
const PUBLISH = process.argv.includes('--publish');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(HERE, '../extension/src/extractors/linkedin');
const SELECTORS_MODULE = path.resolve(HERE, '../extension/src/selectors.js');

// camelCase skill ids become snake_case page types: companyPosts -> company_posts.
const pageTypeOf = (id) => id.split('.').slice(1).join('.').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * normalizeUrl() is seven variations of "rewrite the path, maybe add a query
 * param". Rather than guess, each function is probed with URLs it is meant to
 * handle and the result is compared against the declarative form, so a
 * mistranslation shows up here instead of in production.
 */
const NORMALIZE_RULES = {
  'linkedin.company': {
    match: '^/company/([^/]+)(?:/(?:about|people|posts|jobs|life|overview)/?)?/?$',
    pathname: '/company/$1/',
  },
  'linkedin.companyAbout': {
    match: '^/company/([^/]+)(?:/(?:people|posts|jobs|life|overview)/?)?/?$',
    pathname: '/company/$1/about/',
  },
  'linkedin.companyJobs': {
    match: '^/company/([^/]+)(?:/(?:about|people|posts|life|overview)/?)?/?$',
    pathname: '/company/$1/jobs/',
  },
  'linkedin.companyLife': {
    match: '^/company/([^/]+)(?:/(?:about|people|posts|jobs|overview)/?)?/?$',
    pathname: '/company/$1/life/',
  },
  'linkedin.companyPosts': {
    match: '^/company/([^/]+)(?:/(?:about|people|jobs|life|overview)/?)?/?$',
    pathname: '/company/$1/posts/',
    search_params: { feedView: 'all' },
  },
  'linkedin.peopleCompany': {
    match: '^/company/([^/]+)/?$',
    pathname: '/company/$1/people/',
  },
  'linkedin.messaging': {
    replace_with: 'https://www.linkedin.com/messaging/',
  },
};

const SCROLL_RULES = {
  'linkedin.jobs': [{
    when_url_matches: '/jobs/(search|collections)(?:-results)?',
    scroll: {
      strategy: 'pane',
      selector: '[data-bridge-scroll-pane="1"]',
      steps: [20, 40, 60, 80, 100],
      delayMs: 2500,
    },
  }],
};

const PROBE_URLS = [
  'https://www.linkedin.com/company/ozeo/',
  'https://www.linkedin.com/company/ozeo/about/',
  'https://www.linkedin.com/company/ozeo/people/',
  'https://www.linkedin.com/company/ozeo/posts/',
  'https://www.linkedin.com/company/ozeo/jobs/',
  'https://www.linkedin.com/company/ozeo/life/',
  'https://www.linkedin.com/in/someone/',
  'https://www.linkedin.com/messaging/thread/123/',
  'https://www.linkedin.com/jobs/search/?keywords=webflow',
  'https://www.linkedin.com/jobs/view/4123456789/',
];

/** The declarative form, applied the way the extension will apply it. */
export function applyNormalize(rule, url) {
  if (!rule) return url;
  if (rule.replace_with) return rule.replace_with;
  try {
    const u = new URL(url);
    const m = u.pathname.match(new RegExp(rule.match, 'i'));
    if (!m) return url;
    u.pathname = rule.pathname.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '');
    for (const [k, v] of Object.entries(rule.search_params || {})) {
      if (!u.searchParams.get(k)) u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function applyScrollRules(rules, url, fallback) {
  for (const r of rules || []) {
    try { if (new RegExp(r.when_url_matches, 'i').test(url)) return r.scroll; } catch { /* keep looking */ }
  }
  return fallback;
}

async function loadSkills() {
  const index = await import(pathToFileURL(path.join(SKILLS_DIR, 'index.js')).href);
  return index.SKILLS;
}

/**
 * Write selectors go to the page type they act on. A post permalink resolves
 * to the `comments` skill — that is the existing taxonomy, kept as is so the
 * migration changes nothing about which page is which.
 */
function writeActionsFor(pageType, bundled) {
  if (pageType === 'comments') {
    const { profile, ...rest } = bundled;
    return rest;
  }
  if (pageType === 'profile') return { profile: bundled.profile };
  return {};
}

function toEntry(skill, bundledSelectors, priority) {
  const normalize = NORMALIZE_RULES[skill.ID] || null;
  const scrollRules = SCROLL_RULES[skill.ID] || null;
  const pageType = pageTypeOf(skill.ID);

  return {
    page_type: pageType,
    // Several URL patterns overlap — /company/x/ matches both `company` and
    // `people_company`, /feed/ matches both `posts` and `messaging` — and the
    // bundle resolved the tie by declaration order. Carrying that order across
    // is what keeps the same page landing on the same extractor.
    priority,
    // Locale-independent on purpose: these extractors match headings by
    // accent-stripped text and behave the same in every interface language.
    ui_locale: 'any',
    url_patterns: [],
    fields: [],
    actions: writeActionsFor(pageType, bundledSelectors),
    extractor: {
      skill_id: skill.ID,
      url_regex: skill.URL_PATTERN.source,
      wait_selectors: skill.WAIT_SELECTORS || [],
      wait_predicate_js: skill.WAIT_PREDICATE_JS || null,
      scroll: skill.SCROLL || null,
      scroll_rules: scrollRules,
      await_promise: Boolean(skill.AWAIT_PROMISE),
      items_key: skill.ITEMS_KEY || null,
      step_keys: skill.STEP_KEYS || [],
      normalize_url: normalize,
      extract_js: skill.EXTRACT_JS,
    },
    note: 'migrated verbatim from the extension bundle',
  };
}

/** Every translated function is replayed against the original before publishing. */
function checkTranslation(skill, entry) {
  const problems = [];

  for (const url of PROBE_URLS) {
    const want = typeof skill.normalizeUrl === 'function' ? skill.normalizeUrl(url) : url;
    const got = applyNormalize(entry.extractor.normalize_url, url);
    if (want !== got) problems.push(`normalizeUrl(${url})\n      bundle: ${want}\n      cloud : ${got}`);

    const wantScroll = typeof skill.pickScroll === 'function' ? skill.pickScroll(url) || skill.SCROLL : skill.SCROLL;
    const gotScroll = applyScrollRules(entry.extractor.scroll_rules, url, entry.extractor.scroll);
    if (JSON.stringify(wantScroll) !== JSON.stringify(gotScroll)) {
      problems.push(`pickScroll(${url}) differs`);
    }

    const wantMatch = skill.URL_PATTERN.test(url);
    const gotMatch = new RegExp(entry.extractor.url_regex, 'i').test(url);
    if (wantMatch !== gotMatch) problems.push(`URL_PATTERN(${url}): bundle ${wantMatch}, cloud ${gotMatch}`);
  }

  if (entry.extractor.extract_js !== skill.EXTRACT_JS) problems.push('extract_js was altered');
  return problems;
}

async function publish(entry) {
  const res = await fetch(`${ENDPOINT}/registry/entry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(entry),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const skills = await loadSkills();
  const { DEFAULTS } = await import(pathToFileURL(SELECTORS_MODULE).href);
  const bundledSelectors = DEFAULTS.linkedin;
  console.log(`${skills.length} extracteurs embarques + les selecteurs d'ecriture\n`);

  const entries = [];
  let problems = 0;

  for (const [priority, skill] of skills.entries()) {
    const entry = toEntry(skill, bundledSelectors, priority);
    const issues = checkTranslation(skill, entry);
    problems += issues.length;
    const flag = issues.length ? 'ECHEC' : ' ok  ';
    console.log(
      `  ${flag}  ${entry.page_type.padEnd(18)}`
      + `${String(entry.extractor.extract_js.length).padStart(6)} o`
      + `  ${entry.extractor.normalize_url ? 'normalize' : '         '}`
      + `  ${Object.keys(entry.actions).length ? Object.keys(entry.actions).length + ' groupes d ecriture' : ''}`
      + `  ${entry.extractor.scroll_rules ? 'scroll-rules' : ''}`,
    );
    for (const p of issues) console.log(`         ${p}`);
    entries.push(entry);
  }

  const total = entries.reduce((n, e) => n + e.extractor.extract_js.length, 0);
  console.log(`\n${total.toLocaleString('fr-FR')} octets de logique metier a sortir du bundle`);

  if (problems) {
    console.log(`\n${problems} probleme(s) de traduction — rien n'est publie.`);
    process.exitCode = 1;
    return;
  }
  if (!PUBLISH) {
    console.log('\nTraduction fidele. Relancer avec --publish pour envoyer.');
    return;
  }

  console.log('\nPublication :');
  for (const entry of entries) {
    const out = await publish(entry);
    console.log(`  ${entry.page_type.padEnd(18)} version ${out.version}`);
  }
  console.log(`\n${entries.length} entrees publiees.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
