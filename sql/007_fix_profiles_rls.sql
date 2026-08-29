-- SECURITY FIX. Run this on any database where 002_rls.sql was applied before
-- this file existed. It is idempotent and safe to re-run.
--
-- The old policy was:
--     create policy "own profile" on public.profiles
--       for all using (auth.uid() = id) with check (auth.uid() = id);
--
-- `for all` covers UPDATE, and RLS is row-level rather than column-level, so
-- a signed-in user could rewrite any column of their own row using nothing
-- but the public anon key and their own token:
--
--     PATCH /rest/v1/profiles?id=eq.<their id>   {"email":"victim@example.com"}
--
-- profiles.email is not unique, so the duplicate is accepted. A purchase made
-- without a user id attached — buying from the storefront rather than through
-- /api/checkout — is attributed by email, so the squatter receives the
-- victim's entitlement. The same hole let a user write `handle` directly,
-- bypassing the format and length rules api/league.js enforces.
--
-- The client never writes this table: handle_new_user(), touchProfile() and
-- api/league.js all write it with the service role. So read-only is not a
-- restriction, it is the actual requirement.

drop policy if exists "own profile" on public.profiles;
drop policy if exists "read own profile" on public.profiles;

create policy "read own profile" on public.profiles for select using (auth.uid() = id);
revoke insert, update, delete on public.profiles from anon, authenticated;

-- Belt and braces: keep the shape rule where it cannot be bypassed, rather
-- than only in the endpoint that is supposed to be the only writer.
alter table public.profiles drop constraint if exists profiles_handle_shape;
alter table public.profiles add constraint profiles_handle_shape
  check (handle is null or handle ~ '^[A-Za-z0-9_][A-Za-z0-9_ -]{1,15}$');
