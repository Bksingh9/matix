# Lemon Squeezy: spec vs. the live API

Checked against the current Lemon Squeezy documentation and SDK typings in
August 2026, as `MINDSHARP_BUILD_SPEC.md` §9 requires before writing any store
calls. Everything below is a place where the spec and the live API differ, or
where the live API has a behaviour the spec does not mention.

---

## 1. There is no webhook event id — idempotency needs a different key

**Spec §5:** *"Idempotency: insert the event id into `webhook_events` first."*

**Live:** Lemon Squeezy sends no unique delivery identifier. The headers are
`X-Signature` and `X-Event-Name`; `meta.webhook_id` identifies the *webhook
configuration*, not the delivery, so every event from the same endpoint shares
it. Using it as a primary key would make the second event of a customer's life
look like a replay of the first.

**What we do:** the idempotency key is `"<event_name>:<sha256(rawBody)>"`. A
retry replays byte-identical content and collides correctly; two distinct
events differ in their embedded timestamps and do not. Implemented in
`eventId()` in `lib/lemonsqueezy.js`, covered by tests in
`test/lemonsqueezy.test.mjs`.

The residual risk is two genuinely identical payloads being treated as one. For
entitlement writes that is harmless — every write in the handler is idempotent.

## 2. Read the event name from the body, not the header

`X-Event-Name` is convenient but is **not** covered by the HMAC — only the body
is. Trusting the header would let anyone who could replay a captured body
relabel it as a different event. `meta.event_name` from the verified body is
the only trustworthy source.

## 3. The License API is a separate API and needs no API key

**Spec §5:** *"Call Lemon Squeezy's licence validate endpoint with the
server-side API key."*

**Live:** `POST https://api.lemonsqueezy.com/v1/licenses/validate` (and
`/activate`, `/deactivate`) form a distinct API from the main one:

- No `Authorization` header. The licence key is itself the credential.
- `Content-Type: application/x-www-form-urlencoded`, not JSON.
- `Accept: application/json`, not `application/vnd.api+json`.
- Parameters are `license_key`, `instance_id` (validate/deactivate),
  `instance_name` (activate).
- A rejected key comes back as **HTTP 400 with a JSON body**, not a 200 with
  `valid: false`. Treating a 400 as a transport error would report "the licence
  server is down" to a user who simply typed the wrong key.

**What this changes for us:** nothing architecturally. We still proxy it
through `/api/licence/validate`, because the server is what writes the
entitlement row, enforces the 5-per-10-minutes limit, and refuses a key already
bound to another account. It just isn't the API key that makes the proxy
necessary.

## 4. Checkout creation: JSON:API, not a query string

**Spec §5:** `{ "url": "https://…?checkout[custom][user_id]=…" }`

**Live:** the query-string form works only on a pre-existing hosted buy link.
`POST /v1/checkouts` uses JSON:API:

- `Accept` and `Content-Type` are both `application/vnd.api+json`.
- `Authorization: Bearer <api key>`.
- Custom data goes at `data.attributes.checkout_data.custom`.
- `store` and `variant` are **relationships**, not attributes.

**Custom values should be strings.** Lemon Squeezy has historically mangled
non-string custom data on the way back out, which would break attribution
silently. `createCheckout()` sends `String(userId)`.

We implement the API form, and keep `buyLinkWithCustomData()` as a fallback for
a deployment that only has hosted buy links (`CHECKOUT_LINK_MONTHLY` etc.).

## 5. Events the spec's table does not cover

The spec lists nine events. A live store also sends these, and ignoring them
produces wrong entitlements:

| Event | Why it matters | Our mapping |
|---|---|---|
| `subscription_payment_refunded` | A refunded *subscription* payment. Without this, a refunded subscriber keeps access — the subscription status may still read `active`. | `refunded`, revoke now |
| `subscription_paused` | Billing paused. Not covered by the spec at all. | `cancelled` + `cancel_at_period_end`; access runs to the paid period end, then `subscription_expired` arrives |
| `subscription_unpaused` | Billing resumed | `active` |
| `subscription_resumed` | A cancellation was undone before it took effect | `active`, clear `cancel_at_period_end` |
| `subscription_payment_recovered` | Dunning succeeded after a failure | `active` — without this a recovered customer stays `past_due` forever |
| `license_key_updated` | A key was disabled or expired | `expired` when the key's status is `disabled`/`expired` |

## 6. Map the status attribute, not the event name

The spec derives state from which event fired. The payload's
`data.attributes.status` is more reliable, because `subscription_updated` fires
for *every* change and already says what the subscription now is. Lemon
Squeezy's statuses map as:

| Lemon Squeezy | Ours | Pro? |
|---|---|---|
| `on_trial` | `active` | yes |
| `active` | `active` | yes |
| `past_due` | `past_due` | **yes** — dunning window |
| `cancelled` | `cancelled` | until `current_period_end` |
| `paused` | `cancelled` | until `current_period_end` |
| `unpaid` | `expired` | no — dunning exhausted |
| `expired` | `expired` | no |

`mapLsStatus()` returns `null` for anything unrecognised, so a new Lemon
Squeezy status falls back to the event-name mapping rather than being guessed
at.

## 7. `renews_at` vs `ends_at`

An active subscription carries `renews_at` (next billing date). Once
cancellation is scheduled, `ends_at` is set and `renews_at` may be null. Taking
only one of them writes the wrong expiry. We take **whichever is later** — the
moment access is genuinely paid through.

## 8. `order_created` fires for subscriptions too

Granting lifetime on every `order_created` would give a monthly subscriber
permanent access. We only grant when the order's variant is the lifetime
variant; subscription orders are left to `subscription_created`, which is the
event that carries the renewal date.

## 9. Test-mode events

`meta.test_mode` / `data.attributes.test_mode` mark events from the test store.
The spec does not mention them. A test-mode purchase reaching a production
webhook would grant real Pro for free, so the handler ignores test-mode events
when `VERCEL_ENV=production` (and accepts them everywhere else, which is what
makes preview deployments testable).

## 10. `past_due` and `comp` in the isPro rule

Noted here because it is where the spec contradicts itself rather than the API:

- §5 defines `isPro` as `status IN ('active','cancelled')`, but the same
  section says a failed payment should "keep access through the dunning
  window". Excluding `past_due` would revoke access the moment a card fails.
  We include it.
- The §5 formula (`plan = 'lifetime' OR current_period_end > now()`) makes a
  `comp` row with a null period end non-Pro, but Phase 1's acceptance test is
  "set one row to `comp` and confirm Pro unlocks". We include `comp`.

---

## Store setup checklist

1. Create three variants: monthly, yearly, lifetime. Note each variant id into
   `LS_VARIANT_MONTHLY` / `_YEARLY` / `_LIFETIME`.
2. Enable **licence keys** on the lifetime variant only.
3. Create a webhook pointing at `https://<your-domain>/api/webhooks/lemonsqueezy`
   with a signing secret; put it in `LEMONSQUEEZY_WEBHOOK_SECRET`.
4. Subscribe the webhook to every event in §5 above plus the spec's nine. There
   is no cost to receiving one we ignore, and a missing one is a wrong
   entitlement.
5. Create an API key → `LEMONSQUEEZY_API_KEY`. Store id → `LEMONSQUEEZY_STORE_ID`.
6. Test mode issues **separate** keys and variant ids. Point the environment at
   the test store while exercising the event map.

## Exercising the map

`npm test` runs 27 integration tests that drive the real handler against a fake
PostgREST: every row of the spec's event table plus the six events in §5, both
signature-failure paths, replay, all three attribution fallbacks, the
unattributed-event flag, and test-mode isolation.

That is not a substitute for firing real test-mode events at a deployed
endpoint, which is what Phase 2's acceptance criterion asks for — it is what
makes that pass on the first try instead of the fifth.
