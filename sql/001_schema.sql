-- MindSharp schema. Run in order: 001 → 002 → 003 (→ 004 in dev only).
-- Safe to re-run: everything is guarded.

-- ============ profiles ============
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists profiles_email_idx on public.profiles (lower(email));

-- Every new auth user gets a profile and a free entitlement row immediately,
-- so a webhook that arrives before the client ever calls /api/me still has a
-- row to match on.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;

  insert into public.entitlements (user_id, plan, status)
  values (new.id, 'free', 'none')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ============ entitlements ============
-- One row per user. Server-owned. The client may READ its own row and never write it.
do $$ begin
  create type plan_type as enum ('free','monthly','yearly','lifetime','comp');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_status as enum ('active','cancelled','expired','past_due','refunded','none');
exception when duplicate_object then null; end $$;

create table if not exists public.entitlements (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  plan                 plan_type   not null default 'free',
  status               plan_status not null default 'none',
  source               text,                -- 'lemonsqueezy' | 'licence' | 'manual'
  ls_customer_id       text,
  ls_subscription_id   text unique,
  ls_order_id          text,
  ls_variant_id        text,
  licence_key          text unique,
  current_period_end   timestamptz,         -- null for lifetime
  cancel_at_period_end boolean not null default false,
  updated_at           timestamptz not null default now()
);
create index if not exists entitlements_ls_customer_idx on public.entitlements (ls_customer_id);

-- Attach the trigger only once entitlements exists (handle_new_user writes to it).
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ runs ============
create table if not exists public.runs (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  game         text not null,              -- blitz|survival|verify|operator|target|recall|matrix|mrush|mzen|zen|daily|drill|import
  difficulty   text not null,
  score        integer not null,
  solved       integer not null,
  correct      integer not null,
  wrong        integer not null,
  best_streak  integer not null,
  duration_ms  integer not null,
  is_daily     boolean not null default false,
  daily_date   date,
  drill_id     bigint,
  client_ts    timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists runs_user_created_idx on public.runs (user_id, created_at desc);
create index if not exists runs_user_game_created_idx on public.runs (user_id, game, created_at desc);
create unique index if not exists runs_one_daily_per_user_per_day
  on public.runs (user_id, daily_date) where is_daily;

-- ============ attempts ============
-- The dataset the entire Pro value prop rests on. One row per problem answered.
create table if not exists public.attempts (
  id          bigserial primary key,
  run_id      bigint not null references public.runs(id) on delete cascade,
  user_id     uuid   not null references auth.users(id) on delete cascade,
  kind        text   not null,             -- pad|tf|ops|chips|recall|grid
  op          char(1),                     -- + - * /   (null for recall)
  operand_a   integer,
  operand_b   integer,
  answer      integer,
  given       integer,                     -- what the user entered; null on timeout
  is_correct  boolean not null,
  timed_out   boolean not null default false,
  elapsed_ms  integer not null,
  difficulty  text not null,
  band        smallint not null,           -- magnitude bucket, see spec §7
  created_at  timestamptz not null default now()
);
create index if not exists attempts_user_created_idx on public.attempts (user_id, created_at desc);
create index if not exists attempts_user_bucket_idx on public.attempts (user_id, op, band, created_at desc);

-- ============ drills ============
create table if not exists public.drills (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  buckets      jsonb not null,             -- the targeted buckets + their pre-drill scores
  problems     jsonb not null,             -- the generated set, so results are comparable
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists drills_user_created_idx on public.drills (user_id, created_at desc);

-- runs.drill_id points at drills.id. Declared after both tables exist.
do $$ begin
  alter table public.runs
    add constraint runs_drill_id_fkey
    foreign key (drill_id) references public.drills(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ============ daily leaderboard ============
create table if not exists public.daily_scores (
  daily_date date not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  score      integer not null,
  grid       text not null,
  created_at timestamptz not null default now(),
  primary key (daily_date, user_id)
);
create index if not exists daily_scores_board_idx on public.daily_scores (daily_date, score desc);

-- ============ webhook idempotency ============
create table if not exists public.webhook_events (
  id           text primary key,           -- LS event id
  event_name   text not null,
  payload      jsonb not null,
  processed_at timestamptz not null default now(),
  -- Set when an event could not be attributed to a user. Never drop a paid
  -- event silently: that is a person who gave you money and got nothing.
  unresolved   boolean not null default false,
  resolve_note text
);
create index if not exists webhook_events_unresolved_idx
  on public.webhook_events (processed_at desc) where unresolved;

-- ============ rate limiting ============
-- Small counter table so /api/licence/validate survives a restart. Serverless
-- functions have no shared memory; an in-process limiter resets on every cold
-- start, which is exactly when a brute-forcer benefits.
create table if not exists public.rate_limits (
  bucket     text primary key,             -- e.g. 'licence:203.0.113.9'
  count      integer not null default 0,
  window_start timestamptz not null default now()
);

create or replace function public.bump_rate_limit(
  p_bucket text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_start timestamptz;
begin
  insert into public.rate_limits (bucket, count, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set count = case
          when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
          then 1 else public.rate_limits.count + 1 end,
        window_start = case
          when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
          then now() else public.rate_limits.window_start end
  returning count, window_start into v_count, v_start;

  return v_count <= p_limit;   -- true = allowed
end;
$$;

-- ============ transactional run + attempts insert ============
-- One call, one transaction. A run whose attempts half-inserted would corrupt
-- the exact dataset the weakness engine reads.
create or replace function public.insert_run_with_attempts(
  p_user_id uuid, p_run jsonb, p_attempts jsonb
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id bigint;
begin
  insert into public.runs (
    user_id, game, difficulty, score, solved, correct, wrong,
    best_streak, duration_ms, is_daily, daily_date, drill_id, client_ts
  ) values (
    p_user_id,
    p_run->>'game',
    p_run->>'difficulty',
    (p_run->>'score')::int,
    (p_run->>'solved')::int,
    (p_run->>'correct')::int,
    (p_run->>'wrong')::int,
    (p_run->>'best_streak')::int,
    (p_run->>'duration_ms')::int,
    coalesce((p_run->>'is_daily')::boolean, false),
    nullif(p_run->>'daily_date','')::date,
    nullif(p_run->>'drill_id','')::bigint,
    nullif(p_run->>'client_ts','')::timestamptz
  )
  returning id into v_run_id;

  if jsonb_array_length(coalesce(p_attempts, '[]'::jsonb)) > 0 then
    insert into public.attempts (
      run_id, user_id, kind, op, operand_a, operand_b, answer, given,
      is_correct, timed_out, elapsed_ms, difficulty, band
    )
    select
      v_run_id,
      p_user_id,
      a->>'kind',
      nullif(a->>'op','')::char(1),
      nullif(a->>'operand_a','')::int,
      nullif(a->>'operand_b','')::int,
      nullif(a->>'answer','')::int,
      nullif(a->>'given','')::int,
      (a->>'is_correct')::boolean,
      coalesce((a->>'timed_out')::boolean, false),
      (a->>'elapsed_ms')::int,
      a->>'difficulty',
      (a->>'band')::smallint
    from jsonb_array_elements(p_attempts) as a;
  end if;

  return v_run_id;
end;
$$;
