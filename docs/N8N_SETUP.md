# Connecting the extension to n8n

The extension talks to **two** webhooks in your own n8n instance:

| Webhook | Method | Direction | Purpose |
|---|---|---|---|
| **poll** | `GET` | extension → n8n | n8n returns the task(s) to run |
| **result** | `POST` | extension → n8n | n8n receives each task's result (optional) |

Both requests carry `Authorization: Bearer <shared token>`. Verify it in your
workflow and reject anything that doesn't match.

---

## 1. The poll webhook (returns tasks)

1. Add a **Webhook** node.
   - HTTP Method: `GET`
   - Path: e.g. `linkedin-bridge-poll`
   - Respond: **Using 'Respond to Webhook' node**
2. (Recommended) Add an **IF** node that checks the token:
   - Value 1: `{{ $json.headers.authorization }}`
   - Operation: *equals*
   - Value 2: `Bearer YOUR_SHARED_TOKEN`
3. On the authorized branch, add a **Respond to Webhook** node returning your
   tasks as JSON. Accepted shapes:

```json
[
  { "type": "open_tab", "params": { "url": "https://www.linkedin.com/feed/" } },
  { "type": "get_text", "params": { "tabId": 0, "selector": "h1" } }
]
```

   You can also return a single object, or `{ "tasks": [ ... ] }`.
   Return **HTTP 204** (or an empty body / empty array) when there is nothing to
   do — that is the normal idle response.

> **Where do tasks come from?** That's up to your workflow. Common patterns:
> pull rows from a database/queue that another workflow filled, compute them on
> the fly, or keep a simple list. The extension is a generic executor — it does
> not decide *what* to do, only *runs* what you return.

The extension appends `?clientId=<uuid>` to the poll URL so one workflow can
serve multiple browsers. Use it to route tasks per machine if needed.

---

## 2. The result webhook (receives results)

1. Add a second **Webhook** node.
   - HTTP Method: `POST`
   - Path: e.g. `linkedin-bridge-result`
2. Verify the token as above.
3. Body you receive per task:

```json
{
  "clientId": "…",
  "taskId": "…",
  "status": "success",
  "data": { "text": "John Doe" },
  "durationMs": 812
}
```

On failure, `status` is `"error"` and `error` holds `{ message, code }`.

Wire the result into whatever comes next (store it, branch on it, enqueue the
follow-up task, etc.).

---

## 3. Configure the extension

Open the extension **Options** page and set:

- **n8n poll webhook URL** → your poll webhook's **Production URL**.
- **n8n result webhook URL** → your result webhook's Production URL (optional).
- **Shared token** → the same secret you check in the IF nodes.
- **Schedule** → enable it and choose how often to poll.

Save, then accept the permission prompt so Chrome may contact your n8n host.

> **Test vs production URLs:** n8n's *Test URL* only works while you click
> "Listen for test event". Use the **Production URL** (activate the workflow)
> for the extension.

---

## Worked example: grab your feed's first heading every 15 minutes

Poll webhook returns:

```json
[
  { "type": "open_tab", "params": { "url": "https://www.linkedin.com/feed/", "waitUntil": "domcontentloaded" } }
]
```

The extension opens the tab and posts back `{ status: "success", data: { tabId, url, title } }`.
Your result workflow reads `data.tabId`, then your **next** poll returns:

```json
[
  { "type": "get_text", "params": { "tabId": 123, "selector": "main h1" } },
  { "type": "close_tab", "params": { "tabId": 123 } }
]
```

Set the extension schedule to `*/15 * * * *` and you have a feed check every 15
minutes. See [`../extension/README.md`](../extension/README.md) for every
available command.
