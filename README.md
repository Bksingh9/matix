# MindSharp

Mental-arithmetic fitness tracker. Seven timed game modes, a seeded daily
challenge, and a Pro tier whose value proposition is measurement: a weak-spot
report over your real answer history, and drills generated from it.

Vanilla ES modules in the browser, Vercel serverless functions for anything
that must be trusted, Supabase (Postgres + Auth) for identity and data,
Lemon Squeezy as merchant of record.

- `MINDSHARP_BUILD_SPEC.md` — the build brief this was implemented against
- `MONETISATION_PLAN.md` — the commercial reasoning behind it
- `docs/LEMONSQUEEZY.md` — where the live Lemon Squeezy API differs from the spec
- `docs/DEVIATIONS.md` — every place the implementation departs from the spec, and why

## Layout

```
public/          static frontend, served as-is — no bundler, no build step
  index.html     markup shell
  css/           app.css, legal.css
  js/            ES modules, loaded natively by the browser
  legal/         terms, privacy, refunds
api/             Vercel serverless functions (the only place secrets exist)
lib/             server-side helpers shared by api/*
sql/             schema, RLS, views, dev seed — run in order against Supabase
scripts/         build guards
test/            unit + integration tests (node:test) and Playwright e2e
reference/       the original single-file build, kept for diffing
```

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
```

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
| `test/e2e/*` | Real gameplay in Chromium: every mode, entitlement, offline queue, drill before/after, funnel events |

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
| 7 — leaderboard, duels, ads | not started, by design — "only after money moves" |

What remains is not code: create the Supabase and Lemon Squeezy accounts, run
the SQL, set the environment variables, and exercise the event map against
real test-mode events. See `docs/GO-LIVE.md`.
