-- Row-level security. Every table on.
-- The pattern: users read and insert their own rows; nobody but the service
-- role touches entitlements.
--
-- Verify with `npm run verify:rls` after running this. If an anon-key client
-- can update entitlements, the whole payment system is decorative.

alter table public.profiles       enable row level security;
alter table public.entitlements   enable row level security;
alter table public.runs           enable row level security;
alter table public.attempts       enable row level security;
alter table public.drills         enable row level security;
alter table public.daily_scores   enable row level security;
alter table public.webhook_events enable row level security;
alter table public.rate_limits    enable row level security;

drop policy if exists "own profile"      on public.profiles;
drop policy if exists "read own ent"     on public.entitlements;
drop policy if exists "own runs r"       on public.runs;
drop policy if exists "own runs w"       on public.runs;
drop policy if exists "own attempts r"   on public.attempts;
drop policy if exists "own attempts w"   on public.attempts;
drop policy if exists "own drills"       on public.drills;
drop policy if exists "own daily w"      on public.daily_scores;
drop policy if exists "daily leaderboard readable" on public.daily_scores;

create policy "own profile"    on public.profiles     for all    using (auth.uid() = id)      with check (auth.uid() = id);
create policy "read own ent"   on public.entitlements for select using (auth.uid() = user_id);
-- no insert/update/delete policy on entitlements: service role only, by design.
create policy "own runs r"     on public.runs         for select using (auth.uid() = user_id);
create policy "own runs w"     on public.runs         for insert with check (auth.uid() = user_id);
create policy "own attempts r" on public.attempts     for select using (auth.uid() = user_id);
create policy "own attempts w" on public.attempts     for insert with check (auth.uid() = user_id);
create policy "own drills"     on public.drills       for all    using (auth.uid() = user_id)  with check (auth.uid() = user_id);
create policy "own daily w"    on public.daily_scores for insert with check (auth.uid() = user_id);
create policy "daily leaderboard readable" on public.daily_scores for select using (true);
-- webhook_events and rate_limits: no policies at all. Service role only.

-- The helper functions are SECURITY DEFINER, so they would otherwise be
-- callable by anyone holding an anon key. bump_rate_limit must not be
-- reachable from the browser at all (a caller could exhaust someone else's
-- budget), and insert_run_with_attempts is only ever called by /api/runs with
-- a user id the server has already verified.
revoke all on function public.bump_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.insert_run_with_attempts(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(text, integer, integer) to service_role;
grant execute on function public.insert_run_with_attempts(uuid, jsonb, jsonb) to service_role;
