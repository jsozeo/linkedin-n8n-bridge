# Multi-session — what collides, what does not

Written 2026-11-02 while removing the hardcoded session from the orchestrator.

## What the governor used to assume

Workflow `glff1mdIo2uujHU6`, node `Governor: peek+lock`, carried the string
`'linkedin_1'` five times and the clientId `c7b3afa2-…` once:

```sql
SELECT id, active, daily_caps FROM sessions WHERE id='linkedin_1'
...
AND ($1 = 'c7b3afa2-b8e6-4c18-a8a1-0e870f895abd')
```

A browser whose clientId did not match was answered "no job" rather than an
error. That is not hypothetical: on 2026-11-02 the panel's *Regen* button
issued a new clientId and 26 jobs sat frozen for 3h30 with nothing in any log
saying why.

## What changed

`sessions` gained a `client_id uuid` column with a partial unique index, so a
clientId cannot be claimed by two sessions. The governor resolves the session
instead of asserting it:

```sql
SELECT id, active, daily_caps FROM sessions WHERE client_id = NULLIF($1,'')::uuid
```

Every other `'linkedin_1'` became `(SELECT id FROM sess)`. An unknown clientId
yields an empty `sess`, so `j.session_id = NULL` matches nothing and the safe
behaviour is unchanged. `Shape task` now carries `sessionId` through so
`log (feeder)` records which session did the work rather than assuming.

## What was already per-session, and needs nothing

These were written against `session_id` from the start, so they scale to N
sessions untouched:

- the 15-minute lock mutex — sessions do not block each other;
- the 360–600 s gap between two jobs — each session has its own timer;
- `daily_caps`, keyed by `(session_id, day, kind)`;
- `sessions.daily_caps` and `sessions.active`, already per row.

## What still collides

**Job creation.** Whatever enqueues jobs stamps `session_id` itself. Nothing
binds an initiative to a session yet, so partitioning lives at insert time.
A `session_initiatives(session_id, initiative_id)` join table is the natural
home because the mapping is many-to-many: wordpress is meant to be worked by
two people.

**Deduplication.** `signals.pk` is globally unique and insert-ignored: the
first initiative to find a post keeps it, the second insert is discarded.
Two sessions pointed at the same keyword therefore duplicate each other's
work and spend two accounts' exposure for one set of rows. The agreed design
is one keyword per session, so this stays a constraint to respect rather than
a problem to solve.

**Attribution.** `signals` records `initiative_id` but no session. If an
account gets rate-limited there is no way to ask what that account scraped.

**Aggregate exposure.** The gap and the caps bound each session separately.
Two sessions in the same 8–20 window double the traffic LinkedIn sees in that
window. If both accounts share an IP or a persona, the correlation is visible
even though each one looks well-behaved on its own.

**Writes.** A comment is public and signed by a real person, so a write must
never be served to whichever session happens to be free. Keep `write_*` jobs
stamped with the single voice session at insert time; the governor needs no
change for this, since it already serves by `jobs.session_id`.

**The shared bridge token.** One token for every install means a session
cannot be revoked on its own.

## Throughput, measured

Ratios on 2026-11-02: 1 120 `qualify_post` verdicts produced 44
`need_identified`, or **3.9 %**.

Three searches were run back to back the same evening to measure the rest:

| keyword | posts | duration | served after |
|---|---|---|---|
| wordpress | 71 | 61 s | 0 min |
| woocommerce | 64 | 61 s | 9 min |
| shopify | 69 | 61 s | 19 min |

All three ran a second time against a window already searched earlier that
day, and **added zero duplicates** — the day's per-keyword totals are exactly
the sum of both runs. A repeat search on the same `past-24h` query is
therefore worth close to a fresh one.

Every job took 61 s, well under the 75 s budget, so `maxSteps: 30` is what
bounds the yield, not `budgetMs`. There is room to scroll deeper.

Per session the physics are a 360–600 s gap (mean 8 min, observed 9 and 10)
inside a 12-hour window, so **90 job slots/day**, shared between searches and
the profile scrapes their results generate.

| | searches/day | posts/day | qualified/day | binding limit |
|---|---|---|---|---|
| current caps | 15 | 1 000 | ~39 | `post` cap, spent in ~2 h |
| one session, caps raised | 25 | ~1 650 | ~64 | the 8-minute gap |
| 4 sessions, one keyword each | 4 × 15 | 4 000 | ~156 | `post` cap per session |

At 68 posts a search the 1 000/day cap is exhausted inside two hours of a
twelve-hour window, so raising it is the cheapest lever before adding an
account. Beyond ~64 qualified a day on a single session, only a second
session helps: shortening the gap is the one knob that trades directly
against account safety.
