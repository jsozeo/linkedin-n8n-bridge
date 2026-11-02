// Configuration is read from chrome.storage.local and is filled in from the
// extension's Options page (chrome://extensions → this extension → Details →
// Extension options).
//
// Storage shape:
//   {
//     token:    'shared secret, also configured on the n8n side',
//     clientId: 'auto-generated UUID, identifies this browser',
//     n8n: {
//       pollUrl:   'https://your-n8n/webhook/linkedin-bridge-poll',   // GET → returns queued task(s)
//       resultUrl: 'https://your-n8n/webhook/linkedin-bridge-result'  // POST ← task results (optional)
//     },
//     schedule: {
//       enabled: true,
//       cron:    '* * * * *'   // standard 5-field cron, evaluated in local time.
//                              // Poll frequently: the n8n side (Feeder) governs
//                              // actual scraping pace (active hours, 1h gap,
//                              // jitter, daily caps), so the extension only asks
//                              // "any job?" and executes what it's handed.
//     }
//   }

export const DEFAULT_CRON = '* * * * *';

// The bridge talks to one n8n instance, so the endpoints ship with the build.
// Leaving them to be typed in made an empty field stop every job in silence.
// The storage values stay authoritative, so an override still wins.
export const DEFAULT_POLL_URL = 'https://api2.ozeo.io/webhook/GET-ORCHESTRATED';
export const DEFAULT_RESULT_URL = 'https://api2.ozeo.io/webhook/ingest-result';

export async function loadConfig() {
  const cfg = await chrome.storage.local.get(['token', 'clientId', 'n8n', 'schedule']);

  if (!cfg.clientId) {
    cfg.clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: cfg.clientId });
  }

  cfg.schedule = cfg.schedule || { enabled: false, cron: DEFAULT_CRON };
  cfg.n8n = {
    ...cfg.n8n,
    pollUrl: cfg.n8n?.pollUrl || DEFAULT_POLL_URL,
    resultUrl: cfg.n8n?.resultUrl || DEFAULT_RESULT_URL,
  };

  const missing = [];
  if (!cfg.token) missing.push('token');

  if (missing.length) {
    console.warn('[bridge] config incomplete, missing:', missing.join(', '));
    return null;
  }

  return cfg;
}

export async function isScheduleEnabled() {
  const { schedule } = await chrome.storage.local.get(['schedule']);
  return Boolean(schedule?.enabled);
}
