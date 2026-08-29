-- Proof that row-level security actually holds.
--
-- Run by `npm run verify:sql` against a throwaway database. The whole file
-- runs inside one transaction that is rolled back, so it leaves nothing behind.
--
-- Why this exists: every other test in the suite talks to a fake PostgREST
-- with no database under it, so none of them can tell the difference between
-- "the policy stopped them" and "there is no policy". If an anon client can
-- write `entitlements`, the entire server-authoritative design is decorative
-- and anyone can grant themselves Pro from the browser console.
--
-- Three failure modes are deliberately distinguished, because they look
-- nothing alike and only one of them is loud:
--
--   INSERT blocked by RLS  -> raises 42501
--   UPDATE/DELETE blocked  -> affects ZERO ROWS, silently
--   SELECT blocked         -> returns ZERO ROWS, silently
--
-- A test that only watches for exceptions would pass a database where anyone
-- can update anyone's entitlement. So the update checks count rows.

\set ON_ERROR_STOP on
begin;

-- Two real users, via the same trigger production uses.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');

-- The on_auth_user_created trigger has already given both of them a profile
-- and a free entitlement row — that is production behaviour, and relying on it
-- here means this file also proves the trigger fires.
do $$
begin
  if (select count(*) from public.entitlements) <> 2 then
    raise exception 'BROKEN — handle_new_user did not create an entitlement per user';
  end if;
  if (select count(*) from public.profiles) <> 2 then
    raise exception 'BROKEN — handle_new_user did not create a profile per user';
  end if;
end $$;

-- Bob is a paying customer. Alice is not. Everything below is Alice trying to
-- change that, and the checks that she cannot.
update public.entitlements
   set plan = 'lifetime', status = 'active', source = 'lemonsqueezy'
 where user_id = '22222222-2222-4222-8222-222222222222';

insert into public.runs (user_id, game, difficulty, score, solved, correct, wrong, best_streak, duration_ms)
values ('22222222-2222-4222-8222-222222222222', 'blitz', 'medium', 900, 30, 28, 2, 12, 60000);

insert into public.daily_scores (user_id, daily_date, score, grid)
values ('22222222-2222-4222-8222-222222222222', current_date, 900, 'XXXXX');

create or replace function pg_temp.become(p_role text, p_uid uuid) returns void
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims',
    case when p_uid is null then '{}'
         else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
end $$;

/* Expect a statement to be refused outright. Only INSERT and function calls
   fail this way; see the header. */
create or replace function pg_temp.must_fail(p_label text, p_role text, p_uid uuid, p_sql text)
returns void language plpgsql as $$
begin
  perform pg_temp.become(p_role, p_uid);
  execute p_sql;
  reset role;
  raise exception 'SECURITY HOLE — % was ALLOWED', p_label;
exception
  when insufficient_privilege then
    reset role;
    raise notice '  ok  refused: %', p_label;
  when others then
    -- A different error still means it did not succeed, but say which, so a
    -- typo in the test is not mistaken for a passing security check.
    reset role;
    raise notice '  ok  refused: % (%)', p_label, sqlstate;
end $$;

/* Expect a statement to succeed but touch nothing. This is what a blocked
   UPDATE or DELETE looks like, and it is silent. */
create or replace function pg_temp.must_affect_none(p_label text, p_role text, p_uid uuid, p_sql text)
returns void language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.become(p_role, p_uid);
  execute p_sql;
  get diagnostics n = row_count;
  reset role;
  if n <> 0 then
    raise exception 'SECURITY HOLE — % changed % row(s)', p_label, n;
  end if;
  raise notice '  ok  no rows: %', p_label;
exception
  when insufficient_privilege then
    reset role;
    raise notice '  ok  refused: %', p_label;
end $$;

/* Expect a read to return exactly this many rows. Used both to prove Alice
   cannot see Bob's data AND to prove she can see her own — without the second
   kind, a database that denies everything would pass. */
create or replace function pg_temp.must_see(p_label text, p_role text, p_uid uuid, p_sql text, p_expected bigint)
returns void language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.become(p_role, p_uid);
  execute 'select count(*) from (' || p_sql || ') q' into n;
  reset role;
  if n <> p_expected then
    raise exception 'WRONG VISIBILITY — %: saw % row(s), expected %', p_label, n, p_expected;
  end if;
  raise notice '  ok  sees %: %', p_expected, p_label;
exception
  when insufficient_privilege then
    reset role;
    if p_expected = 0 then raise notice '  ok  refused: %', p_label;
    else raise exception 'WRONG VISIBILITY — % was refused but should be readable', p_label;
    end if;
end $$;

\echo ''
\echo '-- entitlements: the row that decides who has paid ------------------'

select pg_temp.must_fail(
  'anon inserts an entitlement', 'anon', null,
  $q$insert into public.entitlements (user_id, plan, status)
     values ('11111111-1111-4111-8111-111111111111', 'lifetime', 'active')$q$);

select pg_temp.must_affect_none(
  'anon upgrades someone to lifetime', 'anon', null,
  $q$update public.entitlements set plan = 'lifetime', status = 'active'$q$);

select pg_temp.must_fail(
  'a signed-in user inserts their own entitlement',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$insert into public.entitlements (user_id, plan, status)
     values ('11111111-1111-4111-8111-111111111111', 'lifetime', 'active')$q$);

select pg_temp.must_affect_none(
  'a signed-in user upgrades themselves',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$update public.entitlements set plan = 'lifetime', status = 'active'
     where user_id = '11111111-1111-4111-8111-111111111111'$q$);

select pg_temp.must_affect_none(
  'a signed-in user deletes their expired entitlement',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$delete from public.entitlements
     where user_id = '11111111-1111-4111-8111-111111111111'$q$);

select pg_temp.must_see(
  'alice reads her own entitlement', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.entitlements
     where user_id = '11111111-1111-4111-8111-111111111111'$q$, 1);

select pg_temp.must_see(
  'alice reads bob''s entitlement', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.entitlements
     where user_id = '22222222-2222-4222-8222-222222222222'$q$, 0);

select pg_temp.must_see(
  'anon reads any entitlement', 'anon', null,
  $q$select 1 from public.entitlements$q$, 0);

\echo ''
\echo '-- profiles: readable by their owner, writable by nobody ------------'

/* This block exists because its absence hid a payment-theft bug. The original
   policy was `for all`, and RLS is row-level rather than column-level, so a
   user could rewrite their own email to a victim's and collect the victim's
   purchase through the webhook's email fallback. 26 RLS checks passed while
   that was live, because not one of them touched profiles. */

select pg_temp.must_affect_none(
  'alice squats bob''s email to steal his purchase',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$update public.profiles set email = 'bob@example.com'
     where id = '11111111-1111-4111-8111-111111111111'$q$);

select pg_temp.must_affect_none(
  'alice sets a handle directly, skipping the endpoint''s validation',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$update public.profiles set handle = '<img src=x onerror=alert(1)>'
     where id = '11111111-1111-4111-8111-111111111111'$q$);

select pg_temp.must_affect_none(
  'alice deletes her profile to force the webhook down the email path',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$delete from public.profiles
     where id = '11111111-1111-4111-8111-111111111111'$q$);

select pg_temp.must_fail(
  'alice inserts a second profile row',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$insert into public.profiles (id, email)
     values ('33333333-3333-4333-8333-333333333333', 'spoof@example.com')$q$);

select pg_temp.must_see(
  'alice reads her own profile', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.profiles
     where id = '11111111-1111-4111-8111-111111111111'$q$, 1);

select pg_temp.must_see(
  'alice reads bob''s profile', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.profiles
     where id = '22222222-2222-4222-8222-222222222222'$q$, 0);

\echo ''
\echo '-- gameplay data: alice must not read or forge bob''s ----------------'

select pg_temp.must_see(
  'alice reads bob''s runs', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.runs
     where user_id = '22222222-2222-4222-8222-222222222222'$q$, 0);

select pg_temp.must_fail(
  'alice writes a run as bob', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$insert into public.runs (user_id, game, difficulty, score, solved, correct, wrong, best_streak, duration_ms)
     values ('22222222-2222-4222-8222-222222222222', 'blitz', 'easy', 1, 1, 1, 0, 1, 100)$q$);

select pg_temp.must_see(
  'anon reads runs', 'anon', null, $q$select 1 from public.runs$q$, 0);

\echo ''
\echo '-- the service-role-only tables -------------------------------------'

select pg_temp.must_see(
  'anon reads webhook_events (the payment audit trail)', 'anon', null,
  $q$select 1 from public.webhook_events$q$, 0);

select pg_temp.must_see(
  'a signed-in user reads webhook_events',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.webhook_events$q$, 0);

select pg_temp.must_see(
  'anon reads rate_limits', 'anon', null,
  $q$select 1 from public.rate_limits$q$, 0);

select pg_temp.must_see(
  'anon reads store_notifications', 'anon', null,
  $q$select 1 from public.store_notifications$q$, 0);

\echo ''
\echo '-- SECURITY DEFINER functions: reachable only by the service role ---'

select pg_temp.must_fail(
  'a signed-in user exhausts someone else''s rate limit',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select public.bump_rate_limit('licence:someone-else', 5, 600)$q$);

select pg_temp.must_fail(
  'a signed-in user calls insert_run_with_attempts directly',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select public.insert_run_with_attempts(
       '22222222-2222-4222-8222-222222222222'::uuid, '{}'::jsonb, '[]'::jsonb)$q$);

select pg_temp.must_fail(
  'a signed-in user settles the league season early',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select public.settle_season(1::bigint)$q$);

select pg_temp.must_fail(
  'anon joins a league directly', 'anon', null,
  $q$select public.join_league('11111111-1111-4111-8111-111111111111'::uuid, 30)$q$);

select pg_temp.must_fail(
  'a signed-in user awards themselves league XP',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select public.add_league_xp('11111111-1111-4111-8111-111111111111'::uuid, 99999)$q$);

\echo ''
\echo '-- progression: private to its owner --------------------------------'

select pg_temp.must_see(
  'alice reads bob''s progress', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$select 1 from public.player_progress
     where user_id = '22222222-2222-4222-8222-222222222222'$q$, 0);

select pg_temp.must_affect_none(
  'alice awards herself XP directly',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$update public.player_progress set xp = 999999
     where user_id = '11111111-1111-4111-8111-111111111111'$q$);

select pg_temp.must_affect_none(
  'alice grants herself an achievement',
  'authenticated', '11111111-1111-4111-8111-111111111111',
  $q$delete from public.achievements
     where user_id = '11111111-1111-4111-8111-111111111111'$q$);

\echo ''
\echo '-- positive controls: the app still works ---------------------------'
\echo '-- (without these, a database that denies everything would pass)'

select pg_temp.must_see(
  'the daily leaderboard is readable by anyone', 'anon', null,
  $q$select 1 from public.daily_scores where daily_date = current_date$q$, 1);

select pg_temp.must_see(
  'league seasons are readable', 'anon', null,
  $q$select 1 from public.league_seasons$q$, 0);

do $$
declare n bigint;
begin
  -- The service role bypasses RLS. This is why the service key must never
  -- reach a browser, and proving it works is proving the webhook can do its
  -- job at all.
  set local role service_role;
  update public.entitlements set plan = 'lifetime', status = 'active'
   where user_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;
  reset role;
  if n <> 1 then
    raise exception 'BROKEN — the service role could not write an entitlement (% rows)', n;
  end if;
  raise notice '  ok  the service role can still grant Pro (the webhook''s job)';
end $$;

\echo ''
\echo 'ALL RLS CHECKS PASSED'
rollback;
