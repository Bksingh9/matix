# MindSharp — Monetisation Plan

Web-first brain-fitness game. Priced in USD, sold worldwide, collected through a merchant of record so you never register for VAT in forty jurisdictions.

*Not legal or tax advice — the India tax/FEMA points below need a CA's sign-off before you invoice anyone.*

---

## 1. The strategic call: subscriptions first, ads much later

The instinct with a game is "put ads on it." For a web game at low traffic that earns close to nothing. The numbers, from published 2026 benchmarks:

| Format | US / tier-1 eCPM | Tier-3 eCPM |
|---|---|---|
| Rewarded video (best paying) | ~$15–28 | ~$1–3 |
| Interstitial | ~$0.50–1.50 | pennies |
| Banner | ~$0.05–0.20 | ~nothing |

One developer's published breakdown of a portfolio on CrazyGames came to roughly **€1.20 per thousand plays**. At 10,000 plays a month that is about twelve euros. Ads are a scale business; you don't have scale yet.

A subscription at $29.99/year needs **one buyer** to beat that month. So: Pro subscription is line one, and ads switch on only when daily actives clear ~1,000.

**Positioning note.** Matiks — the reference point — raised $3.14M (Tanglin Venture Partners, Info Edge Ventures) and is building a live-multiplayer "esport for mental math" with duels, leagues and clubs. Do not fight them on real-time multiplayer; that's an infrastructure war you'd lose. Compete where they're thin: **measurement**. Matiks tells you that you won. MindSharp tells you that your division is 71% and your subtraction under 500 is where the seconds go. "Your mental-math fitness tracker" is a different product and a different buyer.

---

## 2. Revenue architecture — four lines, in the order the money actually arrives

### Line 1 — Portal licensing (cash in weeks, not months)

The fastest real dollars for a finished HTML5 game. Non-exclusive licences to web-game portals run roughly **$300–800 per platform**; exclusive deals start around **$5,000**. Three or four non-exclusive placements is $1,200–3,000 for work already done, plus traffic you can retarget to your own domain.

Targets: CrazyGames, Poki, itch.io, GameDistribution, Y8. Pitch: finished, mobile-ready, no dependencies, one file.

### Line 2 — MindSharp Pro (the compounding line)

| Plan | Price | Notes |
|---|---|---|
| Monthly | **$4.99** | The anchor. Most churn here. |
| Yearly | **$29.99** | Push this — "save 50%", $2.50/mo framing |
| Lifetime | **$69** | Cash-flow accelerator early; cap it or retire it at scale |

Yearly is the goal: it front-loads cash, kills monthly churn, and at your traffic level cash-flow beats MRR optics.

What's behind the wall (already built in the app): unlimited runs, Target + Recall games, Expert difficulty, the weak-spot report, no ads. What must be added to make Pro genuinely worth $30: **drills generated from your own misses**, and cross-device sync.

### Line 3 — Education / B2B (highest revenue per hour of your time)

This is where a solo operator earns real dollars at zero traffic. Tutors and schools have budget and don't churn.

| Product | Price | Buyer |
|---|---|---|
| Tutor licence | **$99/yr** | 30 student seats, progress dashboard |
| School / classroom | **$299/yr** | multi-class, teacher view, CSV export |
| White-label | **$2,000–15,000** one-time | edtech firms, coaching chains, abacus/Vedic-maths franchises |

Twenty tutor licences is $2,000/year from twenty conversations. One white-label deal beats a year of ads. India has thousands of Vedic-maths and abacus franchises — you already understand that market, and you can charge them in INR while charging US tutors in USD.

### Line 4 — Ads (switch on at ~1,000 DAU, not before)

Apply for **Google H5 Games Ads** (by application; interstitial + rewarded through the Ad Placement API) or a gaming-specific partner such as AdinPlay, Venatus or Playwire. Plain AdSense is a poor fit — it has no rewarded or interstitial game formats and leaves impressions unfilled.

Optimise **session RPM, not eCPM**. A $4.50 eCPM at 85% fill beats a $5.00 eCPM at 60% fill.

Honest projection at 1,000 DAU, ~40% tier-1 traffic, rewarded on the out-of-runs screen: roughly **$200–400/month**. Useful, not transformative. The rewarded hook is already wired in the code (`showRewarded()`).

---

## 3. Funnel maths — three scenarios, no optimism

Assume 30% of visitors play a run, and 1% of players buy (typical for a free casual web tool; 2%+ is a good outcome, 0.5% is a bad one). Blended revenue per payer per month ≈ **$3.00** across the plan mix.

| Monthly visitors | Players | Payers/mo | Gross MRR | Net after MoR (~5% + $0.50) |
|---|---|---|---|---|
| 3,000 | 900 | ~9 | ~$27 | ~$21 |
| 30,000 | 9,000 | ~90 | ~$270 | ~$210 |
| 200,000 | 60,000 | ~600 | ~$1,800 | ~$1,660 |

Read the top row honestly: **traffic is the whole game.** Which is why lines 1 and 3 matter early — they don't depend on volume. And why the daily challenge share grid matters: it's the only mechanic here with a chance of moving you from row one to row three without an ad budget.

Retention reality check: mobile puzzle games average roughly **4.5% D7** and **1.2% D30** retention. Anything you build should assume most people vanish. The daily-streak loop and the day-streak counter exist to fight exactly that.

---

## 4. Getting paid in USD from India

**Use a merchant of record.** An MoR becomes the legal seller: it collects the money, charges and remits US sales tax / EU VAT / GST in 40+ jurisdictions, handles chargebacks and invoices, and pays you net. You are then a service provider exporting to one company, not a global tax filer.

| Option | Cost (2026) | Verdict for you |
|---|---|---|
| **Lemon Squeezy** (Stripe-owned) | 5% + $0.50, no monthly fee | **Start here.** Built for indie sellers; licence keys, subscriptions, dunning and affiliates included. Note: some Indian merchants have reported slower onboarding — apply early. |
| Polar | cheapest MoR | Cheap, developer-focused, but thinner subscription tooling and narrower jurisdiction coverage |
| Paddle | 5% + $0.50, +3% non-domestic currency | Built for $1M+ ARR; stricter acceptance criteria for Indian sellers |
| Razorpay / Stripe India direct | ~2–3% | Cheaper, but *you* become the merchant of record and own every tax nexus. Not worth it at this size. |

At $270 MRR the MoR costs you about $60/month. That is the cheapest tax department you will ever hire.

**The India-side items to settle with a CA before your first payout:** whether you invoice as a sole proprietor or a private limited company; export-of-services treatment under GST and whether you file an LUT to avoid paying IGST on exports; FIRA/FIRC documentation for inward remittance (at least one comparison notes Paddle does not auto-generate India-format FIRA — confirm what your chosen MoR provides); and how the income is treated for advance tax. Get this right at $200 MRR, not at $20,000.

**Also collect INR separately.** For Indian tutors and franchise buyers, run a Razorpay/UPI link at Indian price points (₹199/yr Pro, ₹4,999/yr tutor licence). Same product, two rails, no PPP resentment.

---

## 5. The technical gap you must close before charging anyone

Right now Pro entitlement is stored **in the browser**. That is fine for a demo and unacceptable for a paid product: it doesn't survive a cleared cache, doesn't cross devices, and can be flipped by anyone who opens devtools.

Before you take the first dollar, in this order:

1. **Accounts** — email magic-link or Google sign-in (Supabase or Clerk; a weekend of work).
2. **Server-side entitlement** — a `users` table with `plan`, `status`, `current_period_end`. The client asks the server whether it's Pro; it never decides for itself.
3. **MoR webhooks** — handle `subscription_created`, `updated`, `cancelled`, `payment_failed`. This is what makes cancellations and failed cards actually work.
4. **Licence validation endpoint** — a serverless function that proxies the store's licence check. Set `CONFIG.licenceApi` to it. Never put a store API key in the browser.
5. **Cloud-synced stats** — this is also a Pro feature *and* your retention moat: nobody abandons an app holding a 40-day streak.

Until step 2 exists, the honest move is to sell **Lifetime licence keys only** (a key is a one-time entitlement — much harder to get wrong) and add subscriptions after.

---

## 6. Getting the first 1,000 players

Free channels, in the order they'll actually work:

1. **The share grid.** Wordle's entire growth engine was a spoiler-free result you could paste anywhere. Yours is built. Make sure the shared text carries the URL — it does.
2. **Reddit, played straight.** r/mentalmath, r/webgames, r/InternetIsBeautiful, r/SideProject. Post the thing, answer every comment, don't market at people.
3. **Show HN** — "I built a mental-math fitness tracker." HN loves speed, hates signup walls. Your free tier having no login is the pitch.
4. **Portals** (line 1 above) — they bring both cash and traffic.
5. **SEO long tail** — one landing page per drill: "times table speed test", "mental math practice online", "10 minute maths workout". Low competition, buyer intent, compounds for years.
6. **Tutors, one at a time.** DM 50 maths tutors on Instagram/YouTube. Offer a free tutor licence for feedback. Ten of them mentioning it to students beats any ad you could buy.
7. **PWA install prompt**, then wrap for Play Store once retention justifies it — the app stores take 15–30% and demand review cycles, so earn your way there.

---

## 7. Ninety days

**Days 1–30 — make it sellable**
Accounts + server entitlement + one MoR (Lemon Squeezy) live with Lifetime keys only. Plausible analytics wired to the existing event bus. Landing page. Ship the drills-from-your-misses feature — it's the actual reason to pay. Target: first $100 collected, from anyone.

**Days 31–60 — traffic**
Show HN + Reddit + Product Hunt. Submit to four portals. Turn on subscriptions once webhooks are proven. Publish three SEO drill pages. Email 50 tutors. Target: 5,000 monthly visitors, 10 paying users, one portal deal signed.

**Days 61–90 — tune the funnel**
Read the real numbers and adjust one variable at a time. Is `freeRuns: 5` too generous or too mean? Where do people abandon the paywall? Which game has the best D7? Ship a leaderboard for the daily. Package the tutor tier properly with a teacher dashboard. Target: $300–500 MRR, or a clear read on which line (Pro vs B2B) deserves the next quarter.

---

## 8. The five numbers to watch

Everything else is vanity.

1. **D7 retention** — under 3% means the loop is broken; fix that before spending anything on traffic.
2. **Paywall view → purchase** — under 2% means the wall is in the wrong place or Pro isn't worth $30 yet.
3. **Runs per player per day** — if it's under 2, the free cap of 5 is irrelevant and nobody will ever hit the wall.
4. **Daily challenge completion rate** — your growth engine's health.
5. **Net revenue per paying user** — after MoR fees and refunds. The only revenue figure that's real.

The event bus in the app already fires everything you need for all five: `app_open`, `game_start`, `game_end`, `daily_start`, `daily_end`, `limit_hit`, `paywall_view`, `plan_click`, `checkout_open`, `licence_ok`, `licence_fail`, `reward_watch`, `share_click`, `pro_active`. Point `window.plausible` at your account and the funnel populates itself.

---

## 9. Honest risks

- **A funded competitor with the same idea.** Matiks has $3.14M and multiplayer. Your defence is a narrower, sharper product for people who want measurement, not competition — and a B2B line they aren't chasing.
- **Traffic never arrives.** Most likely failure mode. Mitigation: lines 1 and 3 earn without traffic.
- **Cognitive-training efficacy claims.** The science on brain training transferring to general intelligence is contested. Never claim MindSharp makes anyone smarter. Claim what you can measure: faster and more accurate arithmetic. That's true, provable, and lawsuit-proof.
- **Ads too early.** Turning ads on at 100 DAU earns $3 and costs you the ad-free positioning that justifies Pro. Hold the line.
- **Attention split.** This is a third venture alongside Fynd and Mobizo. Decide up front whether MindSharp is a $500/month side line (fine — then do lines 1 and 3 only, skip the infrastructure) or something you're funding with real weekends. Half-committing produces the worst version of both.

---

## Config checklist

Open the `CONFIG` block (`public/js/config.js` after the Phase 0 refactor; the top of the `<script>` in the original `mindsharp.html`) and fill in:

```js
checkout:{ monthly:"", yearly:"", lifetime:"" }  // Lemon Squeezy buy URLs
licenceApi:""                                     // your serverless validate endpoint
prices:{ monthly:"$4.99", yearly:"$29.99", lifetime:"$69" }
ads:{ enabled:false, ... }                        // leave false until ~1,000 DAU
freeRuns:5                                        // your main conversion lever
```

Until then, "Preview Pro in this browser (demo)" in the paywall unlocks everything locally so you can test the full experience, and the licence field accepts demo keys shaped like `MS-4KQ2-A19Z`.
