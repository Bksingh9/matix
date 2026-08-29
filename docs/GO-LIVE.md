# Go-live checklist

The code is done. What is left is account setup and exercising the payment
paths against real test-mode events — the parts that need credentials nobody
can create on your behalf.

Work top to bottom; each step depends on the one before.

---

## 1. Supabase

- [ ] Create a project. Note the project URL, the anon key, and the service-role key.
- [ ] Run the SQL in order in the SQL editor: `sql/001_schema.sql`, `002_rls.sql`,
      `003_views.sql`, `005_progression.sql`, `006_store_purchases.sql`.
      Skip `004_seed_dev.sql` — it grants a comp entitlement and is dev only.
- [ ] Authentication → Providers → Email: enable magic links, disable "confirm email"
      (a magic link *is* the confirmation), and set the site URL and redirect URL
      to your deployed origin.
- [ ] Run the RLS proof:
      ```bash
      SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run verify:rls
      ```
      **Every check must pass.** If an anon client can write `entitlements`,
      stop — anyone can grant themselves Pro from the browser console and the
      rest of this checklist is theatre.

## 2. Lemon Squeezy

Full detail and the ten spec-vs-live differences are in `docs/LEMONSQUEEZY.md`.

- [ ] Create the store. Note the store id.
- [ ] Create three variants: monthly $4.99, yearly $29.99, lifetime $69. Note each variant id.
- [ ] Enable licence keys **on the lifetime variant only**.
- [ ] Create an API key.
- [ ] Create a webhook pointing at `https://<your-domain>/api/webhooks/lemonsqueezy`,
      with a signing secret, subscribed to:
      `order_created`, `order_refunded`, `subscription_created`,
      `subscription_updated`, `subscription_cancelled`, `subscription_resumed`,
      `subscription_paused`, `subscription_unpaused`, `subscription_expired`,
      `subscription_payment_success`, `subscription_payment_failed`,
      `subscription_payment_recovered`, `subscription_payment_refunded`,
      `license_key_created`, `license_key_updated`.
      There is no cost to receiving one we ignore; a missing one is a wrong entitlement.

## 3. Vercel

- [ ] Import the repo.
- [ ] Set every variable from `.env.example` for Production and Preview.
      Test mode issues **separate** keys and variant ids — point Preview at the
      test store and Production at the live one.
- [ ] Deploy. The build runs `check:secrets` and `check:prod` first and will
      fail rather than ship a free-Pro button or a leaked key.
- [ ] Set `APP_URL` to the production origin. Checkout redirects back to
      `?checkout=success`, which is what starts the entitlement poll.
- [ ] Set `CRON_SECRET` to a long random string. `vercel.json` schedules
      `/api/league/settle` for 00:05 UTC every Monday; the endpoint refuses any
      call that does not carry it. Without the secret set the cron 401s and
      **leagues never settle** — players sit in a week that has already ended.
- [ ] After the first Monday, confirm it ran: Vercel → Project → Cron Jobs
      should show a 200 with `{"count":1}`, `league_standing` should hold a row
      per player with `last_result`, and the finished season's `league_members`
      should be empty — that emptying is what stops a season settling twice.

## 4. Exercise the event map

This is Phase 2's acceptance criterion, and the one thing the test suite cannot
do for you. Use Lemon Squeezy test mode against your Preview deployment. After
each step, reload the app and confirm the Pro state matches.

- [ ] **Buy monthly** → Pro within seconds. Check `entitlements`: `plan=monthly`,
      `status=active`, `current_period_end` set, `ls_subscription_id` set.
- [ ] **Cancel** → `status=cancelled`, `cancel_at_period_end=true`, and
      **access continues**. The account sheet should say "Cancelled — your
      access runs until <date>".
- [ ] **Resume** → back to `active`.
- [ ] **Force expiry** → `status=expired`, Pro gone, Pro cards locked again.
- [ ] **Fail a payment** (test card `4000 0000 0000 0341`) → `status=past_due`
      and **access continues** through the dunning window.
- [ ] **Recover the payment** → back to `active`.
- [ ] **Refund an order** → `status=refunded`, Pro gone immediately.
- [ ] **Buy lifetime** → `plan=lifetime`, `current_period_end` null, and a
      licence key in your email.
- [ ] **Redeem that key on a second account** → 409 `key_in_use`, refused.
- [ ] **Redeem it on a fresh browser, same account** → unlocks Pro.
- [ ] **Delete an account holding a live subscription** → the subscription is
      cancelled in Lemon Squeezy *before* the account goes, and the user row is
      gone from `auth.users`. Check the dashboard: an account deleted while
      still billing is a chargeback with nobody left to refund.
- [ ] **Replay a webhook** from the Lemon Squeezy dashboard → 200 with
      `duplicate: true`, no second row written.
- [ ] **Send a request with a bad signature** (curl it) → 401, nothing written.

Then confirm nothing was quietly dropped:

```sql
select id, event_name, resolve_note, processed_at
from webhook_events where unresolved order by processed_at desc;
```

Any row here is someone who paid and got nothing. It should be empty.

## 5. Analytics

- [ ] Create a Plausible site for your domain.
- [ ] Set `CONFIG.analytics.plausible.domain` in `public/js/config.js`.
- [ ] Deploy, play a round, buy something in test mode, and confirm these land:
      `app_open`, `game_start`, `game_end`, `daily_start`, `daily_end`,
      `limit_hit`, `paywall_view`, `plan_click`, `checkout_open`,
      `licence_ok`, `licence_fail`, `reward_watch`, `share_click`, `pro_active`.
      These fourteen are the ones `npm run check:events` guards; the build
      fails if any of them stops firing.
- [ ] Build the five numbers from `MONETISATION_PLAN.md` §8 as dashboard goals:
      D7 retention, paywall view → purchase, runs per player per day, daily
      completion rate, net revenue per paying user.
- [ ] Add the retention events as a second dashboard — these are how you find
      out whether phases 7–12 actually did anything: `level_up`,
      `achievement_unlocked`, `streak_milestone`, `install_prompt_shown`,
      `app_installed`, `notify_enabled`, `notify_denied`, `notification_opened`.
      `notify_denied` climbing is the alarm: a denial on iOS is permanent, so
      it means the ask is firing too early for too many people.

## 6. Final pre-launch pass

**Run `npm run preflight` first.** It asks Supabase and Lemon Squeezy directly
rather than reading your variables back to you, and it catches the four
mistakes that only surface once a card has been charged: a variant id wired to
the wrong billing interval, an anon key and a service key from two different
projects, RLS not actually on, and a webhook secret that was never set. It
prints no secret values, so its output is safe to paste into a bug report.

Everything below is what it cannot check for you.

- [ ] `npm run verify` — everything green.
- [ ] `FORCE_PROD_CHECK=1 npm run check:prod` — green.
- [ ] Open the production paywall and confirm the "Preview Pro" button is
      **not** visible.
- [ ] Read `/legal/terms`, `/legal/privacy`, `/legal/refunds` and replace
      `support@mindsharp.app` with an address you actually read.
- [ ] Play every mode on a real phone. The e2e suite runs at 420×900, which is
      not the same as a thumb on glass.
- [ ] Confirm the daily challenge share text carries the URL — that is the only
      growth mechanic in the product that costs nothing.

**The web product can launch here.** Everything below is the store apps, and
none of it blocks taking the first payment.

---

# Part two: the store apps

`docs/MOBILE.md` has the build detail. This is the ordering and the things
that are easy to discover only after a rejection.

## 7. The PWA

Free, and it ships the moment section 3 does — but confirm it works, because a
broken manifest fails silently.

- [ ] Load the production site in Chrome on Android. The install prompt should
      be offered after a completed run, not on first paint.
- [ ] Install it, go into airplane mode, and open it. Every mode must be
      playable; runs queue and flush on reconnect.
- [ ] Lighthouse → Installability: no warnings. If the icons or scope look
      wrong, someone ran `capacitor-assets` on its own — run
      `npm run assets:native`, which fixes the manifest afterwards.
- [ ] Confirm `/api/*` is never served from cache: sign out in one tab and
      reload another. If a stale `/api/me` were cached, entitlement would be
      cacheable, which is the whole hole this design closes.

## 8. Store products

Create these **before** building anything, in both consoles. A build cannot
buy a product that does not exist yet, and neither console lets you test
against a draft.

- [ ] Play Console → Monetise → Products: two subscriptions and one one-off,
      with ids matching `IAP_PRODUCT_MONTHLY`, `IAP_PRODUCT_YEARLY`,
      `IAP_PRODUCT_LIFETIME`.
- [ ] App Store Connect → same three, same ids.
- [ ] Set `IAP_PRODUCT_*` in Vercel. An id that is not in that map is
      **refused**, not guessed — check the function logs for
      `[iap] unmapped product`.
- [ ] Google service account with "View financial data" on the app, its JSON
      into `GOOGLE_SERVICE_ACCOUNT_JSON`, and `ANDROID_PACKAGE_NAME` set.
- [ ] Apple In-App Purchase key (.p8) → `APPLE_KEY_ID`, `APPLE_ISSUER_ID`,
      `APPLE_PRIVATE_KEY`, `APPLE_BUNDLE_ID`.

Prices should match the web tier. You net less through the stores (15–30%
versus 5%), but pricing the app higher to recover it reads as a penalty for
using the platform, and Apple's rules stop you explaining why.

## 9. Android release

- [ ] Generate the signing key and back it up somewhere you will still have in
      five years. Losing it means you can never update the listing again.
- [ ] `npm run android:bundle`, upload the AAB to a **closed test** track.
- [ ] Serve `/.well-known/assetlinks.json` with the release fingerprint from
      Play Console → Setup → App integrity. Without it App Links fail silently
      and open the browser instead.
- [ ] Complete the Data safety form: you collect email and gameplay data tied
      to an account. It must agree with `public/legal/privacy.html`.
- [ ] Content rating: Everyone. No violence, no chat, no user content.

## 10. iOS release

- [ ] Open `ios/App/App.xcworkspace` (the workspace, not the project), set the
      team, and add the **Push Notifications** and **In-App Purchase**
      capabilities. Missing the latter is why StoreKit returns no products.
- [ ] Serve `/.well-known/apple-app-site-association` — no file extension,
      `Content-Type: application/json` — and add Associated Domains.
- [ ] Archive, upload, and set up a sandbox tester in App Store Connect.
- [ ] App Review Information: a demo account set to `plan='comp'`, with the
      credentials. A reviewer who cannot see the Pro features rejects for
      "incomplete functionality".

## 11. Exercise native purchase

The store equivalent of section 4, and just as unskippable. Use a Play closed
tester and an iOS sandbox account — neither is charged.

- [ ] **Buy yearly on Android** → Pro within seconds. Check `entitlements`:
      `source='play'`, `plan='yearly'`, `store_txn_id` set.
- [ ] **Buy yearly on iOS** → same, `source='appstore'`.
- [ ] **Sign in on the web with that account** → still Pro. One entitlement,
      three rails; this is the check that proves it.
- [ ] **Buy on the web, then open the app** → Pro, and the app must **not**
      offer to sell it again.
- [ ] **Reinstall and press Restore Purchases** → Pro returns. Apple requires
      this button exists and works; it is on the paywall, native builds only.
- [ ] **Try to redeem the same purchase on a second account** → refused. Same
      rule as licence keys: one purchase, one account, never a silent transfer.
- [ ] **Send a forged receipt** (curl `/api/purchases/verify` with a made-up
      token) → refused. The client is not believed about anything.
- [ ] **Cancel in the store** → access continues to period end, then stops.
- [ ] Confirm the account sheet sends a store subscriber to the **store's**
      cancellation flow, not the Lemon Squeezy portal. That is what
      `entitlement.source` is for.
- [ ] **Try to delete the account while a store subscription is live** →
      refused, naming the right store. Deleting would leave their card being
      charged for a product with no account behind it.

## 12. Notifications

- [ ] Play a run on a device, build a 3-day streak, and confirm the permission
      ask appears **then** — not on first launch. Asking early gets denied, and
      iOS never asks twice.
- [ ] Confirm the reminder fires in the evening only on a day with no run, and
      not at all on a day you played.
- [ ] Deny permission and confirm the app never asks again and never nags.
- [ ] Remote push needs Firebase (`google-services.json`) and an APNs key.
      Local reminders — the ones that do the retention work — do not.

## 13. Not yet

**No ads until roughly 1,000 daily actives.** Turning them on at 100 DAU earns
about three dollars and costs the ad-free positioning that justifies the $30
subscription. Also still off: duels, and anything with user-generated content
(it would change the age rating and add moderation you have no capacity for).

---

## If something goes wrong

**A customer paid and has no Pro.** Check `webhook_events` for an `unresolved`
row matching their email. The full payload is stored; grant manually with:

```sql
update entitlements
set plan = 'lifetime', status = 'active', source = 'manual', updated_at = now()
where user_id = (select id from profiles where lower(email) = lower('them@example.com'));
```

Then work out why attribution missed — usually a checkout created outside
`/api/checkout`, which is the only path that attaches `custom_data.user_id`.

**Everyone lost Pro at once.** Almost certainly `SUPABASE_SERVICE_ROLE_KEY` or
`SUPABASE_URL` is unset or wrong: `/api/me` then answers as anonymous-free.
Check the function logs for `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set`.

**Webhooks return 401.** The signing secret does not match, or something is
parsing the body before the handler sees it. The HMAC is over raw bytes; see
`docs/LEMONSQUEEZY.md`.

**Leagues stopped moving.** The Monday cron did not run or 401'd. Check
`CRON_SECRET` is set in Production, then settle by hand:

```bash
curl -X POST https://<your-domain>/api/league/settle \
  -H "Authorization: Bearer $CRON_SECRET"
```

Safe to re-run: settling drops the season's members, so a second call finds
nothing to rank and changes no standings.

**A store purchase went through and there is no Pro.** Look for the refusal in
the function logs before assuming the store is at fault:

- `[iap] unmapped product` — the product id is not in `IAP_PRODUCT_*`. The
  purchase is real and refundable; add the id and have them Restore Purchases.
- A 409 — the purchase is already attached to another account. Usually someone
  bought signed out, then signed in as someone else.
- A 5xx from the store call — `GOOGLE_SERVICE_ACCOUNT_JSON` or the Apple key is
  wrong, or the service account lost "View financial data".

**The app shows the web checkout.** `startCheckout` routes to native billing
when `isNative()` returns true, which needs `window.Capacitor` to exist. If it
does not, the build is loading a remote URL rather than the bundled `public/`.
Shipping that would get the build rejected for linking to outside payment.

**Everyone on iOS is asking where Restore Purchases went.** It is in the
account sheet, which needs `entitlement.source` to render the right options. If
`/api/me` is failing the sheet degrades to the free view — the fallback is
correct, but the cause is upstream.

**The install prompt never appears.** Chrome only fires
`beforeinstallprompt` once per page load and never on an already-installed
app. If it is genuinely absent, check the manifest icons: `assets:native`
rewrites them and `scripts/fix-manifest.mjs` puts them back, so a manifest
edited by hand after a `capacitor-assets` run is the usual cause.
