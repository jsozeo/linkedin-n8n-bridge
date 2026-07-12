// Multi-platform extractor registry.
//
// Each platform lives in its own folder (extractors/<platform>/) and exports a
// `PLATFORM` id plus an ordered `SKILLS` array. New platforms (instagram,
// facebook, pinterest, youtube, x, tiktok, …) are added here as their
// extractors land — nothing else in the codebase needs to change.
//
// A skill exports:
//   - ID                : '<platform>.<type>' e.g. 'linkedin.profile'
//   - URL_PATTERN       : RegExp matching the pages it handles
//   - WAIT_SELECTORS    : CSS selectors to await before extracting (optional)
//   - WAIT_PREDICATE_JS : in-page boolean expression polled until true (optional)
//   - SCROLL            : { strategy:'window'|'pane', selector?, steps[], delayMs }
//   - pickScroll(url)   : runtime SCROLL override (optional)
//   - normalizeUrl(u)   : rewrite the URL before opening (optional)
//   - AWAIT_PROMISE     : true when EXTRACT_JS is async (optional)
//   - EXTRACT_JS        : string source evaluated in the page; returns JSON
//   - POST_EXTRACT(tabId, raw) : async post-processing (optional)

import * as linkedin from './linkedin/index.js';

// Register platforms here. Order = auto-detection priority across platforms.
const PLATFORM_MODULES = [linkedin];

export const PLATFORMS = PLATFORM_MODULES.map((p) => p.PLATFORM);

export const SKILLS = PLATFORM_MODULES.flatMap((p) => p.SKILLS);

export const SKILLS_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.ID, s]));

const kindOf = (id) => id.split('.').slice(1).join('.');
const platformOf = (id) => id.split('.')[0];

export function listSkills() {
  return SKILLS.map((s) => ({
    id: s.ID,
    platform: platformOf(s.ID),
    kind: kindOf(s.ID),
    pattern: String(s.URL_PATTERN),
  }));
}

/**
 * Resolve a skill.
 *   - `kind` may be a full ID ('linkedin.profile'), a bare type ('profile'),
 *     optionally scoped by `platform`.
 *   - else fall back to matching the URL against every skill's URL_PATTERN.
 * Returns null when nothing matches.
 */
export function resolveSkill({ url, kind, platform } = {}) {
  if (kind) {
    if (SKILLS_BY_ID[kind]) return SKILLS_BY_ID[kind];
    if (platform && SKILLS_BY_ID[`${platform}.${kind}`]) return SKILLS_BY_ID[`${platform}.${kind}`];
    const matches = SKILLS.filter((s) => kindOf(s.ID) === kind && (!platform || platformOf(s.ID) === platform));
    if (matches.length) return matches[0];
    return null;
  }
  if (url) return SKILLS.find((s) => s.URL_PATTERN.test(url)) || null;
  return null;
}
