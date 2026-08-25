# Go-live checklist

The code is done. What is left is account setup and exercising the payment
paths against real test-mode events — the parts that need credentials nobody
can create on your behalf.

Work top to bottom; each step depends on the one before.

---

## 1. Supabase

- [ ] Create a project. Note the project URL, the anon key, and the service-role key.
- [ ] Run `sql/001_schema.sql`, then `002_rls.sql`, then `003_views.sql` in the SQL editor.
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
- [ ] Build the five numbers from `MONETISATION_PLAN.md` §8 as dashboard goals:
      D7 retention, paywall view → purchase, runs per player per day, daily
      completion rate, net revenue per paying user.

## 6. Final pre-launch pass

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

## 7. Not yet

Per the spec's Phase 7 and the monetisation plan: no leaderboard, no duels, no
Play Store wrapper, and **no ads until roughly 1,000 daily actives**. Turning
ads on at 100 DAU earns about three dollars and costs the ad-free positioning
that justifies the $30 subscription.

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
