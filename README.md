# Social Media Bridge for n8n

A Chrome extension (Manifest V3) that lets your automation tools —
**[n8n](https://n8n.io)**, **Make**, **Zapier**, or any self-hosted server —
drive **social media** (LinkedIn today, more platforms coming) through your own,
already-logged-in browser, on a schedule **you** control with a cron expression.

Because actions run inside your real browser session via the Chrome DevTools
Protocol, events are genuine (`isTrusted: true`) and there is no separate login,
cookie export, or unofficial API to manage. Your session never leaves your
machine: the extension only ever talks to the automation endpoint **you**
configure.

> Status: v1.0 — extension + automation-webhook integration, with LinkedIn
> extractors built in. More social platforms (Instagram, Facebook, Pinterest,
> YouTube, X, TikTok…) will be added progressively. A hardened social-media
> **MCP** server is on the roadmap (see [Roadmap](#roadmap)).

## How it works

There is no cloud backend. The extension is the only moving part, and it
initiates every connection (a browser extension has no inbound URL):

```
        ┌─────────────────────────────┐        ┌────────────────────────────┐
        │  Chrome + Social Bridge     │        │  your automation tool       │
        │                             │        │  (n8n / Make / Zapier / …)  │
  cron ─┤ 1. GET  poll webhook  ──────┼───────▶│  Webhook: return tasks      │
        │ 2. run each task via CDP    │        │                             │
        │ 3. POST result webhook ─────┼───────▶│  Webhook: store result      │
        └─────────────────────────────┘        └────────────────────────────┘
```

1. On each cron tick the service worker **polls** your *poll* webhook.
2. Your tool responds with zero or more **tasks** (generic browser commands).
3. The extension executes them sequentially in your browser.
4. Each result is **POSTed** back to your *result* webhook (optional).

A task is a small JSON object:

```json
{ "taskId": "abc123", "type": "open_tab", "params": { "url": "https://www.linkedin.com/feed/" } }
```

See [`extension/README.md`](./extension/README.md) for the full command
catalogue (`open_tab`, `navigate`, `mouse_click`, `type_text`, `get_text`,
`evaluate_js`, `screenshot`, …).

### Social extractors (built-in)

Beyond the generic primitives, one high-level command turns a social-media URL
into structured JSON in a single call:

```json
{ "type": "social_extract", "params": { "url": "https://www.linkedin.com/in/some-profile/" } }
```

It opens the page, waits, scrolls to trigger lazy-loading, runs a battle-tested
DOM extractor, and returns clean data. The extractor is auto-detected from the
URL, or forced with `params.kind` (a full id like `linkedin.profile`, or the
bare type below). Platforms live in [`extension/src/extractors/`](./extension/src/extractors/);
new ones plug in there.

**LinkedIn** (available now):

| `kind` | Handles | Returns |
|---|---|---|
| `linkedin.profile` | `/in/<slug>/` | identity, about, experiences, education, skills, languages, recent activity… |
| `linkedin.peopleCompany` | `/company/<slug>/[people/]` | company info + people list |
| `linkedin.posts` | `/feed/`, `/in/<slug>/recent-activity/…` | list of posts with engagement |
| `linkedin.comments` | `/feed/update/…`, `/posts/…` | the post + its comments |
| `linkedin.jobs` | `/jobs/search`, `/jobs/collections`, `/jobs/view/…` | job cards |

These extractors avoid hashed CSS classes and lean on stable anchors
(`componentkey`, `aria-label`, section heading text, href patterns), so they
survive frequent redesigns. They are multilingual (EN/FR).

**Coming next:** Instagram, Facebook, Pinterest, YouTube, X, TikTok… (host
permissions are already declared; extractors are pushed progressively).

`linkedin_extract` remains as a backwards-compatible alias of `social_extract`.

### Side panel & manual mode

The extension's home is a **side panel** (click the toolbar icon). It holds all
the settings **and** a **Manual run** section: paste a social-media URL, pick an
action, hit *Run*, watch the tab work, and inspect the structured result — no
automation tool required. Great for trying things out before wiring a workflow.

## Install (developer / unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Click the extension's icon to open the **side panel**, then fill in:
   - **Poll webhook URL** — from your automation tool; must accept `GET`.
   - **Result webhook URL** — optional, receives `POST`.
   - **Shared token** — click *generate*; set the same value on your tool's side.
   - **Schedule** — enable it, then use the builder (days / hours / frequency) or a preset.
4. Save. When you save, Chrome asks permission to contact your automation host — accept.

Tip: you don't need an automation tool to try it — use the **Manual run** section
at the top of the side panel to run an extractor against any supported URL.

A published Chrome Web Store build will follow (see
[`docs/CHROME_WEB_STORE.md`](./docs/CHROME_WEB_STORE.md)); until then, use the
unpacked extension above.

## Configure your automation tool

The extension speaks plain HTTP webhooks, so it works with n8n, Make, Zapier or a
self-hosted server. A step-by-step **n8n** walkthrough (poll webhook, result
webhook, token check, worked example) lives in
[`docs/N8N_SETUP.md`](./docs/N8N_SETUP.md); the same two-webhook pattern applies
to any tool.

## Scheduling (cron)

The scheduler uses standard 5-field cron, evaluated in your browser's **local
time**, driven by `chrome.alarms` (so it wakes the service worker even after
Chrome has suspended it). Granularity is one minute. The side panel has a
**builder** (pick days, an hour range, and a frequency) that writes the cron for
you, plus presets and an advanced raw-cron field.

| Example | Meaning |
|---|---|
| `*/15 9-18 * * 1-5` | every 15 min, 9–18h, weekdays |
| `0 9-18 * * 1-5` | hourly, 9–18h, weekdays |
| `*/15 * * * *` | every 15 minutes, 24/7 |
| `0 9 * * 1-5` | weekdays at 09:00 |

You can also hit **Run now** to trigger a cycle immediately.

## Security & privacy

- **No third-party server.** The extension talks only to the automation URLs you enter.
- **Least privilege host access.** Only known social-media hosts are pre-granted;
  access to your automation host is requested at runtime, only when you save its URL.
- **Shared-token auth.** Every request carries `Authorization: Bearer <token>`;
  verify it in your workflow and reject anything that doesn't match.
- **Your data stays local.** Cookies and your logged-in session never leave the
  browser except as the explicit results your own workflow asks for.

Please use responsibly and within each platform's Terms of Service. You are
responsible for what your workflows do with your accounts.

## Roadmap

- [ ] Chrome Web Store listing.
- [ ] More social platforms (Instagram, Facebook, Pinterest, YouTube, X, TikTok…).
- [ ] Hardened social-media **MCP** server (localhost, token-gated, per-tool scopes,
      rate limiting, audit log) so AI agents can drive social platforms safely.
- [x] Side panel UI + manual mode + cron builder.
- [x] Built-in LinkedIn extractors (profile / company people / posts / comments / jobs).
- [ ] Port the guest-endpoint single-job extractor (needs a browser-side rewrite).

## License

[MIT](./LICENSE).
