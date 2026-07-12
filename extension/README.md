# Social Media Bridge for n8n — Extension

Unpacked Manifest V3 extension. A cron-scheduled service worker polls your
automation tool (n8n / Make / Zapier / self-hosted) for tasks and executes them
in your browser via the Chrome DevTools Protocol (`chrome.debugger`), so events
have `isTrusted: true`.

## Install & configure

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick this
   `extension/` folder.
2. Open the extension **Options** and fill in the n8n webhook URLs, a shared
   token, and a cron schedule. Save.

See the root [`README.md`](../README.md) and
[`docs/N8N_SETUP.md`](../docs/N8N_SETUP.md) for the n8n side.

## Task shape

A task is JSON with a `type` and `params`. `taskId` is optional (auto-assigned
if absent):

```json
{ "taskId": "abc123", "type": "type_text", "params": { "tabId": 42, "text": "hello" } }
```

Your poll webhook may return a single task, an array of tasks, or
`{ "tasks": [ … ] }`. Tasks run sequentially with light pacing between them.

## Commands

All commands take `params` and return a JSON payload (or throw, in which case an
error result is posted). The full set is registered in
[`src/commands/index.js`](./src/commands/index.js).

### Tabs (`src/commands/tab.js`)
| Command | Params | Returns |
|---|---|---|
| `open_tab` | `{ url, active?, windowId?, waitUntil?, timeoutMs? }` | `{ tabId, windowId, url, title, active }` |
| `close_tab` | `{ tabId }` | `{ ok: true }` |
| `list_tabs` | `{ windowId?, currentWindow? }` | `{ tabs: [...] }` |
| `focus_tab` | `{ tabId }` | `{ ok, tabId, windowId }` |
| `get_tab` | `{ tabId }` | tab metadata |

### Navigation (`src/commands/navigation.js`)
| Command | Notes |
|---|---|
| `navigate` | `{ tabId, url, waitUntil?, timeoutMs? }` — `waitUntil` ∈ `load` (default), `domcontentloaded`, `none` |
| `reload` | `{ tabId, bypassCache?, waitUntil?, timeoutMs? }` |
| `go_back` / `go_forward` | `{ tabId, timeoutMs? }` |
| `wait_for_load` | `{ tabId, state?, timeoutMs? }` — `state` ∈ `load`, `domcontentloaded`, `networkidle` |
| `wait_for_selector` | `{ tabId, selector, timeoutMs?, visible?, pollMs? }` |

### Mouse & wheel (`src/commands/mouse.js`)
`mouse_move`, `mouse_down`, `mouse_up`, `mouse_click`, `mouse_drag`, `wheel`.
All take `{ tabId, x, y, ... }`; modifiers bitmask: `1=Alt, 2=Ctrl, 4=Meta, 8=Shift`.

### Keyboard (`src/commands/keyboard.js`)
| Command | Params |
|---|---|
| `key_press` | `{ tabId, key, modifiers?, holdMs? }` |
| `type_text` | `{ tabId, text, delayMs? }` — human-ish per-character pacing |
| `shortcut` | `{ tabId, combo }` — e.g. `"Cmd+T"`, `"Ctrl+Shift+L"` |
| `key_down` / `key_up` | low-level pair |

### Scroll (`src/commands/scroll.js`)
`scroll` — `{ tabId, percent, durationMs? }`. Animated wheel dispatch.

### Extraction (`src/commands/extract.js`)
`query_selector`, `get_text`, `get_html`, `get_attribute`, `get_value`, `exists`, `count`.

### JS execution (`src/commands/evaluate.js`)
`evaluate_js` — `{ tabId, expression, awaitPromise? }`. **Very powerful** —
arbitrary JS in the page; only the shared token gates it. Treat your token as a
secret.

### Screenshot (`src/commands/screenshot.js`)
`screenshot` — `{ tabId, format?, quality?, fullPage? }`. Returns a `data:` URL.

### Cookies (`src/commands/cookies.js`)
`get_cookies`, `set_cookies`, `clear_cookies`.

### Social extraction (`src/commands/social.js`)
| Command | Params | Returns |
|---|---|---|
| `social_extract` | `{ url, kind?, platform?, active?, keepTab?, timeoutMs? }` | `{ skillId, url, targetUrl, durationMs, result, steps }` |
| `list_social_skills` | — | `{ skills: [{ id, platform, kind, pattern }] }` |
| `linkedin_extract` | alias of `social_extract` | — |

`social_extract` runs the full pipeline (open → wait → scroll → evaluate →
close) with a DOM extractor auto-detected from the URL, or forced via `kind`
(full id like `linkedin.profile`, or a bare type). Set `active: true` to watch
the tab (used by the side panel's manual mode); leave it `false` for background
scheduled runs. Extractors live in [`src/extractors/<platform>/`](./src/extractors/)
and lean on stable anchors (`componentkey`, `aria-label`, heading text, href
patterns) instead of hashed CSS classes. New platforms register in
[`src/extractors/index.js`](./src/extractors/index.js).

## UI: side panel

[`sidepanel.html`](./sidepanel.html) / [`sidepanel.js`](./sidepanel.js) is the
extension's home (opened by clicking the toolbar icon, and also registered as
the options page). It holds the settings form, a **cron builder** (days / hour
range / frequency), a live **Status** block, and a **Manual run** section that
fires a single `social_extract` (or `open_tab`) against a URL and shows the
pipeline steps + structured result inline.

## Architecture notes

- [`src/background.js`](./src/background.js) — the scheduler. Computes the next
  cron time, arms a `chrome.alarms` alarm, and on each tick drains the n8n queue.
- [`src/cron.js`](./src/cron.js) — dependency-free 5-field cron parser
  (`nextRun`, `validateCron`).
- [`src/config.js`](./src/config.js) — reads settings from `chrome.storage.local`.
- [`src/cdp.js`](./src/cdp.js) — the only module that talks to `chrome.debugger`.
  It caches attached tabs and enabled CDP domains, and fans DevTools events out
  to `waitForEvent()` subscribers.
- Commands are pure functions on `params`; they throw `Error` with `.code` on
  failure, which `background.js` serializes into the result payload.
