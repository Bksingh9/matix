# Browser tasks — for a Claude session that can drive Chrome

Everything left between here and taking money is a web form. None of it is
code. This file is written to be **pasted whole** into a Claude session that
has browser control (the Claude in Chrome extension, running locally against a
Chrome you are already signed in to), so it can do the clicking.

It cannot be done from the cloud session that built this: that runs in a
container with no path to your browser, and no GitHub, Supabase, Vercel or
Lemon Squeezy login.

## How to use this

1. Open Claude Code **locally**, on the machine whose Chrome holds your logins.
2. Connect the Chrome extension.
3. Paste the block for the task you want. They are ordered; later ones need
   values from earlier ones.

Every task says what "done" looks like, so the agent can verify rather than
assume.

---

## A hard rule for whoever runs these

**STOP markers are not optional.** Three things in here must be typed by a
human and never by an agent:

- bank account and payout details
- tax identification (PAN, GST, W-8BEN, VAT)
- any password, 2FA code, or recovery phrase

An agent that hits a STOP marker should say what it needs and hand back. This
is not a capability limit — it is that these are legally *yours*, and an
error made by a proxy is still your liability.

Nothing in here should be given an agent that you have not told to stop at
those points.

---

## Task 1 — Supabase project (free tier)

```
Open https://supabase.com/dashboard and sign in.

1. Create a new project.
   - Name: mindsharp
   - Region: whichever is closest to most of your players
   - Database password: STOP — I will type this. Do not generate or read it.
2. Wait for the project to finish provisioning (about two minutes).
3. Go to Project Settings -> API. Report back, WITHOUT pasting the values:
   - the Project URL (this one is safe to paste)
   - confirm an "anon / public" key exists
   - confirm a "service_role" key exists
4. Go to the SQL Editor. Run each of these files from the repo IN ORDER,
   one at a time, confirming each says Success before the next:
      sql/001_schema.sql
      sql/002_rls.sql
      sql/003_views.sql
      sql/005_progression.sql
      sql/006_store_purchases.sql
      sql/007_fix_profiles_rls.sql
   Do NOT run sql/004_seed_dev.sql. It grants a comp entitlement and is for
   development only.
5. Go to Authentication -> Providers and enable Email. Turn OFF "Confirm
   email" only if you want magic links to work without a mail provider.

Done looks like: Table Editor lists profiles, entitlements, runs, attempts,
drills, daily_scores, player_progress, achievements, webhook_events,
rate_limits, league_seasons, league_groups, league_members,
store_notifications — fourteen tables.
```

## Task 2 — Vercel deploy (free tier)

```
Open https://vercel.com and sign in with GitHub.

1. Add New -> Project -> import Bksingh9/matix.
2. Framework preset: Other. Do not set a build command. Output directory:
   public
3. Before deploying, add Environment Variables (Production scope).
   For each one I will tell you the NAME; STOP and let me paste the VALUE.
      SUPABASE_URL
      SUPABASE_ANON_KEY
      SUPABASE_SERVICE_ROLE_KEY
      APP_URL                     (the vercel.app url, once you know it)
      CRON_SECRET                 (any long random string)
   Lemon Squeezy variables come in Task 3.
4. Deploy. Report the deployment url.
5. Re-open the environment variables and set APP_URL to that url, with no
   trailing slash. Redeploy.

Done looks like: opening <deployment>/api/config returns JSON, and it does NOT
contain any key ending in "service_role".
```

## Task 3 — Lemon Squeezy (merchant of record)

```
Open https://app.lemonsqueezy.com and sign in.

STOP FIRST: this step involves business identity, bank details and tax forms.
I will complete the store onboarding myself. Tell me when you reach it.

Once the store exists and is activated:

1. Products -> New Product.
   - Name: MindSharp Pro
   - Then add three variants:
       Monthly   — subscription, billed every 1 month
       Yearly    — subscription, billed every 1 year
       Lifetime  — one-time payment
2. For each variant, open it and report its numeric variant id from the url.
   These are not secret; paste them.
3. Settings -> API -> create a new API key. STOP — do not read or paste the
   key. Tell me it exists and I will put it into Vercel myself.
4. Settings -> Webhooks -> add endpoint:
   - URL: <your APP_URL>/api/webhooks/lemonsqueezy
   - Signing secret: STOP — I will generate and paste this.
   - Events: subscription_created, subscription_updated,
     subscription_cancelled, subscription_resumed, subscription_expired,
     subscription_paused, subscription_unpaused,
     subscription_payment_success, subscription_payment_failed,
     order_created
5. Report the store id — the number in the dashboard url.

Done looks like: three variant ids, a store id, a webhook endpoint listed as
active, and an API key that exists but that nobody has read aloud.
```

## Task 4 — the check that matters

```
Back in the repo, with the environment variables in a local .env.local:

    npm run preflight

Paste me the whole output. It never prints secret values — only lengths and
last four characters — so it is safe to share.

It will tell us, against the LIVE services:
  - whether RLS is actually protecting entitlements
  - whether the two Supabase keys are from the same project
  - whether each variant id is wired to the billing interval its name claims
  - whether the webhook secret and APP_URL are sane

Fix whatever it marks with a red cross, then run it again. Do not take a real
payment until it says "ready to take money".
```

## Task 5 — the first real payment

```
Follow docs/GO-LIVE.md section 11. In short:

1. Buy the yearly plan with a REAL card, on the live site, signed in.
2. Confirm Pro appears in the app within about ten seconds.
3. Confirm a row appears in the Supabase entitlements table.
4. Refund yourself from the Lemon Squeezy dashboard.
5. Confirm Pro is REMOVED within about a minute.

Step 5 is the one people skip, and it is the one that matters: a refund that
does not revoke access is a subscription anybody can get for free.
```

---

## What a browser agent still cannot do

Not because of the tooling, but because they are yours:

- prove your identity to a payment processor
- accept the tax and payout terms
- hold your passwords

Everything else on this page is clicking, and clicking is delegable.
