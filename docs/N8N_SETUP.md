# Driving the extension from n8n

n8n is the **brain**; the extension is the **hands** (it scrapes with your logged-in
browser session). They talk through **two webhooks** in your own n8n instance:

| Webhook | Method | Direction | Purpose |
|---|---|---|---|
| **poll** | `GET` | extension → n8n | n8n returns the job(s) to run |
| **result** | `POST` | extension → n8n | extension returns each job's result |

The extension polls every ~30 s (an alarm wakes the service worker), runs whatever
you return, and posts the result back. Both requests carry
`Authorization: Bearer <shared token>` — verify it and reject anything else.

> **Two rules that will save you hours**
> 1. **Every job must include a `taskId`** you generate — it's how you match a
>    result back to what you asked. If you omit it, the extension invents one and
>    you can't correlate.
> 2. A scrape's data comes back under **`data.result`** (the structured object),
>    with the extractor id under `data.skillId`.

---

## What the hands can do — the `social_extract` command

One command covers all scraping. Job shape:

```json
{ "taskId": "<uuid>", "type": "social_extract", "params": { "url": "https://…", "kind": "linkedin.posts" } }
```

`params`:
- `url` (required) — the page to open.
- `kind` (optional) — force an extractor; omit to auto-detect from the URL.
- `active` (optional) — show the tab while it runs.

Available `kind`s:

| kind | Use on | Returns (`data.result`) |
|---|---|---|
| `linkedin.profile` | a `/in/…` profile | headline, about, experiences[], skills[], … |
| `linkedin.peopleCompany` | a company `/company/…/people/` | company info + people[] |
| `linkedin.posts` | a profile/company posts feed | posts[] (text, reactions, url, …) |
| `linkedin.comments` | a single post permalink | the post + comments[] |
| `linkedin.jobs` | a jobs search/list | jobs[] |

Lower-level primitives also exist (`open_tab`, `close_tab`, `wait_for_selector`,
`scroll`, `evaluate_js`) if you ever need to compose your own flow, but
`social_extract` is what you'll use 95 % of the time.

---

## The queue (what makes "n8n pushes a job" work)

n8n has no built-in durable queue, so you keep a tiny one. Pick one:

### Option A — DB-backed (recommended for real use)

One table in any Postgres/Supabase you have (n8n has first-class **Postgres** and
**Supabase** nodes):

```sql
create table bridge_jobs (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  type        text not null default 'social_extract',
  params      jsonb not null,
  status      text not null default 'pending',   -- pending | dispatched | done | error
  result      jsonb,
  resume_url  text,                               -- for the Wait/resume pattern
  context     jsonb,                              -- anything you need when the result comes back
  created_at  timestamptz default now()
);
```

### Option B — no dependency (quick test, single workflow)

Keep the queue in n8n's per-workflow static data via a **Code** node. Simpler but
not concurrency-safe and confined to one workflow (enqueue, poll and result must
live in the *same* workflow). Snippets below.

---

## Workflow 1 — the poll endpoint (serves the queue)

Nodes, in order:

1. **Webhook** — Method `GET`, Path `linkedin-bridge-poll`, Respond: *Using
   'Respond to Webhook' node*.
2. **IF** — auth guard: `{{ $json.headers.authorization }}` *equals*
   `Bearer YOUR_TOKEN`. False branch → Respond 401.
3. Hand out pending jobs for this client:

   **DB (Option A) — Postgres “Execute Query”** (atomic claim):
   ```sql
   update bridge_jobs set status = 'dispatched'
   where id in (
     select id from bridge_jobs
     where client_id = {{ $json.query.clientId }} and status = 'pending'
     order by created_at limit 10
   )
   returning id as "taskId", type, params;
   ```

   **Static data (Option B) — Code node:**
   ```js
   const store = $getWorkflowStaticData('global');
   const queue = store.queue || [];
   const take = queue.splice(0, 10);   // deal them out and remove
   store.queue = queue;
   return take.map((t) => ({ json: t }));
   ```
4. **Respond to Webhook** — Body: `{{ $json }}` (the array of `{taskId,type,params}`).
   Return an empty array / HTTP 204 when there's nothing to do — that's the normal idle beat.

The extension appends `?clientId=<uuid>`; use it to route jobs per machine.

---

## Workflow 2 — the result endpoint (ingests + continues)

Body the extension posts:

```json
{
  "clientId": "…",
  "taskId": "…",
  "status": "success",
  "data": { "skillId": "linkedin.posts", "url": "…", "result": { "posts": [ … ] } },
  "durationMs": 3120
}
```

(on failure: `status: "error"`, `error: { message, code }`.)

Nodes:

1. **Webhook** — Method `POST`, Path `linkedin-bridge-result`.
2. **IF** — token guard (as above).
3. Persist / route:
   - **DB:** Postgres “Execute Query”
     `update bridge_jobs set status = {{$json.status==='success'?'done':'error'}}, result = {{ JSON.stringify($json.data) }} where id = {{ $json.taskId }} returning context, resume_url;`
   - **Static data:** Code node reads `store.jobs[$json.taskId]` for the context you saved at enqueue.
4. Continue the pipeline with the scraped data at `{{ $json.data.result }}` (see “the brain” below), or — for a single linear workflow — resume the paused execution (see the Wait/resume pattern).

---

## The brain — orchestration nodes

Now you chain hands + brain freely. The nodes you'll use:

| You want to… | n8n node |
|---|---|
| **Trigger** | **Manual Trigger** or **Schedule Trigger** (cron) |
| **Enqueue a scrape** | DB **Insert** into `bridge_jobs`, or Code push to `store.queue` |
| **Analyze / qualify (LLM)** | **Text Classifier** (qualified vs not) or **Information Extractor** (structured fields: `{ qualified: boolean, score, reason }`). Both are LangChain nodes; attach any **Chat Model** (OpenAI, Anthropic, Google Gemini) |
| **Decide / branch** | **IF** (2-way) or **Switch** (n-way) on the LLM output |
| **Handle a list** (each post / each person) | **Split Out** (array field → items) then **Loop Over Items**, or just let items flow |
| **Fan-out scrapes** | Split Out → one **Insert** (enqueue) per item |
| **Act** | **Google Sheets** (append qualified leads), **HTTP Request** (push to a CRM / lemlist / Slack), **Set**/**Merge** to shape data |
| **Wait for a scrape result inline** | **Wait** node → “On webhook call” (resume URL), stored on the job row |

### Qualify example (Information Extractor)
- Input text: `{{ JSON.stringify($json.data.result) }}`
- Schema / attributes: `qualified` (boolean), `segment` (enum), `reason` (string).
- Then an **IF** on `{{ $json.output.qualified }}` → true: append to Sheet / handoff; false: drop.

---

## Assembled example A — no DB, one workflow
“Scrape a page's posts, keep only qualified ones in a Google Sheet.”

Single workflow, three triggers sharing static data:

- **Schedule Trigger** → **Code** (enqueue):
  ```js
  const store = $getWorkflowStaticData('global');
  store.queue = store.queue || [];
  store.queue.push({
    taskId: crypto.randomUUID(),
    type: 'social_extract',
    params: { url: 'https://www.linkedin.com/company/acme/posts/', kind: 'linkedin.posts' },
  });
  return { enqueued: true };
  ```
- **Webhook (poll)** → Code (deal out) → **Respond** — as in Workflow 1, Option B.
- **Webhook (result)** → **Split Out** on `data.result.posts` → **Text Classifier**
  (qualified?) → **IF** true → **Google Sheets: Append**.

The extension picks the job up within ~30 s, scrapes, posts back, and the result
branch classifies each post and files the good ones.

## Assembled example B — DB + Wait/resume (clean linear chaining)
One orchestration workflow reads top-to-bottom:

1. **Manual/Schedule Trigger**
2. **Set** the seed URL + a `taskId`
3. **Postgres Insert** into `bridge_jobs` (status `pending`)
4. **Wait** → “On webhook call” → put `{{ $resumeWebhookUrl }}` into the job row
   (Postgres Update by `taskId`), then pause
5. *(extension polls Workflow 1, scrapes, posts to Workflow 2)*
6. **Workflow 2** looks up `resume_url` by `taskId` and **HTTP Request**s it with
   the data → your orchestration resumes at step 4 with `data.result`
7. **Information Extractor** (qualify) → **Switch** → **Act** (Sheet / CRM / Slack)

Use B when you want the whole logic in one readable flow; A when you want the
quickest thing that works.

---

## Configure the extension (side panel)
- **Automation poll webhook URL** → the poll webhook's **Production URL**.
- **Automation result webhook URL** → the result webhook's Production URL.
- **Shared token** → the secret you check in the IF guards.
- **Schedule** → enable it (polls ~every 30 s).

> Use n8n's **Production URL** (activate the workflow), not the Test URL — the
> latter only listens while you click “Listen for test event”.
