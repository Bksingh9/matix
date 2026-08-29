# Running the whole thing for free

Every piece of MindSharp has a free tier that permits commercial use. This is
the exact stack, the limits you would actually hit, and the two places where
"free" has a catch worth knowing before you build on it.

Nothing here needs a credit card.

---

## Stage 0 — the game, free forever, no accounts at all

**The frontend is the whole game.** Seven modes, the daily challenge, streaks,
XP, achievements, offline play and PWA install all work with **no backend**.
With `/api/*` unreachable the client runs anonymous and local-only — it is
built to, and it never grants Pro by mistake.

So the first version costs nothing and depends on nobody:

| | |
|---|---|
| **GitHub Pages** | Free, unlimited for public repos. Already wired in `.github/workflows/pages.yml`. |
| **Cloudflare Pages** | Free, unmetered bandwidth, custom domain, better URL. Connect the repo, build command `node scripts/build-static.mjs`, output `dist`. |

Both host proprietary code on the free tier — the copyright position in
`NOTICE.md` costs you nothing here.

**Enabling Pages** is one setting: *Settings → Pages → Source: GitHub Actions*.
Until then the deploy workflow fails at `configure-pages`, which is the only
step in it that fails.

What Stage 0 does not have: accounts, cross-device sync, the weak-spot report,
leaderboards, and anything paid.

## Stage 1 — accounts and the report, still free

| Piece | Free tier | The real limit |
|---|---|---|
| **Supabase** | Postgres + Auth, 500 MB, 50k monthly active users | **Pauses after 7 days of inactivity.** Fine in production, annoying while you build. |
| **Vercel** | Serverless functions, 100 GB-hours | **Hobby forbids commercial use** — see below |
| **Cloudflare Workers** | 100k requests/day | Commercial use allowed. Needs an API port; see below. |
| **PostHog** | 1M events/month | Genuinely generous. Does funnels and retention. |
| **Lemon Squeezy** | No monthly fee | 5% + 50¢ per sale — you pay only when you earn |

500 MB of Postgres is a lot of arithmetic attempts. You will hit 50k monthly
active users long before you hit the storage limit, and by then the free tier
is not your problem.

### The Vercel catch, which matters here

Vercel's **Hobby plan is for non-commercial use only**. The moment you charge
for Pro, the terms want you on Pro at $20/month. The functions in `api/` are
written for Vercel's Node runtime, so it is the path of least resistance — but
it is the one part of this stack that stops being free exactly when the product
starts working.

Three honest options:

1. **Start on Vercel Hobby while it is free to play**, and move or upgrade when
   you switch payments on. Simplest, and $20/month is a rounding error against
   one yearly subscriber.
2. **Cloudflare Workers**, which permits commercial use on the free tier. The
   handlers would need porting from Node's `(req, res)` to the Fetch API's
   `Request`/`Response`. Real work, perhaps a day, and it removes the only
   recurring cost in the stack.
3. **Stay on Stage 0** and sell nothing yet. Perfectly reasonable until there
   are players.

### Analytics without paying

`public/js/config.js` takes `analytics.provider`:

- `'posthog'` — free to 1M events/month, and the only one of the three that
  gives you the five numbers in `MONETISATION_PLAN.md` §8 without extra work
- `'umami'` — free cloud tier or self-hosted, lighter
- `'plausible'` — the nicest, and the only paid one (~$9/month)
- `'none'` — the default: no third-party script is loaded at all

All three are cookieless and aggregate, which is why this app has no consent
banner. Swapping in something that sets a tracking cookie would quietly make
that a lie, and would need the privacy policy rewritten.

## Stage 2 — the stores

`docs/MOBILE.md` has the detail. The costs are unavoidable and one-off-ish:

- **Google Play**: $25, once, ever
- **Apple**: $99/year, plus a Mac to build on

Android is proven to compile (`npm run verify:android`). iOS cannot be built
without a Mac — no free tier changes that.

Both take 15–30% of store purchases, which is why `MONETISATION_PLAN.md` puts
them after the web, and why `docs/MOBILE.md` exists to explain what that costs.

---

## What free actually buys you

| | Cost | Ceiling |
|---|---|---|
| Stage 0 | **£0** | unlimited players, no accounts |
| Stage 1 | **£0** until you charge | 50k MAU, 1M events/month |
| Stage 1 + payments | ~$20/mo, or a day porting to Workers | as above |
| Stage 2 | $25 + $99/yr | store fees on store sales |

The thing worth internalising: **Stage 0 is a complete product.** Most of what
makes this game worth returning to — the daily, streaks, XP, achievements,
offline play — needs no server. Ship that, see whether anyone comes back, and
only then spend a day wiring the parts that cost money.
