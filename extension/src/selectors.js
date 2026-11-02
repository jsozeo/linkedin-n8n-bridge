// Cloud selector registry.
//
// LinkedIn reshuffles its DOM every few weeks and every reshuffle used to mean
// rebuilding and reloading the extension. The registry breaks that coupling:
// selectors are DATA, served from S3, fetched at runtime and cached in
// chrome.storage.local. Edit the JSON, push it, and the next poll picks it up.
//
// The bundled DEFAULTS below stay in the build as a floor: if the network is
// down, the URL is unset, or the remote document is malformed, the extension
// keeps working on whatever shipped with it. Remote always wins when valid.
//
// Storage shape:
//   selectorsUrl   'https://<lambda>/selectors'  — unset means "bundled only"
//   selectorsCache { at, version, data }
//
// Every entry is an ARRAY of candidates tried in order, so a selector can be
// replaced without deleting the one that still works for some accounts.

const CACHE_KEY = 'selectorsCache';
const URL_KEY = 'selectorsUrl';
const TTL_MS = 10 * 60 * 1000;

export const DEFAULTS = {
  version: 'bundled',
  linkedin: {
    // Anything matching these is a comment, never the post itself. Used to keep
    // a post-level action from grabbing a button that belongs to a comment.
    commentRowMarkers: [
      '[id^="replaceableComment_urn:li:comment:"]',
      'article[data-id^="urn:li:comment:"]',
      'article.comments-comment-entity',
    ],

    // Reaction state is carried in the label text, not aria-pressed, which the
    // SDUI pages do not set at all: "Reaction button state: no reaction" when
    // untouched, anything else once a reaction is on. On a post the label sits
    // on the <button>; on a comment it sits on the <svg> inside a
    // div[role="button"], which is why locate() climbs to the clickable parent.
    reaction: {
      button: ['[aria-label^="Reaction button state"]'],
      unreactedLabel: ['no reaction'],
    },

    // --- post, as rendered on its permalink page -------------------------
    // Permalinks render through Server-Driven UI (hashed classes), the classic
    // feed still ships .feed-shared-update-v2. Both are listed.
    post: {
      root: [
        'main [data-urn^="urn:li:activity:"]',
        'div.feed-shared-update-v2',
        'main#workspace',
        'main',
      ],
      likeButton: [
        '[aria-label^="Reaction button state"]',
        'button[aria-label^="React Like"]',
        'button.react-button__trigger',
      ],
      commentButton: [
        'button[aria-label^="Comment"]',
        'button.comment-button',
      ],
    },

    // --- the comment composer (used for both post comments and replies) ---
    composer: {
      box: [
        '[aria-label="Text editor for creating comment"]',
        '[data-testid="ui-core-tiptap-text-editor-wrapper"] [role="textbox"]',
        'div.ql-editor[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
      ],
      // The submit control does not exist while the box is empty — LinkedIn
      // renders it only once there is text — so it cannot be read off a capture
      // of a fresh page. These candidates are tried first; when none match,
      // findSubmit() falls back to "the enabled clickable thing in the composer
      // that is not one of the accessories below".
      submit: [
        'button[aria-label^="Submit comment"]',
        'button[aria-label^="Post comment"]',
        'button[aria-label="Reply"][type="submit"]',
        'button[type="submit"]',
        'button[aria-label^="Submit"]',
      ],
      // Everything in the composer's neighbourhood that is NOT the submit
      // control. The heuristic above would otherwise happily click the comment
      // sort dropdown, which sits right next to it.
      accessories: [
        '[aria-label="Show Emoji Picker"]',
        '[aria-label="Open GIF picker"]',
        '[aria-label="Share photo"]',
        '[aria-label^="Mention"]',
        '[aria-label^="Add a"]',
        '[aria-label^="Open control menu"]',
        '[aria-label^="Open reactions menu"]',
        '[aria-label^="View more options"]',
        '[aria-label="Repost"]',
        '[aria-label="Comment"]',
        '[aria-label^="Reaction button state"]',
        '[aria-label="Dismiss"]',
        { text: 'Most relevant' },
        { text: 'Most recent' },
        { text: 'Les plus pertinents' },
        { text: 'Les plus récents' },
        { text: 'Follow' },
        { text: 'Suivre' },
      ],
    },

    // --- an individual comment inside a post ------------------------------
    comment: {
      // The SDUI row id IS "replaceableComment_<urn>", which is how the
      // get_comments extractor already targets comments in production.
      row: [
        '[id^="replaceableComment_urn:li:comment:"]',
        'article[data-id^="urn:li:comment:"]',
        'article.comments-comment-entity',
      ],
      urnAttr: ['id', 'data-id'],
      author: [
        '[aria-label^="View more options for "]',
        '.comments-comment-meta__description-title',
      ],
      text: ['[data-testid="expandable-text-box"]', '.comments-comment-item__main-content'],
      likeButton: [
        '[aria-label^="Reaction button state"]',
        'button[aria-label^="React Like"]',
      ],
      replyButton: [
        'button[aria-label="Reply"]',
        'button[aria-label^="Reply"]',
        'button.comments-comment-social-bar__reply-action-button--cr',
      ],
      // Replies are comments nested under a comment; same row shape.
      repliesContainer: [
        '.comments-replies-list',
        '.comments-comment-item__replies-list',
      ],
      // SDUI renders this as a plain div with no aria-label, so it is matched
      // on its visible text and locate() climbs to the clickable parent.
      showMoreReplies: [
        { text: 'See previous replies' },
        { text: 'Voir les réponses précédentes' },
        { text: 'Load previous replies' },
        'button[aria-label*="previous repl"]',
        'button[aria-label*="more repl"]',
      ],
    },

    // --- connection invitation on a profile page --------------------------
    profile: {
      connectButton: [
        'main button[aria-label^="Invite"][aria-label*="connect"]',
        'main button[aria-label^="Connect"]',
      ],
      // When Connect is hidden behind the overflow menu.
      moreButton: [
        'main button[aria-label="More actions"]',
        'main button[aria-label^="More"]',
      ],
      moreConnectItem: [
        'div[aria-label^="Invite"][aria-label*="connect"]',
        '.artdeco-dropdown__content li div[aria-label^="Invite"]',
      ],
      // The modal that follows.
      sendWithoutNote: [
        'button[aria-label="Send without a note"]',
        'button[aria-label^="Send without"]',
      ],
      addNote: ['button[aria-label="Add a note"]'],
      noteBox: ['textarea#custom-message', 'textarea[name="message"]'],
      sendInvite: [
        'button[aria-label="Send invitation"]',
        'button[aria-label^="Send now"]',
      ],
      // Already connected / already pending.
      pendingMarker: [
        'main button[aria-label^="Pending"]',
        'main button[aria-label*="withdraw invitation"]',
      ],
      dismissModal: ['button[aria-label="Dismiss"]'],
    },
  },
};

let memo = null;

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object' && !Array.isArray(over)) {
    const out = Array.isArray(base) ? {} : { ...(base || {}) };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base?.[k], v);
    return out;
  }
  return over === undefined ? base : over;
}

async function fetchRemote(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc || typeof doc !== 'object' || !doc.linkedin) throw new Error('not a selector document');
  return doc;
}

/**
 * Pull the remote document and store it. `force` ignores the TTL.
 * Never throws: a failed refresh leaves the previous cache in place.
 */
export async function refreshSelectors({ force = false } = {}) {
  const store = await chrome.storage.local.get([URL_KEY, CACHE_KEY]);
  const url = store[URL_KEY];
  const cache = store[CACHE_KEY];

  if (!url) return { source: 'bundled', reason: 'no selectorsUrl configured' };
  if (!force && cache?.at && Date.now() - cache.at < TTL_MS) {
    return { source: 'cache', version: cache.version, ageMs: Date.now() - cache.at };
  }

  try {
    const doc = await fetchRemote(url);
    await chrome.storage.local.set({
      [CACHE_KEY]: { at: Date.now(), version: doc.version || 'remote', data: doc },
    });
    memo = null;
    return { source: 'remote', version: doc.version || 'remote', url };
  } catch (e) {
    console.warn('[bridge] selector refresh failed:', e.message);
    return {
      source: cache ? 'stale-cache' : 'bundled',
      version: cache?.version,
      error: e.message,
    };
  }
}

/** Bundled defaults overlaid with whatever the last successful refresh stored. */
export async function getSelectors() {
  if (memo) return memo;
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get([CACHE_KEY]);
  memo = cache?.data ? deepMerge(DEFAULTS, cache.data) : DEFAULTS;
  return memo;
}

/**
 * Candidate list for a dotted path, e.g. sel('linkedin.post.likeButton').
 * Always an array, so callers can loop without a null check.
 */
export async function sel(path) {
  const reg = await getSelectors();
  const found = path.split('.').reduce((o, k) => (o == null ? o : o[k]), reg);
  if (typeof found === 'string') return [found];
  return Array.isArray(found) ? found : [];
}

/** Which document is actually in force right now — surfaced by the status command. */
export async function selectorStatus() {
  const { [URL_KEY]: url, [CACHE_KEY]: cache } = await chrome.storage.local.get([URL_KEY, CACHE_KEY]);
  return {
    url: url || null,
    version: cache?.version || DEFAULTS.version,
    fetchedAt: cache?.at || null,
    ageMs: cache?.at ? Date.now() - cache.at : null,
    stale: cache?.at ? Date.now() - cache.at > TTL_MS : true,
  };
}
