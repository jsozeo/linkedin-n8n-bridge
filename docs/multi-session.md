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
Two sessions pointed at the same keyword with the same query therefore
duplicate each other's work and spend two accounts' exposure for one set of
rows. A shared keyword only pays if the two sessions see different slices —
different date window, geography, or sort order.

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
`need_identified`, or **3.9 %**. A `get_post` job returned 15.7 items on
average over 7 days, and 68 on the first run with the deeper scroll.

Per session the physics are a 360–600 s gap (mean 8 min) inside a 12-hour
window, so **90 jobs/day**, shared between searches and the profile scrapes
their results generate.

| | searches/day | posts/day | qualified/day | binding limit |
|---|---|---|---|---|
| today's rate | ~3 | 186 | ~7 | nothing — the scheduler enqueues too little |
| current caps | 15 | 1 000 | ~39 | `post` cap of 1 000 |
| one session, caps raised | 24 | ~1 630 | ~64 | the 8-minute gap |

Beyond roughly **64 qualified posts a day** a second session is the only
lever left, because shortening the gap is the one thing that trades directly
against account safety. Each added session brings another ~64.
