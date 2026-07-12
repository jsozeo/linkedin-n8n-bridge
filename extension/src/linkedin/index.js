// LinkedIn extractor registry.
//
// Each extractor module knows how to pull structured JSON from one LinkedIn
// page type. They are decoupled from the generic runner
// (src/commands/linkedin.js) which only performs browser primitives:
// open tab → wait → scroll → evaluate → close.
//
// An extractor exports:
//   - ID              : 'linkedin.profile', 'linkedin.peopleCompany', …
//   - URL_PATTERN     : RegExp matching the pages it handles
//   - WAIT_SELECTORS  : CSS selectors to await before extracting (optional)
//   - WAIT_PREDICATE_JS : in-page boolean expression polled until true (optional)
//   - SCROLL          : { strategy: 'window' | 'pane', selector?, steps[], delayMs }
//   - pickScroll(url) : runtime SCROLL override (optional)
//   - normalizeUrl(u) : rewrite the URL before opening (optional)
//   - AWAIT_PROMISE   : true when EXTRACT_JS is async (optional)
//   - EXTRACT_JS      : string source evaluated in the page; returns JSON
//   - POST_EXTRACT(tabId, raw) : async post-processing (optional)

import * as profile from './profile.js';
import * as peopleCompany from './peopleCompany.js';
import * as posts from './posts.js';
import * as comments from './comments.js';
import * as jobs from './jobs.js';

// Order matters for URL auto-detection: more specific patterns first.
// `comments` (single-post permalink /feed/update/…) must be tested before
// `posts` (whose pattern also matches the home /feed/).
export const SKILLS = [profile, peopleCompany, comments, posts, jobs];

export const SKILLS_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.ID, s]));

// Short aliases so callers can pass `kind: 'profile'` instead of the full ID.
export const SKILLS_BY_KIND = Object.fromEntries(
  SKILLS.map((s) => [s.ID.replace(/^linkedin\./, ''), s]),
);

export function listSkills() {
  return SKILLS.map((s) => ({ id: s.ID, kind: s.ID.replace(/^linkedin\./, ''), pattern: String(s.URL_PATTERN) }));
}

// Resolve by explicit kind/ID, else by matching the URL. Returns null if none.
export function resolveSkill({ url, kind } = {}) {
  if (kind) {
    return SKILLS_BY_KIND[kind] || SKILLS_BY_ID[kind] || SKILLS_BY_ID[`linkedin.${kind}`] || null;
  }
  if (url) {
    return SKILLS.find((s) => s.URL_PATTERN.test(url)) || null;
  }
  return null;
}
