// Write-action budget.
//
// Reading too fast gets you rate-limited; liking and inviting too fast gets the
// account restricted. The extension is deliberately dumb about scraping pace
// (n8n owns that), but write actions are irreversible and visible to LinkedIn,
// so the ceiling lives here too — a backend bug must not be able to fire fifty
// invitations in one polling cycle.
//
// Storage shape:
//   writeLimits   { like:{perDay,minGapMs}, comment:{...}, invite:{...} }  — optional override
//   writeLedger   { day:'YYYY-MM-DD', counts:{like:n,...}, lastAt:{like:ts,...} }

const LEDGER_KEY = 'writeLedger';
const LIMITS_KEY = 'writeLimits';

// Conservative on purpose. LinkedIn's own soft ceilings are higher, but the
// point of this pipeline is surgical outreach, not volume.
export const DEFAULT_LIMITS = {
  like:    { perDay: 60, minGapMs: 25_000 },
  comment: { perDay: 15, minGapMs: 120_000 },
  invite:  { perDay: 20, minGapMs: 90_000 },
};

const today = () => new Date().toISOString().slice(0, 10);

async function limitsFor(kind) {
  const { [LIMITS_KEY]: over } = await chrome.storage.local.get([LIMITS_KEY]);
  return { ...DEFAULT_LIMITS[kind], ...(over?.[kind] || {}) };
}

async function readLedger() {
  const { [LEDGER_KEY]: l } = await chrome.storage.local.get([LEDGER_KEY]);
  if (!l || l.day !== today()) return { day: today(), counts: {}, lastAt: {} };
  return l;
}

/**
 * Throws RATE_LIMITED when `kind` is over its daily cap or still inside its
 * cooldown. Call before doing anything LinkedIn can see.
 */
export async function checkBudget(kind) {
  const lim = await limitsFor(kind);
  const led = await readLedger();
  const used = led.counts[kind] || 0;

  if (used >= lim.perDay) {
    const e = new Error(`${kind}: daily budget exhausted (${used}/${lim.perDay})`);
    e.code = 'RATE_LIMITED';
    e.retryAfterMs = new Date(`${today()}T23:59:59Z`).getTime() - Date.now();
    throw e;
  }

  const since = Date.now() - (led.lastAt[kind] || 0);
  if (since < lim.minGapMs) {
    const e = new Error(`${kind}: cooldown, ${Math.ceil((lim.minGapMs - since) / 1000)}s left`);
    e.code = 'RATE_LIMITED';
    e.retryAfterMs = lim.minGapMs - since;
    throw e;
  }

  return { used, perDay: lim.perDay };
}

/** Record a write that actually reached LinkedIn. No-op on a dry run. */
export async function consumeBudget(kind) {
  const led = await readLedger();
  led.counts[kind] = (led.counts[kind] || 0) + 1;
  led.lastAt[kind] = Date.now();
  await chrome.storage.local.set({ [LEDGER_KEY]: led });
  return led.counts[kind];
}

export async function budgetStatus() {
  const led = await readLedger();
  const out = { day: led.day, kinds: {} };
  for (const kind of Object.keys(DEFAULT_LIMITS)) {
    const lim = await limitsFor(kind);
    out.kinds[kind] = {
      used: led.counts[kind] || 0,
      perDay: lim.perDay,
      minGapMs: lim.minGapMs,
      lastAt: led.lastAt[kind] || null,
    };
  }
  return out;
}

/** Uniform jitter so repeated actions never land on a fixed cadence. */
export const jitter = (base, spread = 0.4) =>
  Math.round(base * (1 - spread + Math.random() * spread * 2));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
