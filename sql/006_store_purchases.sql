-- Native in-app purchases. Run after 001-005.
--
-- Store purchases write the SAME entitlements row as Lemon Squeezy: one
-- definition of Pro, three ways in (web checkout, licence key, store IAP).
-- Nothing downstream needs to know which rail paid.

alter table public.entitlements add column if not exists store_txn_id     text;
alter table public.entitlements add column if not exists store_product_id text;

-- One purchase, one account. The unique index is the last line of defence
-- against two accounts redeeming the same transaction at the same instant —
-- the same rule licence keys follow, and for the same reason.
create unique index if not exists entitlements_store_txn_unique
  on public.entitlements (store_txn_id) where store_txn_id is not null;

-- 'play' and 'appstore' join 'lemonsqueezy' | 'licence' | 'manual' as sources.
comment on column public.entitlements.source is
  'lemonsqueezy | licence | manual | play | appstore';

-- Store server notifications, deduped the same way Lemon Squeezy webhooks are.
-- A replay is not an error; processing one twice must be harmless, and it is,
-- because every handler re-reads the purchase from the store rather than
-- believing the notification.
create table if not exists public.store_notifications (
  id           text primary key,          -- provider-scoped unique id
  provider     text not null,             -- 'play' | 'appstore'
  kind         text,                      -- notification type
  payload      jsonb not null,
  processed_at timestamptz not null default now(),
  unresolved   boolean not null default false,
  resolve_note text
);
create index if not exists store_notifications_unresolved_idx
  on public.store_notifications (processed_at desc) where unresolved;

alter table public.store_notifications enable row level security;
-- No policies: service role only, like webhook_events.
