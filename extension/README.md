# LinkedIn Bridge for n8n — Extension

Unpacked Manifest V3 extension. A cron-scheduled service worker polls your n8n
instance for tasks and executes them in your browser via the Chrome DevTools
Protocol (`chrome.debugger`), so events have `isTrusted: true`.

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
