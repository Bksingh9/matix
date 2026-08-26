-- Retention systems: XP, levels, streaks, achievements, leagues.
-- Run after 001-003. Safe to re-run.

-- ============ player_progress ============
-- One row per player. Server-owned in the sense that only /api/runs writes it,
-- but readable by its owner so the client can render without a second call.
create table if not exists public.player_progress (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  xp             integer not null default 0,
  level          integer not null default 1,
  day_streak     integer not null default 0,
  longest_streak integer not null default 0,
  streak_freezes integer not null default 0,
  days_played    integer not null default 0,
  last_day       date,
  -- Denormalised counters for the achievement predicates. Recomputing these
  -- from attempts on every run would mean scanning a player's whole history
  -- to award a 100-problem badge.
  total_solved      integer not null default 0,
  total_correct     integer not null default 0,
  best_run_streak   integer not null default 0,
  perfect_runs      integer not null default 0,
  sub_two_sec_runs  integer not null default 0,
  dailies_done      integer not null default 0,
  perfect_dailies   integer not null default 0,
  drills_done       integer not null default 0,
  zen_solved        integer not null default 0,
  best_survival     integer not null default 0,
  best_recall_digits integer not null default 0,
  modes_played      text[] not null default '{}',
  updated_at     timestamptz not null default now()
);

-- ============ achievements ============
create table if not exists public.achievements (
  user_id     uuid not null references auth.users(id) on delete cascade,
  code        text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, code)
);
create index if not exists achievements_user_idx on public.achievements (user_id, unlocked_at desc);

-- ============ leagues ============
-- A weekly window players are ranked within. Groups are capped so a
-- leaderboard is always a readable list rather than a scroll into the void.
create table if not exists public.league_seasons (
  id         bigserial primary key,
  starts_on  date not null unique,
  ends_on    date not null
);

create table if not exists public.league_groups (
  id        bigserial primary key,
  season_id bigint not null references public.league_seasons(id) on delete cascade,
  tier      smallint not null default 1,     -- 1 = bronze .. 5 = diamond
  created_at timestamptz not null default now()
);
create index if not exists league_groups_season_idx on public.league_groups (season_id, tier);

create table if not exists public.league_members (
  group_id  bigint not null references public.league_groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  xp        integer not null default 0,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create unique index if not exists league_members_one_group_per_season
  on public.league_members (user_id, group_id);
create index if not exists league_members_board_idx on public.league_members (group_id, xp desc);

-- Which tier a player carries into next week. Separate from membership so a
-- promotion survives a week off.
create table if not exists public.league_standing (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  tier        smallint not null default 1,
  last_result text,                            -- 'promoted' | 'held' | 'relegated'
  updated_at  timestamptz not null default now()
);

-- ============ display names ============
-- Needed before a leaderboard can show anything but a UUID. Nullable: a player
-- who never sets one shows as "Player 4821" rather than being forced to.
alter table public.profiles add column if not exists handle text;
create unique index if not exists profiles_handle_unique on public.profiles (lower(handle)) where handle is not null;

-- ============ RLS ============
alter table public.player_progress enable row level security;
alter table public.achievements    enable row level security;
alter table public.league_seasons  enable row level security;
alter table public.league_groups   enable row level security;
alter table public.league_members  enable row level security;
alter table public.league_standing enable row level security;

drop policy if exists "own progress r"    on public.player_progress;
drop policy if exists "own achievements r" on public.achievements;
drop policy if exists "seasons readable"  on public.league_seasons;
drop policy if exists "groups readable"   on public.league_groups;
drop policy if exists "members readable"  on public.league_members;
drop policy if exists "own standing r"    on public.league_standing;

-- Read your own; the service role writes. Same shape as entitlements: a client
-- that could write its own XP could award itself a level 60 badge, and every
-- leaderboard would be fiction.
create policy "own progress r"     on public.player_progress for select using (auth.uid() = user_id);
create policy "own achievements r" on public.achievements    for select using (auth.uid() = user_id);
create policy "own standing r"     on public.league_standing for select using (auth.uid() = user_id);

-- Leaderboards are public by nature; membership rows carry no private data
-- beyond a user id and an XP total.
create policy "seasons readable" on public.league_seasons for select using (true);
create policy "groups readable"  on public.league_groups  for select using (true);
create policy "members readable" on public.league_members for select using (true);

-- ============ the current season ============
-- Weeks start Monday, in UTC. A player's "week" has to be the same week as
-- everyone else's or the leaderboard is meaningless.
create or replace function public.current_season()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := (date_trunc('week', now() at time zone 'utc'))::date;
  v_id    bigint;
begin
  select id into v_id from public.league_seasons where starts_on = v_start;
  if v_id is null then
    insert into public.league_seasons (starts_on, ends_on)
    values (v_start, v_start + 6)
    on conflict (starts_on) do update set ends_on = excluded.ends_on
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- ============ join or find a league group ============
-- Places a player into a group in their tier that has room, creating one when
-- every group is full. Groups fill to LEAGUE_SIZE before a new one opens, so
-- a small player base produces one busy league rather than thirty empty ones.
create or replace function public.join_league(p_user_id uuid, p_size integer default 30)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season bigint := public.current_season();
  v_tier   smallint;
  v_group  bigint;
begin
  select coalesce(tier, 1) into v_tier from public.league_standing where user_id = p_user_id;
  if v_tier is null then v_tier := 1; end if;

  -- already in a group this season?
  select lm.group_id into v_group
  from public.league_members lm
  join public.league_groups lg on lg.id = lm.group_id
  where lm.user_id = p_user_id and lg.season_id = v_season
  limit 1;
  if v_group is not null then return v_group; end if;

  -- the fullest group in this tier that still has room, so groups complete
  -- rather than scattering players thinly across many
  select lg.id into v_group
  from public.league_groups lg
  left join public.league_members lm on lm.group_id = lg.id
  where lg.season_id = v_season and lg.tier = v_tier
  group by lg.id
  having count(lm.user_id) < p_size
  order by count(lm.user_id) desc
  limit 1;

  if v_group is null then
    insert into public.league_groups (season_id, tier) values (v_season, v_tier)
    returning id into v_group;
  end if;

  insert into public.league_members (group_id, user_id, xp)
  values (v_group, p_user_id, 0)
  on conflict (group_id, user_id) do nothing;

  return v_group;
end;
$$;

-- ============ add this week's XP to the league ============
create or replace function public.add_league_xp(p_user_id uuid, p_xp integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group bigint;
begin
  if p_xp is null or p_xp <= 0 then return; end if;
  v_group := public.join_league(p_user_id);
  update public.league_members
     set xp = xp + p_xp
   where group_id = v_group and user_id = p_user_id;
end;
$$;

-- ============ settle a finished season ============
-- Top 5 promote, bottom 5 relegate, the rest hold. Run once per week by a
-- scheduled job (pg_cron, or a Vercel cron hitting /api/leagues/settle).
create or replace function public.settle_season(p_season_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with ranked as (
    select lm.user_id, lg.tier,
           row_number() over (partition by lg.id order by lm.xp desc, lm.joined_at asc) as rank,
           count(*) over (partition by lg.id) as group_size,
           lm.xp
    from public.league_members lm
    join public.league_groups lg on lg.id = lm.group_id
    where lg.season_id = p_season_id
  ),
  outcome as (
    select user_id,
           case
             -- A group too small to have a meaningful bottom is not relegated
             -- from: finishing last in a group of four is not a result.
             when rank <= 5 and group_size >= 10 then least(5, tier + 1)
             when rank > group_size - 5 and group_size >= 10 and xp = 0 then greatest(1, tier - 1)
             else tier
           end as new_tier,
           case
             when rank <= 5 and group_size >= 10 then 'promoted'
             when rank > group_size - 5 and group_size >= 10 and xp = 0 then 'relegated'
             else 'held'
           end as result
    from ranked
  )
  insert into public.league_standing (user_id, tier, last_result, updated_at)
  select user_id, new_tier, result, now() from outcome
  on conflict (user_id) do update
    set tier = excluded.tier, last_result = excluded.last_result, updated_at = now();

  select count(*) into v_count from public.league_members lm
  join public.league_groups lg on lg.id = lm.group_id where lg.season_id = p_season_id;
  return v_count;
end;
$$;

revoke all on function public.current_season() from public, anon, authenticated;
revoke all on function public.join_league(uuid, integer) from public, anon, authenticated;
revoke all on function public.add_league_xp(uuid, integer) from public, anon, authenticated;
revoke all on function public.settle_season(bigint) from public, anon, authenticated;
grant execute on function public.current_season() to service_role;
grant execute on function public.join_league(uuid, integer) to service_role;
grant execute on function public.add_league_xp(uuid, integer) to service_role;
grant execute on function public.settle_season(bigint) to service_role;

-- ============ leaderboard views ============
-- A handle, never an email: a leaderboard that leaks addresses is a data
-- breach with a scoreboard on top.
create or replace view public.v_daily_leaderboard
with (security_invoker = true) as
select
  ds.daily_date,
  ds.user_id,
  coalesce(p.handle, 'Player ' || right(ds.user_id::text, 4)) as handle,
  ds.score,
  ds.grid,
  row_number() over (partition by ds.daily_date order by ds.score desc, ds.created_at asc) as rank
from public.daily_scores ds
left join public.profiles p on p.id = ds.user_id;

grant select on public.v_daily_leaderboard to anon, authenticated, service_role;
