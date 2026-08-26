# MindSharp

Mental-arithmetic fitness tracker. Seven timed game modes, a seeded daily
challenge, and a Pro tier whose value proposition is measurement: a weak-spot
report over your real answer history, and drills generated from it.

Vanilla ES modules in the browser, Vercel serverless functions for anything
that must be trusted, Supabase (Postgres + Auth) for identity and data,
Lemon Squeezy as merchant of record.

It also ships as an installable PWA and as native Android and iOS apps —
Capacitor shells around the same `public/` build, with no second codebase.

- `MINDSHARP_BUILD_SPEC.md` — the build brief this was implemented against
- `MONETISATION_PLAN.md` — the commercial reasoning behind it
- `docs/LEMONSQUEEZY.md` — where the live Lemon Squeezy API differs from the spec
- `docs/DEVIATIONS.md` — every place the implementation departs from the spec, and why
- `docs/MOBILE.md` — building and shipping the store apps
- `docs/GO-LIVE.md` — the runbook for taking the first payment

## Layout

```
public/          static frontend, served as-is — no bundler, no build step
  index.html     markup shell
  css/           app.css, legal.css
  js/            ES modules, loaded natively by the browser
  legal/         terms, privacy, refunds
  sw.js          offline-first service worker
  manifest.webmanifest
api/             Vercel serverless functions (the only place secrets exist)
lib/             server-side helpers shared by api/*
sql/             schema, RLS, views, progression, purchases — run in order
scripts/         build guards and asset generation
test/            unit + integration tests (node:test) and Playwright e2e
android/ ios/    Capacitor projects — committed, they carry real config
assets/          icon and splash sources for capacitor-assets
reference/       the original single-file build, kept for diffing
```

`public/js/progression.js` is imported by both the client and the server —
one file, not a copy, so the XP and streak rules cannot drift between them.

The client module graph is a DAG, deliberately:

```
util ─┬─> store ─> state ─┬─> games ─> ui ─> paywall ─┬─> engine ─> main
      │                   ├─> audio                   │
      └─> config ─────────┴─> api ─> auth ─> entitlement
                                          └─> account, drills, runlog
```

`ui.js` renders and never binds handlers; `main.js` owns every listener and
uses delegation for dynamic content. That is what keeps the graph acyclic
without a bundler to paper over cycles.

`engine.js` never imports the network layer. It reports through three sinks
(`setAttemptSink`, `setRunSink`, `setResultsHook`) that `main.js` wires to
`runlog.js` and `drills.js`.

## Local development

```bash
npm install
npm run check          # syntax + import linkage + secret scan + event scan + unit tests
npm run e2e            # Playwright: plays every game mode for real
npm run verify         # both
```

`npm run e2e` needs a Chromium. If yours is not where Playwright expects it:

```bash
PW_CHROMIUM=/path/to/chromium npm run e2e
```

For the full stack including `/api/*`:

```bash
cp .env.example .env.local   # fill it in
npx vercel dev
```

The frontend works without any of it: with no backend reachable the app falls
back to anonymous local-only play. It never falls back to Pro.

## First-time setup

### 1. Supabase

Create a project, then run the SQL in order in the SQL editor:

```
sql/001_schema.sql      tables, enums, triggers, the two SECURITY DEFINER helpers
sql/002_rls.sql         row-level security on every table
sql/003_views.sql       bucket stats, trend windows, mastery, today's runs
sql/004_seed_dev.sql    DEV ONLY — comp entitlement + a lopsided answer history
sql/005_progression.sql XP, achievements, leagues, the settle function
sql/006_store_purchases.sql  store transaction ids and notification log
```

The `on delete cascade` on every `user_id` is load-bearing: it is what makes
account deletion one row instead of a checklist. See `docs/DEVIATIONS.md` §11.

Then prove RLS actually holds:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run verify:rls
```

It creates a throwaway user and checks that neither an anon client nor a
signed-in user can write `entitlements`. **If those checks fail, the payment
system is decorative** — anyone can grant themselves Pro from the console.

Under Authentication → Email, enable magic links and set the redirect URL to
your deployed origin.

### 2. Lemon Squeezy

See `docs/LEMONSQUEEZY.md` for the full checklist and for the ten places the
live API differs from the spec. In short: three variants, licence keys enabled
on lifetime only, a webhook at `/api/webhooks/lemonsqueezy` subscribed to every
event in that doc, and the variant ids into the environment.

### 3. Vercel

Import the repo, set the environment variables from `.env.example`, deploy.
`vercel.json` makes `public/` the static root and `api/**/*.js` Node functions,
and `npm run build` runs the secret scan plus the production guards first.

### 4. Analytics

Set `CONFIG.analytics.plausible.domain` in `public/js/config.js` to the site
registered in your Plausible account. Leave it empty and no third-party script
loads at all. `npm run check:events` verifies all fourteen funnel events are
still fired; `test/e2e/funnel.test.mjs` verifies they land at runtime.

## Scripts

| Script | What it does |
|---|---|
| `npm run check:syntax` | Parses every JS file and verifies each named import exists in its source module |
| `npm run check:secrets` | Fails if a server-only secret appears under `public/` |
| `npm run check:events` | Fails if any of the fourteen funnel events is no longer fired |
| `npm run check:prod` | Production guards: dev Pro preview off, no direct `S.pro` writes, legal pages present, paywall not promising unwired features. Skipped unless `VERCEL_ENV=production` or `FORCE_PROD_CHECK=1` |
| `npm test` | Unit and integration tests |
| `npm run e2e` | End-to-end tests in a real browser |
| `npm run verify` | Everything |
| `npm run verify:rls` | Proves row-level security against a live Supabase project |

## Retention, and why it is built this way

The product's problem is not that people dislike it, it is that they play
once. Every mechanic below exists to answer "why open this tomorrow":

- **Streaks with freezes.** One earned every five days played, spent
  automatically to cover a missed day. One bad Tuesday killing a 40-day
  streak makes people quit outright rather than start again; the punishment
  has to be survivable to stay motivating.
- **XP per problem, not per score.** Score rewards speed streaks, so a strong
  player would out-earn a beginner 10:1 and the beginner would never level.
- **Weekly leagues.** A scoreboard that resets on Monday means last week
  never locks you out, and both boards degrade honestly below five players
  rather than showing a podium of three.
- **One evening reminder, only on days you have not played.** The failure
  mode of notifications is not "ignored", it is "muted forever".
- **Anonymous players get all of it.** Gating progression behind sign-in
  would mean the retention mechanic only starts working after the moment it
  exists to survive.

## How entitlement works

The one thing worth understanding before changing anything:

- **The server decides.** `GET /api/me` returns `entitlement.isPro`, computed
  from a database row the client cannot write. `entitlement.js` caches it for
  60 seconds and pushes it into state through `setPro()`, which is the only
  writer. `scripts/check-prod.mjs` fails a production build if anything else
  assigns to `S.pro`.
- **Failure falls back to free, never Pro.** A paying user briefly seeing the
  free tier is a bug report. A free user permanently seeing Pro is lost
  revenue, and a hole anyone can open by going offline.
- **Cancelled and past_due are still Pro.** They paid through the period;
  revoking early earns a chargeback that costs more than the subscription. See
  `docs/DEVIATIONS.md` for why this differs from the spec's literal formula.
- **The webhook is the only thing that grants.** Signature-verified over raw
  bytes, deduped, and it flags any paid event it cannot attribute to a user
  rather than dropping it.
- **Three rails, one row.** Lemon Squeezy on the web, licence keys, and
  native IAP in the store apps all write the same `entitlements` row. Apple
  and Google require their own billing for a game, so the mobile builds have
  no choice; see `docs/MOBILE.md` for what that costs.
- **Deleting an account never leaves billing behind.** A web subscription is
  cancelled before the row goes. A store subscription cannot be — only Apple
  or Google can cancel it — so deletion is refused with the store named,
  rather than deleting the account and letting the card keep being charged.

## Testing

| Suite | Covers |
|---|---|
| `test/entitlement.test.mjs` | The isPro decision table |
| `test/lemonsqueezy.test.mjs` | Signatures, idempotency, the event map |
| `test/webhook.test.mjs` | The real webhook handler against a fake PostgREST |
| `test/licence.test.mjs` | Licence redemption, every refusal path |
| `test/runs.test.mjs` | Run persistence, validation, server-side banding |
| `test/weakness.test.mjs` | Wilson bound, ranking, mastery, trend, interleaving |
| `test/drills.test.mjs` | Drill generation, cold start, problem correctness |
| `test/progression.test.mjs` | XP curve, levels, streak freezes, achievements |
| `test/progress-store.test.mjs` | Progression applied through /api/runs |
| `test/league.test.mjs` | Ranking, promotion zones, handles, cron auth |
| `test/purchases.test.mjs` | App Store and Play validation, every refusal path |
| `test/account-delete.test.mjs` | Deletion, the cascade, and every reason to refuse |
| `test/e2e/*` | Real gameplay in Chromium: every mode, entitlement, offline queue, drill before/after, funnel events, retention loop, leagues, PWA install, notification policy, account deletion |

## Build status

All seven phases of the build spec are implemented.

| Phase | State |
|---|---|
| 0 — module split | done |
| 1 — accounts + server entitlement | done |
| 2 — Lemon Squeezy checkout + webhooks | done |
| 3 — licence keys | done |
| 4 — attempt logging | done |
| 5 — weak spots + drills | done |
| 6 — ship checklist | done |
| 7 — XP, levels, achievements, streaks | done |
| 8 — daily leaderboard + weekly leagues | done |
| 9 — installable PWA, offline play | done |
| 10 — Android and iOS shells | done |
| 11 — streak reminders | done |
| 12 — native in-app purchase | done |
| 13 — in-app account deletion | done |

Phases 7–12 were added after the original spec, which deferred them to
"only after money moves". That call was overridden deliberately; the
reasoning against it is still in `MONETISATION_PLAN.md` §4 and §9, and ads
remain off.

Phase 13 is not a feature anyone asked for — it is what the store builds
oblige. Both Apple and Google require in-app account deletion once an app
offers accounts, and `docs/MOBILE.md` had claimed it existed before it did.
See `docs/DEVIATIONS.md` §11.

What remains is not code: create the Supabase and Lemon Squeezy accounts, run
the SQL, set the environment variables, and exercise the event map against
real test-mode events. See `docs/GO-LIVE.md`.
