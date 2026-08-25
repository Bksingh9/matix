# MINDSHARP_BUILD_SPEC.md

**Purpose:** a complete, executable brief for Claude Code to take MindSharp from a single-file browser demo to a product that can safely charge money and deliver the one feature people actually pay for.

**Companion docs:** `MONETISATION_PLAN.md` (why — pricing, funnel, revenue lines), `mindsharp.html` (the working game, current state).

**Read this whole file before writing code.** Phases are ordered by dependency; Phase 2 cannot be tested without Phase 1.

---

## 0. Context and current state

### What exists

`mindsharp.html` — one self-contained file, ~1,400 lines. Seven games (Blitz, Survival, Verify, Operator, Target, Recall, Zen) plus a seeded Daily Challenge. Vanilla JS, no build step, no dependencies. Persistence via `window.storage` (a host-provided key-value API) with graceful in-memory fallback.

Already built and working:

- Game loop, scoring (base × speed bonus × streak multiplier), all seven generators
- Paywall UI, three plan buttons, licence-key input, reward/run-limit sheet
- `CONFIG` block for checkout URLs, prices, ad flags, `freeRuns`
- `track(name, props)` event bus firing 14 funnel events
- Lifetime per-operation tallies in `stats.ops` (correct/seen only)

### What is broken for a paid product

1. **Entitlement lives in the browser.** `S.pro` is set from a local key. Cleared cache = lost purchase. Devtools = free Pro. This is the blocker.
2. **No accounts.** Progress and streaks don't survive a device change — which also removes the strongest retention hook.
3. **No attempt-level data.** `stats.ops` stores four running tallies. That is not enough to build a weak-spot report worth $30, and definitely not enough to generate targeted drills.
4. **No drills.** The paywall promises "drills built from your own misses." That feature does not exist. Shipping the paywall copy without the feature is the one thing we will not do.

### Definition of done for this spec

- A logged-in user's Pro status is decided by the server, survives cache clears, and syncs across devices.
- A Lemon Squeezy purchase grants Pro within seconds, without manual intervention.
- A cancellation, refund, chargeback or failed payment revokes Pro automatically.
- Every answered problem is logged with enough structure to compute weakness.
- A Pro user can tap "Drill my weak spots" and get 20 problems targeted at their actual failure buckets, then see whether they improved.

---

## 1. Architecture decisions (do not relitigate these)

| Decision | Choice | Why |
|---|---|---|
| Hosting | **Vercel** | Static frontend + serverless functions in one deploy, generous free tier |
| Auth + DB | **Supabase** (Postgres + Auth) | Magic-link auth in an afternoon, RLS gives row-level security for free, Postgres means the drill engine is SQL not application code |
| Payments | **Lemon Squeezy** (merchant of record) | Handles global VAT/GST/US sales tax; licence keys and subscriptions in one product; 5% + $0.50 |
| Frontend | **Keep vanilla JS.** No React, no framework, no bundler | The game is 60fps DOM work with zero component reuse. A framework adds a build step and buys nothing. Split the single file into ES modules only. |
| Client state | Local-first, server-authoritative on entitlement | Game must stay playable offline and without an account. Only *Pro* requires the server. |

**Hard rule:** the Lemon Squeezy API key never appears in client code, in `public/`, or in any file shipped to the browser. Every store API call goes through `/api/*`.

---

## 2. Target repo structure

```
mindsharp/
├─ public/
│  ├─ index.html                # shell: markup + CSS, no game logic
│  ├─ css/app.css               # extracted from current <style>
│  └─ js/
│     ├─ main.js                # init, screen routing, bindings
│     ├─ config.js              # CONFIG (public values only)
│     ├─ state.js               # S, defaults, reducers
│     ├─ games.js               # GAMES catalogue + generators
│     ├─ engine.js              # run lifecycle, loop, scoring, submissions
│     ├─ ui.js                  # renderers (menu, game meters, results)
│     ├─ audio.js
│     ├─ store.js               # local persistence (window.storage / localStorage / memory)
│     ├─ api.js                 # thin fetch wrapper for /api/*
│     ├─ auth.js                # Supabase client, magic link, session
│     ├─ entitlement.js         # server-authoritative Pro resolution + cache
│     ├─ paywall.js             # paywall + reward sheets, checkout, licence
│     ├─ drills.js              # Drill mode client
│     └─ analytics.js           # track()
├─ api/
│  ├─ me.js                     # GET  → identity + entitlement + limits
│  ├─ runs.js                   # POST → persist a finished run + attempts
│  ├─ drills.js                 # GET  → generated drill set
│  ├─ weakspots.js              # GET  → weak-spot report data
│  ├─ licence/validate.js       # POST → proxy LS licence validate/activate
│  ├─ checkout.js               # POST → build a checkout URL with custom_data
│  └─ webhooks/lemonsqueezy.js  # POST → signature-verified entitlement writes
├─ lib/
│  ├─ supabase.js               # service-role client (server only)
│  ├─ auth.js                   # verify bearer JWT → user id
│  ├─ entitlement.js            # resolve/upsert entitlement
│  ├─ lemonsqueezy.js           # signature verify + API calls
│  ├─ weakness.js               # bucketing + weakness scoring
│  └─ ratelimit.js
├─ sql/
│  ├─ 001_schema.sql
│  ├─ 002_rls.sql
│  ├─ 003_views.sql
│  └─ 004_seed_dev.sql
├─ .env.example
├─ vercel.json
└─ README.md
```

**Phase 0 note for Claude Code:** the split of `mindsharp.html` into modules is a pure refactor. Do it in one commit, change no behaviour, and verify by playing every game mode before moving on. If anything regresses, the refactor is wrong — the current file works.

---

## 3. Database schema

`sql/001_schema.sql` — write exactly this, then adjust only if Postgres complains.

```sql
-- ============ profiles ============
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ============ entitlements ============
-- One row per user. Server-owned. The client may READ its own row and never write it.
create type plan_type   as enum ('free','monthly','yearly','lifetime','comp');
create type plan_status as enum ('active','cancelled','expired','past_due','refunded','none');

create table public.entitlements (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  plan                plan_type   not null default 'free',
  status              plan_status  not null default 'none',
  source              text,                -- 'lemonsqueezy' | 'licence' | 'manual'
  ls_customer_id      text,
  ls_subscription_id  text unique,
  ls_order_id         text,
  ls_variant_id       text,
  licence_key         text unique,
  current_period_end  timestamptz,         -- null for lifetime
  cancel_at_period_end boolean not null default false,
  updated_at          timestamptz not null default now()
);
create index on public.entitlements (ls_customer_id);

-- ============ runs ============
create table public.runs (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  game         text not null,              -- blitz|survival|verify|operator|target|recall|zen|daily|drill
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
create index on public.runs (user_id, created_at desc);
create index on public.runs (user_id, game, created_at desc);
create unique index runs_one_daily_per_user_per_day
  on public.runs (user_id, daily_date) where is_daily;

-- ============ attempts ============
-- The dataset the entire Pro value prop rests on. One row per problem answered.
create table public.attempts (
  id          bigserial primary key,
  run_id      bigint not null references public.runs(id) on delete cascade,
  user_id     uuid   not null references auth.users(id) on delete cascade,
  kind        text   not null,             -- pad|tf|ops|chips|recall
  op          char(1),                     -- + - * /   (null for recall)
  operand_a   integer,
  operand_b   integer,
  answer      integer,
  given       integer,                     -- what the user entered; null on timeout
  is_correct  boolean not null,
  timed_out   boolean not null default false,
  elapsed_ms  integer not null,
  difficulty  text not null,
  band        smallint not null,           -- magnitude bucket, see §7
  created_at  timestamptz not null default now()
);
create index on public.attempts (user_id, created_at desc);
create index on public.attempts (user_id, op, band, created_at desc);

-- ============ drills ============
create table public.drills (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  buckets     jsonb not null,              -- the targeted buckets + their pre-drill scores
  problems    jsonb not null,              -- the generated set, so results are comparable
  created_at  timestamptz not null default now(),
  completed_at timestamptz
);
create index on public.drills (user_id, created_at desc);

-- ============ daily leaderboard ============
create table public.daily_scores (
  daily_date date not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  score      integer not null,
  grid       text not null,
  created_at timestamptz not null default now(),
  primary key (daily_date, user_id)
);
create index on public.daily_scores (daily_date, score desc);

-- ============ webhook idempotency ============
create table public.webhook_events (
  id           text primary key,           -- LS event id
  event_name   text not null,
  payload      jsonb not null,
  processed_at timestamptz not null default now()
);
```

### RLS — `sql/002_rls.sql`

Every table on. The pattern: users read and insert their own rows; **nobody but the service role touches `entitlements`.**

```sql
alter table public.profiles      enable row level security;
alter table public.entitlements  enable row level security;
alter table public.runs          enable row level security;
alter table public.attempts      enable row level security;
alter table public.drills        enable row level security;
alter table public.daily_scores  enable row level security;
alter table public.webhook_events enable row level security;

create policy "own profile"      on public.profiles     for all    using (auth.uid() = id) with check (auth.uid() = id);
create policy "read own ent"     on public.entitlements for select using (auth.uid() = user_id);
-- no insert/update/delete policy on entitlements: service role only, by design.
create policy "own runs r"       on public.runs         for select using (auth.uid() = user_id);
create policy "own runs w"       on public.runs         for insert with check (auth.uid() = user_id);
create policy "own attempts r"   on public.attempts     for select using (auth.uid() = user_id);
create policy "own attempts w"   on public.attempts     for insert with check (auth.uid() = user_id);
create policy "own drills"       on public.drills       for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own daily w"      on public.daily_scores for insert with check (auth.uid() = user_id);
create policy "daily leaderboard readable" on public.daily_scores for select using (true);
-- webhook_events: no policies at all. Service role only.
```

**Verification step (do not skip):** with an anon-key client, attempt `update entitlements set plan='lifetime'`. It must fail. If it succeeds, the whole payment system is decorative.

### Views — `sql/003_views.sql`

```sql
-- Rolling per-bucket performance over a user's last 400 attempts.
create or replace view public.v_bucket_stats as
with recent as (
  select *, row_number() over (partition by user_id order by created_at desc) as rn
  from public.attempts
  where op is not null
)
select
  user_id, op, band,
  count(*)                                              as seen,
  sum(case when is_correct then 1 else 0 end)            as correct,
  round(avg(elapsed_ms))                                 as avg_ms,
  percentile_cont(0.5) within group (order by elapsed_ms) as median_ms
from recent
where rn <= 400
group by user_id, op, band;
```

---

## 4. Environment variables

`.env.example`:

```bash
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=              # safe in the browser
SUPABASE_SERVICE_ROLE_KEY=      # SERVER ONLY. Never import into public/js/**

# Lemon Squeezy
LEMONSQUEEZY_API_KEY=           # SERVER ONLY
LEMONSQUEEZY_STORE_ID=
LEMONSQUEEZY_WEBHOOK_SECRET=    # SERVER ONLY
LS_VARIANT_MONTHLY=
LS_VARIANT_YEARLY=
LS_VARIANT_LIFETIME=

# App
APP_URL=https://mindsharp.app
```

Add a CI check (or a simple grep in `package.json` scripts) that fails the build if `SERVICE_ROLE` or `LEMONSQUEEZY_API_KEY` appears anywhere under `public/`.

---

## 5. API contracts

All endpoints JSON. Authenticated requests carry `Authorization: Bearer <supabase access token>`. Rate-limit every endpoint by IP and by user id.

### `GET /api/me`

The single source of truth for Pro. The client asks; it never decides.

```json
{
  "authed": true,
  "user": { "id": "uuid", "email": "b@example.com", "displayName": "Brij" },
  "entitlement": {
    "isPro": true,
    "plan": "yearly",
    "status": "active",
    "currentPeriodEnd": "2027-08-26T00:00:00Z",
    "cancelAtPeriodEnd": false
  },
  "limits": { "freeRuns": 5, "runsUsedToday": 2, "runsLeft": 3 },
  "serverTime": "2026-08-26T10:00:00Z"
}
```

Unauthenticated: `{"authed": false, "entitlement": {"isPro": false, "plan": "free", "status": "none"}, "limits": {...}}`.

`isPro` is computed server-side as: `status IN ('active','cancelled') AND (plan = 'lifetime' OR current_period_end > now())`. Note `cancelled` still counts — a user who cancels keeps access until the period ends. That is not generosity, it's what they paid for.

### `POST /api/runs`

Persists a finished run and its attempts in one transaction.

Request:

```json
{
  "game": "blitz", "difficulty": "medium",
  "score": 412, "solved": 24, "correct": 22, "wrong": 2,
  "bestStreak": 11, "durationMs": 60000,
  "isDaily": false, "dailyDate": null, "drillId": null,
  "clientTs": "2026-08-26T10:00:00Z",
  "attempts": [
    { "kind":"pad","op":"*","a":7,"b":8,"answer":56,"given":56,
      "isCorrect":true,"timedOut":false,"elapsedMs":1840,"difficulty":"medium" }
  ]
}
```

Server responsibilities:

- Compute `band` per attempt server-side (§7). Never trust a client-supplied band.
- Reject payloads with `attempts.length > 500` or `elapsedMs < 120` on more than 30% of attempts (bot/replay signal). Log, don't ban.
- For `isDaily`, rely on the unique index to reject a second submission; return `409` with the existing run.
- Upsert `daily_scores` when `isDaily`.

Response: `{ "runId": 1234, "accepted": true }`

**Anti-cheat scope:** score integrity matters only once there's a public leaderboard. Until then, validate shape and move on. Do not build an anti-cheat system for a leaderboard that doesn't exist.

### `GET /api/weakspots`

Pro-gated. Returns the report the paywall promises.

```json
{
  "buckets": [
    { "op":"/", "band":2, "label":"Division, 10–99", "seen":48, "accuracy":0.71,
      "medianMs":5200, "weakness":0.68, "trend":"worsening" }
  ],
  "strongest": { "op":"+", "band":1, "accuracy":0.98 },
  "overall": { "accuracy":0.87, "medianMs":3100, "attemptsAnalysed":400 },
  "sampleTooSmall": false
}
```

If a user has fewer than 40 logged attempts, return `sampleTooSmall: true` and let the UI say *"Play ~5 more rounds and this fills in"* rather than showing noise as insight. Confident numbers from twelve data points is how you lose a paying user's trust.

Non-Pro: `403 {"error":"pro_required"}`.

### `GET /api/drills?size=20`

Pro-gated. Generates and persists a drill, returns the problem set. Algorithm in §7.

```json
{
  "drillId": 88,
  "targeted": [ {"op":"/","band":2,"weakness":0.68}, {"op":"*","band":3,"weakness":0.54} ],
  "problems": [ {"op":"/","a":84,"b":12,"answer":7,"band":2,"difficulty":"medium"} ]
}
```

The client plays this exact set — no client-side generation in Drill mode — so pre/post comparison is honest.

### `POST /api/licence/validate`

Lifetime buyers arrive with a key. Proxy it.

Request `{ "key": "XXXX-XXXX-XXXX" }`. Server:

1. Rate-limit hard: 5 attempts per IP per 10 minutes. This endpoint is a brute-force target.
2. Call Lemon Squeezy's licence validate endpoint with the server-side API key. **Confirm the exact endpoint, parameter names and activation semantics against the current Lemon Squeezy API docs before implementing** — this part of their API has changed before, and guessing produces a silently broken purchase flow.
3. If valid and an `instance_id` is required, activate an instance so the key is bound and reuse is countable.
4. Upsert `entitlements` with `plan='lifetime'`, `status='active'`, `source='licence'`, `licence_key=<key>`.
5. If `licence_key` is already bound to a *different* user, return `409 {"error":"key_in_use"}`. Do not silently transfer.

Response `{ "valid": true, "plan": "lifetime" }`.

### `POST /api/checkout`

Builds a checkout URL server-side so `custom_data.user_id` is always attached — this is the link between a payment and an account.

Request `{ "plan": "yearly" }` → `{ "url": "https://…?checkout[custom][user_id]=…" }`

If the user isn't signed in, return `401 {"error":"auth_required"}` and have the client run the sign-in flow first. **Do not let anyone buy before they have an account** — an orphaned payment with no user id is a support ticket you'll answer by hand.

### `POST /api/webhooks/lemonsqueezy`

The most important endpoint in the system. Get it wrong and either people pay and get nothing, or cancel and keep everything.

**Signature verification, in this order:**

1. Read the **raw request body** as a buffer. On Vercel, disable body parsing (`export const config = { api: { bodyParser: false } }`, or read the stream directly). A JSON-parsed-and-restringified body will not match the HMAC.
2. Compute `HMAC-SHA256(rawBody, LEMONSQUEEZY_WEBHOOK_SECRET)` as hex.
3. Compare against the `X-Signature` header with `crypto.timingSafeEqual`.
4. Mismatch → `401`, log, do nothing else.

**Idempotency:** insert the event id into `webhook_events` first. On unique-violation, return `200` immediately — a replay is not an error, and Lemon Squeezy will retry.

**Event → entitlement mapping.** Read `meta.event_name`, `meta.custom_data.user_id`, and `data.attributes`. Confirm the live event names against current docs; the mapping logic is what matters:

| Event | Action |
|---|---|
| `order_created` (one-time / lifetime variant) | `plan='lifetime'`, `status='active'`, store `ls_order_id` |
| `subscription_created` | `plan` from variant id, `status='active'`, store `ls_subscription_id`, `current_period_end` = renews_at |
| `subscription_updated` | Refresh `status`, `current_period_end`, `cancel_at_period_end`. Handle plan switches. |
| `subscription_cancelled` | `status='cancelled'`, `cancel_at_period_end=true`. **Keep access until `current_period_end`.** |
| `subscription_expired` | `status='expired'` → access ends now |
| `subscription_payment_failed` | `status='past_due'`. Keep access through the dunning window; let LS retry. |
| `subscription_payment_success` | `status='active'`, extend `current_period_end` |
| `order_refunded` / dispute | `status='refunded'`, revoke immediately |
| `license_key_created` | Store key against the user if `custom_data.user_id` is present |

**Fallback for a missing `user_id`:** match on `ls_customer_id`, then on the purchase email against `profiles.email`. If both fail, write the raw event to `webhook_events` and surface it in an admin list. Never drop a paid event silently — that is a person who gave you money and got nothing.

Always return `200` once persisted, even if internal handling had a soft failure, to stop retry storms. Log the failure separately.

---

## 6. Client changes

### `entitlement.js`

```js
// Server-authoritative, with a short cache so we don't hammer /api/me.
let cached = null, fetchedAt = 0;
const TTL = 60_000;

export async function getEntitlement({ force = false } = {}) {
  if (!force && cached && Date.now() - fetchedAt < TTL) return cached;
  try {
    const r = await api.get('/api/me');
    cached = r.entitlement; fetchedAt = Date.now();
    return cached;
  } catch {
    // Offline or server down: fall back to FREE, never to Pro.
    // A paying user briefly seeing the free tier is a bug report.
    // A free user permanently seeing Pro is lost revenue.
    return cached ?? { isPro: false, plan: 'free', status: 'none' };
  }
}
```

Call `getEntitlement({force:true})` on: app open, sign-in, return from checkout (poll every 2s for up to 30s — webhooks aren't instant), and successful licence validation.

### Migrating local progress on first sign-in

An anonymous player with a 12-day streak signs in. Their data must come with them or they will never sign in again.

On first successful auth, if local `mindsharp:stats` exists and the account has zero runs: POST the local aggregate to `/api/runs` as a single synthetic backfill run (`game='import'`), preserve `days[]` into the streak calculation, then mark local as migrated. Do not delete the local copy — keep it as a fallback for one release.

### Free-run cap

- **Anonymous:** client-side, as today (`CONFIG.freeRuns`, stored locally). Trivially bypassable, and that's fine — an anonymous player who clears storage to get five more runs is not a lost sale, they're a player who hasn't decided yet.
- **Signed in:** authoritative count from `/api/me` `limits.runsUsedToday`. The client decrements optimistically for responsiveness and reconciles on the next `/api/me`.

### New game mode: Drill

Add to `GAMES` with `pro: true`:

```js
drill: { name:"Drill", glyph:"◇", pro:true,
         desc:"Twenty problems aimed at your weakest buckets.",
         input:"pad", timer:"problem", lives:99 }
```

Behaviour: fetch from `/api/drills`, play the returned set in order, no lives lost (this is practice, not a test), then show a results screen comparing **pre-drill accuracy per targeted bucket** to **this session's accuracy on those buckets**. That before/after delta is the single most persuasive screen in the product — it's the proof that Pro did something. Give it room.

Entry points: the Pro weak-spot report ("Drill these →") and a card in the games grid.

### Paywall wiring

Replace the placeholder in `startCheckout(plan)` with a `POST /api/checkout` call, then redirect. Keep the "Preview Pro in this browser (demo)" button behind a `CONFIG.devMode` flag and **strip it from production builds** — it is a free Pro button.

---

## 7. The drill engine

This is the feature people pay for. Specify it carefully; it is not "pick the wrong ones again."

### Bucketing

A bucket is `(op, band)` — 4 ops × 4 bands = 16 buckets max.

```
band = 1  if max(|a|,|b|) < 10
band = 2  if max(|a|,|b|) < 100
band = 3  if max(|a|,|b|) < 1000
band = 4  otherwise
```

Compute server-side from the operands. For division, band off the dividend.

### Weakness score

For each bucket with `seen >= 8` over the last 400 attempts:

```
accuracy      = correct / seen
acc_lower     = Wilson lower bound (95%) of accuracy   # punishes small samples honestly
slowness      = clamp01( (median_ms - target_ms) / target_ms )
target_ms     = { band1: 2200, band2: 3200, band3: 4800, band4: 6500 }

weakness = 0.65 * (1 - acc_lower) + 0.35 * slowness
```

Use the **Wilson lower bound**, not raw accuracy. Three misses out of four is not a 25% accuracy fact; it's weak evidence of a problem. Without smoothing, the drill engine will chase noise and the report will contradict itself between sessions — which reads as a broken product.

Buckets with `seen < 8` are `insufficient_data`. Never rank them, never drill them as weaknesses, and never show them as insight.

### Trend

Compare weakness over the most recent 100 attempts against the prior 200. Delta > 0.08 → `worsening`; < −0.08 → `improving`; else `steady`. Only report a trend when both windows have `seen >= 8` in that bucket.

### Drill composition (20 problems, default)

```
70% (14)  from the top 3 weakest eligible buckets, distributed by weakness weight
20% (4)   from mid-ranked buckets
10% (2)   from the strongest bucket
```

The 10% strong is deliberate: an all-weakness drill is 20 problems of failing, and people quit. Wins keep them in the set.

**Interleave, don't block.** Shuffle so the same bucket never appears more than twice consecutively. Interleaved practice produces better retention than blocked practice — and blocked practice *feels* easier, which makes people rate it higher while learning less. Interleave anyway.

**Difficulty inside a bucket** follows the band, not the user's global difficulty setting. Drill mode ignores the difficulty selector entirely; say so in the UI so it doesn't read as a bug.

**Cold start:** fewer than 40 attempts total → `/api/drills` returns `422 {"error":"insufficient_data","attemptsNeeded":N}`. Client shows "Play about five more rounds and I can build you a drill." Do not fabricate a drill from nothing; a generic drill labelled "personalised" is exactly the kind of thing that gets a refund request.

### Mastery

A bucket graduates when its last 10 attempts are ≥90% correct **and** median time ≤ `target_ms`. Graduated buckets drop out of drill targeting but stay in the report with a "mastered" marker. Visible graduation is the progression mechanic that makes a yearly plan feel worth renewing.

---

## 8. Phases, in order

### Phase 0 — Scaffold (½ day)

- Init repo, Vercel project, Supabase project.
- Split `mindsharp.html` into the module structure in §2. **Behaviour-identical.**
- Deploy. Play all seven games on a phone and a desktop.
- ✅ Done when: the deployed modular build is indistinguishable from the current single file.

### Phase 1 — Accounts + server entitlement (2 days)

- Run `001`–`003` SQL. Verify RLS with the anon key as described in §3.
- Supabase magic-link auth. Header shows email + Sign out when authed.
- `/api/me`. `entitlement.js` replaces every local `S.pro` read.
- Local-progress migration on first sign-in.
- Manually set one row to `plan='comp'` and confirm Pro features unlock across two browsers.
- ✅ Done when: Pro can only be granted by a database row, and clearing browser storage doesn't change it.

### Phase 2 — Lemon Squeezy live (2 days)

- Store setup: three variants (monthly, yearly, lifetime). Enable licence keys on the lifetime variant.
- `/api/checkout` with `custom_data.user_id`.
- `/api/webhooks/lemonsqueezy` with signature verification + idempotency + the full event map.
- Test with LS test mode: buy monthly → Pro within seconds. Cancel → access persists to period end. Expire → access ends. Refund → access ends immediately. Replay a webhook → no double-write.
- ✅ Done when: every row of the §5 event table has been exercised against a real (test-mode) event, not just written.

### Phase 3 — Licence keys (½ day)

- `/api/licence/validate` against the *current* LS docs, with rate limiting and the `key_in_use` case.
- ✅ Done when: a lifetime key unlocks Pro on a fresh browser, and reusing it on a second account is refused.

### Phase 4 — Attempt logging (1 day)

- Client accumulates attempts during a run; `POST /api/runs` on run end, with a retry queue for offline runs.
- Server computes bands; validates shape.
- ✅ Done when: playing 3 rounds produces correct `attempts` rows with sane `band` and `elapsed_ms` values.

### Phase 5 — Weak spots + Drill (2–3 days)

- `lib/weakness.js` with Wilson bound. **Unit-test this** — feed it 3/4 and 300/400 and confirm the small sample doesn't outrank the large one.
- `/api/weakspots`, `/api/drills`.
- Drill mode client + the pre/post comparison screen.
- Replace the free-tier locked teaser copy so it describes what now genuinely exists.
- ✅ Done when: a user with a deliberately bad division record gets a drill that is visibly division-heavy, and the after-screen shows a real delta.

### Phase 6 — Ship it (1 day)

- Strip `devMode` Pro preview. Grep `public/` for secrets.
- Point `track()` at Plausible; confirm all 14 events land.
- Cancel/manage-subscription link (LS customer portal). Refund policy page. Terms + privacy — required by the MoR, and by anyone deciding whether to type a card number.
- ✅ Done when: you can buy, use, cancel and get refunded without you touching a database.

### Phase 7 — Only after money moves

Daily leaderboard, friend duels, Play Store wrapper, ads. Not before.

---

## 9. Prompts for Claude Code

Run these one at a time. Do not paste the whole spec and ask for everything.

**Phase 0**

> Read `MINDSHARP_BUILD_SPEC.md` §2. Split `mindsharp.html` into the module structure described, extracting CSS to `public/css/app.css` and JS to the listed files in `public/js/`. This is a pure refactor: change no behaviour, no logic, no styling. Keep `window.storage` with its fallback chain. When done, list what you moved where and flag anything that resisted a clean split.

**Phase 1**

> Read §3, §4, §5 (`/api/me`) and §6. Write `sql/001_schema.sql`, `002_rls.sql`, `003_views.sql` exactly as specified. Then implement Supabase magic-link auth, `lib/auth.js`, `lib/supabase.js`, `api/me.js`, and `public/js/entitlement.js`. Replace every direct read of `S.pro` with the server-resolved value. Include the local-progress migration from §6. Write the RLS verification as a script I can run.

**Phase 2**

> Read §5 (`/api/checkout`, webhooks). Implement both. For the webhook: raw-body HMAC verification with `timingSafeEqual`, idempotency via `webhook_events`, and the complete event→entitlement mapping table. Before writing the LS API calls, fetch the current Lemon Squeezy webhook and API documentation and tell me where my spec differs from what's live. Do not guess at endpoint shapes.

**Phase 4–5**

> Read §5 (`/api/runs`, `/api/weakspots`, `/api/drills`) and §7. Implement attempt logging with an offline retry queue, then `lib/weakness.js` with a Wilson lower bound, then the two endpoints, then Drill mode in the client with the pre/post comparison screen. Unit-test the weakness scorer: a 3/4 bucket must not outrank a 300/400 bucket.

---

## 10. Traps

- **Body parsing breaks webhook signatures.** The single most common cause of "payments silently don't work." Read raw bytes.
- **Revoking on cancel instead of expiry.** They paid through the period. Take it away early and you'll get a chargeback, which costs more than the subscription.
- **Trusting client-computed bands or scores.** Compute server-side. Not because cheaters are a real threat yet, but because a client bug then silently poisons the dataset the entire Pro feature depends on.
- **Shipping the paywall copy before the drill feature.** The current wall promises drills. Until Phase 5 lands, either build it or change the copy. Selling a feature that doesn't exist is the fastest way to a refund and a bad review.
- **Statistics on twelve data points.** `sampleTooSmall` exists for a reason. "You're weak at division" from four attempts is a coin flip presented as insight.
- **Leaving the demo Pro button in production.** Grep for it before every deploy.
- **Building the leaderboard first because it's more fun than webhooks.** It is. Do the webhooks.
