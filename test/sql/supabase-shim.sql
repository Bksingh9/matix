-- Local stand-in for the pieces Supabase provides before any of our SQL runs.
--
-- This file is NOT part of the deployed schema. It exists so `npm run
-- verify:sql` can apply sql/001-006 to a throwaway Postgres and prove both
-- that they run and that row-level security actually holds — neither of which
-- the unit tests can show, because they talk to a fake PostgREST with no
-- database behind it.
--
-- Everything here is something Supabase already has. If this file needs a new
-- object to make our SQL run, that is a signal our SQL depends on something we
-- have not written down.

-- Roles. `service_role` bypasses RLS in Supabase; that is the whole reason the
-- service key must never reach a browser, and the reason these tests can tell
-- the difference between "policy allows it" and "role ignores policies".
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;

-- The subset of auth.users our foreign keys reference. Supabase's real table
-- has far more columns; ours only ever joins on id and reads email.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

/* auth.uid() reads the JWT claim PostgREST sets per request. Setting
   `request.jwt.claims` by hand is exactly how a test impersonates a user, and
   is why these checks are meaningful rather than circular: the policies are
   the real ones, only the claim is injected. */
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')::text;
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '')::text;
$$;

-- PostgREST hands these roles USAGE on the exposed schema; without it every
-- test would fail on permissions rather than on policy, which would hide the
-- thing we are trying to measure.
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
grant select on auth.users   to service_role;

-- Supabase grants table privileges to the API roles by default; RLS is what
-- narrows them back down. Reproduced here so a passing test means "the policy
-- stopped them", never "the grant was missing".
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
