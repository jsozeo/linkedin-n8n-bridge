# LinkedIn Bridge for n8n

A Chrome extension (Manifest V3) that lets your **[n8n](https://n8n.io)** workflows
drive **LinkedIn** through your own, already-logged-in browser — on a schedule
**you** control with a cron expression.

Because actions run inside your real browser session via the Chrome DevTools
Protocol, events are genuine (`isTrusted: true`) and there is no separate
LinkedIn login, cookie export, or unofficial API to manage. Your session never
leaves your machine: the extension only ever talks to the n8n instance **you**
configure.

> Status: v1.0 — extension + n8n integration. A hardened LinkedIn **MCP**
> server is on the roadmap (see [Roadmap](#roadmap)).

## How it works

There is no cloud backend. The extension is the only moving part, and it
initiates every connection (a browser extension has no inbound URL):

```
        ┌─────────────────────────────┐        ┌────────────────────────┐
        │  Chrome + LinkedIn Bridge   │        │        your n8n        │
        │                             │        │                        │
  cron ─┤ 1. GET  poll webhook  ──────┼───────▶│  Webhook: return tasks │
        │ 2. run each task via CDP    │        │                        │
        │ 3. POST result webhook ─────┼───────▶│  Webhook: store result │
        └─────────────────────────────┘        └────────────────────────┘
```

1. On each cron tick the service worker **polls** your n8n *poll* webhook.
2. n8n responds with zero or more **tasks** (generic browser commands).
3. The extension executes them sequentially in your browser.
4. Each result is **POSTed** back to your n8n *result* webhook (optional).

A task is a small JSON object:

```json
{ "taskId": "abc123", "type": "open_tab", "params": { "url": "https://www.linkedin.com/feed/" } }
```

See [`extension/README.md`](./extension/README.md) for the full command
catalogue (`open_tab`, `navigate`, `mouse_click`, `type_text`, `get_text`,
`evaluate_js`, `screenshot`, …).

## Install (developer / unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Click the extension's icon (or open its **Options**) and fill in:
   - **n8n poll webhook URL** — must accept `GET`.
   - **n8n result webhook URL** — optional, receives `POST`.
   - **Shared token** — click *generate*; set the same value on the n8n side.
   - **Schedule** — enable it and pick a cron preset (or write your own).
4. Save. When you save, Chrome asks permission to contact your n8n host — accept.

A published Chrome Web Store build will follow; until then, use the unpacked
extension above.

## Configure n8n

Step-by-step workflow setup (poll webhook, result webhook, token check, and a
worked example) lives in [`docs/N8N_SETUP.md`](./docs/N8N_SETUP.md).

## Scheduling (cron)

The scheduler uses standard 5-field cron, evaluated in your browser's **local
time**, and is driven by `chrome.alarms` (so it wakes the service worker even
after Chrome has suspended it). Granularity is one minute.

| Example | Meaning |
|---|---|
| `*/15 * * * *` | every 15 minutes |
| `0 * * * *` | every hour |
| `0 9 * * 1-5` | weekdays at 09:00 |
| `0 9,17 * * 1-5` | weekdays at 09:00 and 17:00 |

You can also hit **Run now** in the options page to trigger a cycle immediately.

## Security & privacy

- **No third-party server.** The extension talks only to the n8n URLs you enter.
- **Least privilege host access.** LinkedIn is the only pre-granted host; access
  to your n8n host is requested at runtime, only when you save its URL.
- **Shared-token auth.** Every request carries `Authorization: Bearer <token>`;
  verify it in your n8n workflow and reject anything that doesn't match.
- **Your data stays local.** Cookies and your logged-in session never leave the
  browser except as the explicit results your own workflow asks for.

Please use responsibly and within LinkedIn's Terms of Service. You are
responsible for what your workflows do with your account.

## Roadmap

- [ ] Chrome Web Store listing.
- [ ] Hardened **LinkedIn MCP** server (localhost, token-gated, per-tool scopes,
      rate limiting, audit log) so AI agents can drive LinkedIn safely.
- [ ] Higher-level LinkedIn convenience commands.

## License

[MIT](./LICENSE).
