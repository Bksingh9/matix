import crypto from 'node:crypto';

/* Lemon Squeezy integration. SERVER ONLY — this module reads the API key.

   Verified against the live API in Aug 2026. Where this differs from the
   build spec, the difference is noted inline and in docs/LEMONSQUEEZY.md. */

const API = 'https://api.lemonsqueezy.com/v1';
const LICENSE_API = 'https://api.lemonsqueezy.com/v1/licenses';

/* ============================================================ SIGNATURES */

/* Verify an inbound webhook.

   Two things matter and both are easy to get wrong:
   1. The HMAC is over the RAW request bytes. A body that has been JSON-parsed
      and re-stringified will not match — key order and whitespace change.
   2. The comparison must be timing-safe, and timingSafeEqual throws on a
      length mismatch, so lengths are checked first. */
export function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) throw new Error('LEMONSQUEEZY_WEBHOOK_SECRET is not set');
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(signatureHeader.trim(), 'hex'); } catch { return false; }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

/* Lemon Squeezy does not send a unique delivery id — there is no X-Event-Id
   header, and meta.webhook_id identifies the webhook *configuration*, not the
   delivery. So the idempotency key is a hash of the signed body. A retry
   replays byte-identical content and collides; two distinct events differ in
   their timestamps and do not. */
export function eventId(rawBody, eventName) {
  const h = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 48);
  return `${eventName || 'unknown'}:${h}`;
}

/* ============================================================ PLAN MAPPING */

export function variantToPlan(variantId) {
  const id = String(variantId ?? '');
  if (!id) return null;
  if (id === String(process.env.LS_VARIANT_MONTHLY || '')) return 'monthly';
  if (id === String(process.env.LS_VARIANT_YEARLY || '')) return 'yearly';
  if (id === String(process.env.LS_VARIANT_LIFETIME || '')) return 'lifetime';
  return null;
}

export function planToVariant(plan) {
  return {
    monthly: process.env.LS_VARIANT_MONTHLY,
    yearly: process.env.LS_VARIANT_YEARLY,
    lifetime: process.env.LS_VARIANT_LIFETIME
  }[plan] || null;
}

/* Lemon Squeezy subscription statuses → ours.

   Reading the status attribute beats inferring from the event name: a
   subscription_updated fires for every change, and its payload already says
   what the subscription now is. */
export function mapLsStatus(lsStatus) {
  switch (lsStatus) {
    case 'on_trial':
    case 'active': return 'active';
    case 'past_due': return 'past_due';       // dunning; keep access, LS retries
    case 'cancelled': return 'cancelled';     // access continues to period end
    case 'paused': return 'cancelled';        // billing stopped; honour the paid period, then expire
    case 'unpaid': return 'expired';          // dunning exhausted
    case 'expired': return 'expired';
    default: return null;
  }
}

/* ============================================================ EVENT MAP */

const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created', 'subscription_updated', 'subscription_cancelled',
  'subscription_resumed', 'subscription_paused', 'subscription_unpaused',
  'subscription_expired', 'subscription_payment_success',
  'subscription_payment_failed', 'subscription_payment_recovered',
  'subscription_payment_refunded'
]);

export const KNOWN_EVENTS = new Set([
  ...SUBSCRIPTION_EVENTS,
  'order_created', 'order_refunded',
  'license_key_created', 'license_key_updated'
]);

/* Turn a webhook payload into the entitlement patch it implies, or null when
   the event carries no entitlement change. Pure function — no I/O, so it is
   directly unit-testable against recorded payloads. */
export function entitlementPatch(eventName, payload) {
  const attrs = payload?.data?.attributes || {};
  const dataId = payload?.data?.id != null ? String(payload.data.id) : null;

  if (eventName === 'order_created') {
    // An order fires for subscriptions too. Only a one-time purchase of the
    // lifetime variant grants lifetime here; subscription orders are handled
    // by subscription_created, which carries the renewal date.
    const variantId = firstOrderVariant(attrs);
    const plan = variantToPlan(variantId);
    if (plan !== 'lifetime') return null;
    return {
      plan: 'lifetime',
      status: 'active',
      source: 'lemonsqueezy',
      ls_order_id: dataId,
      ls_customer_id: attrs.customer_id != null ? String(attrs.customer_id) : null,
      ls_variant_id: variantId != null ? String(variantId) : null,
      current_period_end: null,
      cancel_at_period_end: false
    };
  }

  if (eventName === 'order_refunded') {
    return { status: 'refunded', cancel_at_period_end: false, current_period_end: null };
  }

  if (SUBSCRIPTION_EVENTS.has(eventName)) {
    // Refunds revoke immediately regardless of what the status field says.
    if (eventName === 'subscription_payment_refunded') {
      return { status: 'refunded', cancel_at_period_end: false };
    }

    const plan = variantToPlan(attrs.variant_id) || null;
    const patch = {
      source: 'lemonsqueezy',
      ls_subscription_id: dataId,
      ls_customer_id: attrs.customer_id != null ? String(attrs.customer_id) : null,
      ls_variant_id: attrs.variant_id != null ? String(attrs.variant_id) : null
    };
    if (plan) patch.plan = plan;   // covers plan switches on subscription_updated

    // renews_at is the next billing date; ends_at is set once cancellation is
    // scheduled. Take whichever is further out — that is the moment access is
    // genuinely paid through.
    const end = laterOf(attrs.renews_at, attrs.ends_at);
    if (end) patch.current_period_end = end;

    const mapped = mapLsStatus(attrs.status);
    if (mapped) patch.status = mapped;
    else if (eventName === 'subscription_cancelled') patch.status = 'cancelled';
    else if (eventName === 'subscription_expired') patch.status = 'expired';
    else if (eventName === 'subscription_payment_failed') patch.status = 'past_due';
    else if (eventName === 'subscription_payment_success' ||
             eventName === 'subscription_payment_recovered' ||
             eventName === 'subscription_resumed' ||
             eventName === 'subscription_unpaused') patch.status = 'active';
    else if (eventName === 'subscription_created') patch.status = 'active';

    // A cancelled or paused subscription runs to the end of the paid period.
    patch.cancel_at_period_end =
      attrs.cancelled === true ||
      patch.status === 'cancelled' ||
      eventName === 'subscription_cancelled' ||
      eventName === 'subscription_paused';

    // Guard the trap: never write an active subscription with no end date.
    // isPro() fails closed on that, so a partial write would silently revoke.
    if (patch.status === 'active' && plan !== 'lifetime' && !patch.current_period_end) {
      patch._warning = 'active subscription with no renews_at/ends_at';
    }
    return patch;
  }

  if (eventName === 'license_key_created' || eventName === 'license_key_updated') {
    const key = attrs.key || null;
    if (!key) return null;
    const patch = { licence_key: key, source: 'licence' };
    // A disabled or expired key revokes; anything else is left to the order
    // event, which is what actually granted the plan.
    if (attrs.status === 'disabled' || attrs.status === 'expired') patch.status = 'expired';
    return patch;
  }

  return null;
}

function laterOf(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return null;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return ta >= tb ? a : b;
}

/* An order payload carries its line items under first_order_item. */
function firstOrderVariant(attrs) {
  return attrs.first_order_item?.variant_id
    ?? attrs.variant_id
    ?? null;
}

/* Identity hints for attributing an event to a user, most reliable first. */
export function identityHints(payload) {
  const attrs = payload?.data?.attributes || {};
  const custom = payload?.meta?.custom_data || {};
  return {
    userId: custom.user_id != null ? String(custom.user_id) : null,
    customerId: attrs.customer_id != null ? String(attrs.customer_id) : null,
    email: attrs.user_email || attrs.customer_email || attrs.email || null,
    testMode: attrs.test_mode === true || payload?.meta?.test_mode === true
  };
}

/* ============================================================ API CALLS */

function apiKey() {
  const k = process.env.LEMONSQUEEZY_API_KEY;
  if (!k) throw new Error('LEMONSQUEEZY_API_KEY is not set');
  return k;
}

/* Create a checkout with custom_data.user_id attached server-side. That field
   is the only link between a payment and an account: without it a purchase
   arrives with nobody to give it to. */
export async function createCheckout({ variantId, userId, email, redirectUrl, testMode }) {
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  if (!storeId) throw new Error('LEMONSQUEEZY_STORE_ID is not set');

  const body = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          // Custom values must be strings — Lemon Squeezy has historically
          // mangled non-string custom data on the way back out.
          custom: { user_id: String(userId) },
          ...(email ? { email } : {})
        },
        product_options: {
          ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
          enabled_variants: [Number(variantId)]
        },
        ...(testMode === true ? { test_mode: true } : {})
      },
      relationships: {
        store: { data: { type: 'stores', id: String(storeId) } },
        variant: { data: { type: 'variants', id: String(variantId) } }
      }
    }
  };

  const r = await fetch(`${API}/checkouts`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey()}`
    },
    body: JSON.stringify(body)
  });

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* fall through */ }
  if (!r.ok) {
    const detail = data?.errors?.[0]?.detail || text?.slice(0, 300) || `HTTP ${r.status}`;
    const err = new Error(`lemonsqueezy_checkout_failed: ${detail}`);
    err.status = r.status;
    throw err;
  }
  const url = data?.data?.attributes?.url;
  if (!url) throw new Error('lemonsqueezy_checkout_failed: no url in response');
  return { url, checkoutId: data?.data?.id || null };
}

/* Fallback for a plain hosted buy link, where the custom field rides in the
   query string instead. Only used when CHECKOUT_LINK_* is configured and the
   API is not. */
export function buyLinkWithCustomData(baseUrl, userId, email) {
  const u = new URL(baseUrl);
  u.searchParams.set('checkout[custom][user_id]', String(userId));
  if (email) u.searchParams.set('checkout[email]', email);
  return u.toString();
}

/* ---- License API ----------------------------------------------------------
   Note: this is a SEPARATE API from the main one. It takes form-encoded
   bodies, and it does not require the Authorization header — the licence key
   itself is the credential. We still proxy it rather than calling it from the
   browser, because the server is what writes the entitlement row, enforces the
   rate limit, and refuses a key already bound to another account. */

async function licenseCall(path, params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) form.set(k, String(v));

  const r = await fetch(`${LICENSE_API}/${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* fall through */ }
  // A rejected key is answered with 400 and a JSON body, which is a normal
  // outcome rather than a transport failure.
  if (!r.ok && !data) {
    const err = new Error(`lemonsqueezy_license_${path}_failed: HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data || { valid: false, error: `HTTP ${r.status}` };
}

export const validateLicenseKey = (licenseKey, instanceId) =>
  licenseCall('validate', { license_key: licenseKey, instance_id: instanceId });

export const activateLicenseKey = (licenseKey, instanceName) =>
  licenseCall('activate', { license_key: licenseKey, instance_name: instanceName });

export const deactivateLicenseKey = (licenseKey, instanceId) =>
  licenseCall('deactivate', { license_key: licenseKey, instance_id: instanceId });

/* The customer portal is how a subscriber cancels or updates their card
   without emailing you. Read it off the subscription. */
export async function subscriptionPortalUrl(subscriptionId) {
  const r = await fetch(`${API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: {
      Accept: 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey()}`
    }
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  const urls = data?.data?.attributes?.urls || {};
  return urls.customer_portal || urls.update_payment_method || null;
}

/* Cancel a subscription outright. Used when an account is deleted: the
   subscription belongs to the store, not to us, so it keeps billing a card
   for an account that no longer exists unless we say stop.

   Lemon Squeezy treats DELETE as "cancel at period end", not "refund and
   terminate" — the customer keeps what they paid for, which is the same rule
   isPro() applies to `cancelled`. Returns true if the subscription is now
   cancelled or was already gone. */
export async function cancelSubscription(subscriptionId) {
  const r = await fetch(`${API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey()}`
    }
  });
  // 404 means it is not there to cancel, which is the state we wanted.
  return r.ok || r.status === 404;
}

export function isConfigured() {
  return !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID);
}
