# linkedin orchestrator — state before the write branch

Workflow `glff1mdIo2uujHU6`, captured 2026-11-02 17:09 Paris, immediately
before adding a branch that lets the queue carry write actions. Paste these
two node bodies back verbatim to undo it.

## Governor: peek+lock — original query

```sql
WITH sess AS (
  SELECT id, active, daily_caps FROM sessions WHERE id='linkedin_1'
),
lastserved AS (
  SELECT max(locked_at) AS t FROM jobs WHERE session_id='linkedin_1' AND locked_at IS NOT NULL
),
gapcfg AS (
  SELECT (360 + floor(random()*240))::int AS threshold_s
),
eligible AS (
  SELECT q.* FROM (
    SELECT j.id, j.url, j.step_key, j.priority, j.created_at,
           i.active_timezone AS tz, i.active_hours_start AS h0, i.active_hours_end AS h1, i.schedule_days AS days,
           CASE j.step_key
             WHEN 'get_post' THEN 'post'
             WHEN 'get_profile' THEN 'profile'
             WHEN 'get_company' THEN 'company'
             WHEN 'get_people_from_company' THEN 'company'
             WHEN 'get_comments' THEN 'comment'
             WHEN 'get_jobs' THEN 'job'
             ELSE 'other' END AS cap_kind
      FROM jobs j
      JOIN initiatives i ON i.id=j.initiative_id
     WHERE j.session_id='linkedin_1'
       AND j.status='pending'
       AND (j.scheduled_at IS NULL OR j.scheduled_at<=now())
       AND i.status='active'
  ) q
  WHERE (SELECT active FROM sess)=true
    AND ($1 = 'c7b3afa2-b8e6-4c18-a8a1-0e870f895abd')
    AND NOT EXISTS (SELECT 1 FROM jobs m WHERE m.session_id='linkedin_1' AND m.status='locked' AND m.locked_at > now()-interval '15 minutes')
    AND EXTRACT(hour FROM (now() AT TIME ZONE q.tz)) >= q.h0
    AND EXTRACT(hour FROM (now() AT TIME ZONE q.tz)) < q.h1
    AND (q.days IS NULL OR trim(to_char((now() AT TIME ZONE q.tz),'dy')) = ANY(q.days))
    AND ((SELECT t FROM lastserved) IS NULL OR now()-(SELECT t FROM lastserved) >= make_interval(secs => (SELECT threshold_s FROM gapcfg)))
    AND COALESCE((SELECT dc.count FROM daily_caps dc WHERE dc.session_id='linkedin_1' AND dc.day=(now() AT TIME ZONE 'Europe/Paris')::date AND dc.kind=q.cap_kind),0)
        < COALESCE((SELECT (daily_caps->>q.cap_kind)::int FROM sess),999999)
  ORDER BY q.priority ASC, q.created_at ASC
  LIMIT 1
),
locked AS (
  UPDATE jobs SET status='locked', locked_at=now()
   WHERE id=(SELECT id FROM eligible) AND status='pending'
  RETURNING id, url, step_key
)
SELECT l.id::text AS task_id, l.url, l.step_key
  FROM (SELECT 1) _ LEFT JOIN locked l ON true
```

## Shape task — original jsCode

```js
const KIND = {
  get_post: 'linkedin.posts',
  get_profile: 'linkedin.profile',
  get_company: 'linkedin.company',
  get_comments: 'linkedin.comments',
  get_people_from_company: 'linkedin.peopleCompany',
  get_jobs: 'linkedin.jobs'
};
const r = ($input.first() || {}).json || {};
if (!r.task_id) return [{ json: {} }];
const params = { url: r.url, kind: KIND[r.step_key] || r.step_key, active: true };
return [{ json: {
  taskId: r.task_id,
  type: 'social_extract',
  params
}}];
```

## Outcome

The write branch was exercised end to end on 2026-11-02 at 17:32 Paris:
a `write_comment_post` job was served as `linkedin_comment_post`, executed,
and came back `done` in 16 seconds. The branch is left in place — it is the
only way to drive a write action without touching the extension by hand.

The temporary probe workflow used to enqueue it (`TEMP schema probe`) has
been deleted. To enqueue another write action:

```sql
INSERT INTO jobs (session_id, initiative_id, step_key, url, priority, input_data, status)
VALUES ('linkedin_1', '<an active initiative uuid>', 'write_comment_post',
        '<post url>', 1, '{"text": "…", "dryRun": false}'::jsonb, 'pending');
```

`priority` must satisfy `jobs_priority_check`; 1 is accepted and jumps ahead
of the extraction backlog, which sits at 3.
