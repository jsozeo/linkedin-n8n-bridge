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
//       cron:    '*/15 * * * *'   // standard 5-field cron, evaluated in local time
//     }
//   }

export const DEFAULT_CRON = '*/15 * * * *';

export async function loadConfig() {
  const cfg = await chrome.storage.local.get(['token', 'clientId', 'n8n', 'schedule']);

  if (!cfg.clientId) {
    cfg.clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: cfg.clientId });
  }

  cfg.schedule = cfg.schedule || { enabled: false, cron: DEFAULT_CRON };
  cfg.n8n = cfg.n8n || {};

  const missing = [];
  if (!cfg.token) missing.push('token');
  if (!cfg.n8n?.pollUrl) missing.push('n8n.pollUrl');

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
