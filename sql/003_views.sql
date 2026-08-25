-- Rolling per-bucket performance over a user's last 400 attempts.
--
-- security_invoker means the view is evaluated with the caller's permissions,
-- so the RLS policy on attempts still applies. Without it a view owned by
-- postgres would happily hand one user another user's rows.
create or replace view public.v_bucket_stats
with (security_invoker = true) as
with recent as (
  select *, row_number() over (partition by user_id order by created_at desc) as rn
  from public.attempts
  where op is not null
)
select
  user_id, op, band,
  count(*)                                               as seen,
  sum(case when is_correct then 1 else 0 end)            as correct,
  round(avg(elapsed_ms))                                 as avg_ms,
  percentile_cont(0.5) within group (order by elapsed_ms) as median_ms
from recent
where rn <= 400
group by user_id, op, band;

-- Windowed variant used for the trend calculation: the most recent 100
-- attempts versus the 200 before them. A trend from a single window is just
-- the level again, dressed up.
create or replace view public.v_bucket_trend
with (security_invoker = true) as
with ranked as (
  select *, row_number() over (partition by user_id order by created_at desc) as rn
  from public.attempts
  where op is not null
)
select
  user_id, op, band,
  case when rn <= 100 then 'recent' else 'prior' end     as window,
  count(*)                                               as seen,
  sum(case when is_correct then 1 else 0 end)            as correct,
  percentile_cont(0.5) within group (order by elapsed_ms) as median_ms
from ranked
where rn <= 300
group by user_id, op, band, case when rn <= 100 then 'recent' else 'prior' end;

-- Mastery check: the last 10 attempts in a bucket.
create or replace view public.v_bucket_recent10
with (security_invoker = true) as
with ranked as (
  select *,
         row_number() over (partition by user_id, op, band order by created_at desc) as rn
  from public.attempts
  where op is not null
)
select
  user_id, op, band,
  count(*)                                               as seen,
  sum(case when is_correct then 1 else 0 end)            as correct,
  percentile_cont(0.5) within group (order by elapsed_ms) as median_ms
from ranked
where rn <= 10
group by user_id, op, band;

-- Today's run count, for the free-run cap. Daily challenge and drills do not
-- consume a free run: the daily is the growth loop and drills are what Pro
-- users pay for, so neither should ever be rationed by this counter.
create or replace view public.v_runs_today
with (security_invoker = true) as
select user_id, count(*) as runs_used
from public.runs
where created_at >= date_trunc('day', now() at time zone 'utc')
  and is_daily = false
  and game not in ('drill', 'import')
group by user_id;

grant select on public.v_bucket_stats, public.v_bucket_trend,
               public.v_bucket_recent10, public.v_runs_today
  to authenticated, service_role;
