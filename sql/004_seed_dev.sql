-- Development seed. NEVER run this against production.
--
-- Gives an existing user a comp entitlement plus a deliberately lopsided
-- answer history: division in the 10–99 band is bad and slow, addition in the
-- 0–9 band is near-perfect. That is the fixture the Phase 5 acceptance test
-- needs — "a user with a deliberately bad division record gets a drill that
-- is visibly division-heavy".
--
-- Usage:
--   1. Sign in once through the app so auth.users has your row.
--   2. Set :email below, then run this file in the Supabase SQL editor.

\set email 'you@example.com'

do $$
declare
  v_user uuid;
  v_run  bigint;
  i      int;
  a      int;
  b      int;
  ok     boolean;
begin
  select id into v_user from auth.users where lower(email) = lower(:'email');
  if v_user is null then
    raise exception 'No auth.users row for %. Sign in through the app first.', :'email';
  end if;

  -- comp Pro, so the Pro-gated endpoints are reachable without a payment
  insert into public.entitlements (user_id, plan, status, source, updated_at)
  values (v_user, 'comp', 'active', 'manual', now())
  on conflict (user_id) do update
    set plan = 'comp', status = 'active', source = 'manual',
        current_period_end = null, updated_at = now();

  -- one synthetic run to hang the attempts off
  insert into public.runs (user_id, game, difficulty, score, solved, correct,
                           wrong, best_streak, duration_ms)
  values (v_user, 'blitz', 'medium', 0, 120, 84, 36, 5, 600000)
  returning id into v_run;

  -- 60 division attempts in band 2: ~55% correct, slow (target is 3200ms)
  for i in 1..60 loop
    b  := 3 + (i % 10);
    a  := b * (4 + (i % 9));
    ok := (i % 20) < 11;
    insert into public.attempts (run_id, user_id, kind, op, operand_a, operand_b,
                                 answer, given, is_correct, timed_out, elapsed_ms,
                                 difficulty, band)
    values (v_run, v_user, 'pad', '/', a, b, a / b,
            case when ok then a / b else a / b + 1 end, ok, false,
            5200 + (i % 7) * 180, 'medium', 2);
  end loop;

  -- 40 multiplication attempts in band 2: ~78% correct, mildly slow
  for i in 1..40 loop
    a  := 4 + (i % 9);
    b  := 6 + (i % 7);
    ok := (i % 9) < 7;
    insert into public.attempts (run_id, user_id, kind, op, operand_a, operand_b,
                                 answer, given, is_correct, timed_out, elapsed_ms,
                                 difficulty, band)
    values (v_run, v_user, 'pad', '*', a, b, a * b,
            case when ok then a * b else a * b + 2 end, ok, false,
            3600 + (i % 5) * 140, 'medium', 2);
  end loop;

  -- 50 addition attempts in band 1: ~96% correct, fast (target is 2200ms)
  for i in 1..50 loop
    a  := 1 + (i % 9);
    b  := 1 + ((i * 3) % 9);
    ok := (i % 25) <> 0;
    insert into public.attempts (run_id, user_id, kind, op, operand_a, operand_b,
                                 answer, given, is_correct, timed_out, elapsed_ms,
                                 difficulty, band)
    values (v_run, v_user, 'pad', '+', a, b, a + b,
            case when ok then a + b else a + b + 1 end, ok, false,
            1300 + (i % 4) * 90, 'easy', 1);
  end loop;

  -- 30 subtraction attempts in band 2: ~87%, on pace
  for i in 1..30 loop
    a  := 40 + (i % 50);
    b  := 5 + (i % 20);
    ok := (i % 8) <> 0;
    insert into public.attempts (run_id, user_id, kind, op, operand_a, operand_b,
                                 answer, given, is_correct, timed_out, elapsed_ms,
                                 difficulty, band)
    values (v_run, v_user, 'pad', '-', a, b, a - b,
            case when ok then a - b else a - b - 1 end, ok, false,
            3100 + (i % 6) * 100, 'medium', 2);
  end loop;

  raise notice 'Seeded 180 attempts and a comp entitlement for %', :'email';
end $$;
