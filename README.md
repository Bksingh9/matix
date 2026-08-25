# MindSharp

Mental-arithmetic fitness tracker. Seven timed game modes, a seeded daily
challenge, and a Pro tier whose value proposition is measurement: a weak-spot
report over your real answer history, and drills generated from it.

Vanilla ES modules in the browser, Vercel serverless functions for anything
that must be trusted, Supabase (Postgres + Auth) for identity and data,
Lemon Squeezy as merchant of record.

See `MINDSHARP_BUILD_SPEC.md` for the build brief and `MONETISATION_PLAN.md`
for the commercial reasoning behind it.

## Layout

```
public/          static frontend, served as-is — no bundler, no build step
  index.html     markup shell
  css/app.css
  js/            ES modules, loaded natively by the browser
api/             Vercel serverless functions (the only place secrets exist)
lib/             server-side helpers shared by api/*
sql/             schema, RLS policies, views — run in order against Supabase
scripts/         build guards (secret scan, production checks, syntax/linkage)
test/            unit tests (node:test) and Playwright end-to-end tests
reference/       the original single-file build, kept for diffing
```

The client module graph is a DAG, deliberately:

```
util ─┬─> state ─┬─> games ─┬─> ui ──> paywall ──> engine ──> main
      │          │          │
      └─> store ─┘          └─> audio
```

`ui.js` renders and never binds handlers; `main.js` owns every listener and
uses delegation for dynamic content. That is what keeps the graph acyclic
without a bundler to paper over cycles.

## Local development

```bash
npm install
npm run check          # syntax + import linkage + secret scan + unit tests
npm run e2e            # Playwright: actually plays every game mode
```

`npm run e2e` needs a Chromium. If yours is not where Playwright expects it:

```bash
PW_CHROMIUM=/path/to/chromium npm run e2e
```

For the full stack including `/api/*`:

```bash
cp .env.example .env.local   # fill it in — see below
npx vercel dev
```

The frontend alone works without any of it: with no backend reachable the app
falls back to anonymous local-only play. It never falls back to Pro.

## Environment

Copy `.env.example` and fill it in. Two rules:

- Anything marked **SERVER ONLY** must never be referenced from `public/`.
  `npm run check:secrets` fails the build if it is.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security, which means it can
  grant itself Pro. It exists so the webhook can write entitlements, and for
  nothing else.

## Scripts

| Script | What it does |
|---|---|
| `npm run check:syntax` | Parses every JS file and verifies each named import exists in its source module |
| `npm run check:secrets` | Fails if a server-only secret appears under `public/` |
| `npm run check:prod` | Production-only guards (dev Pro preview off, no direct `S.pro` writes). Skipped unless `VERCEL_ENV=production` or `FORCE_PROD_CHECK=1` |
| `npm test` | Unit tests |
| `npm run e2e` | End-to-end tests in a real browser |
| `npm run verify` | Everything |

## Deploy

Vercel picks up `vercel.json`: `public/` is the static root, `api/**/*.js`
become Node functions, and `npm run build` runs the secret scan plus the
production guards before anything ships.

## Build status

| Phase | State |
|---|---|
| 0 — module split | done |
| 1 — accounts + server entitlement | pending |
| 2 — Lemon Squeezy checkout + webhooks | pending |
| 3 — licence keys | pending |
| 4 — attempt logging | pending |
| 5 — weak spots + drills | pending |
| 6 — ship checklist | pending |
