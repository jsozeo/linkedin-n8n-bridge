// LinkedIn company POSTS extractor — /company/<slug>/posts/?feedView=all.
// The company posts feed is the same card structure as content search / the
// home feed, so we REUSE the proven `posts` extractor (including its <main>
// self-scroll fix for the virtualized LazyColumn). Only the URL handling +
// scroll strategy wrapper differ.

import * as posts from './posts.js';

export const ID = 'linkedin.companyPosts';
export const STEP_KEYS = ['get_company_posts'];
export const URL_PATTERN = /linkedin\.com\/company\/[^/?#]+\/posts\/?/i;

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/company\/([^/]+)(?:\/(?:about|people|jobs|life|overview)\/?)?\/?$/i);
    if (m) {
      u.pathname = `/company/${m[1]}/posts/`;
      if (!u.searchParams.get('feedView')) u.searchParams.set('feedView', 'all');
      return u.toString();
    }
    return url;
  } catch { return url; }
}

export const WAIT_SELECTORS = posts.WAIT_SELECTORS;
export const SCROLL = posts.SCROLL;         // 'infinite' + <main> self-scroll
export const ITEMS_KEY = posts.ITEMS_KEY;   // 'posts' — runner merges across rounds
export const EXTRACT_JS = posts.EXTRACT_JS;
