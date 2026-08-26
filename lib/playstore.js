import crypto from 'node:crypto';

/* Google Play purchase validation. SERVER ONLY.
 *
 * The client sends a purchase token. We never trust anything else it says —
 * not the product, not the price, not whether it succeeded. We ask Google.
 *
 * Auth is a service-account JWT exchanged for an access token. No SDK: the
 * whole flow is one signed JWT and two fetches, and googleapis pulls in a
 * hundred megabytes to do the same thing.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

let cachedToken = null;   // { token, expiresAt }

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  let sa;
  try {
    // Accept both raw JSON and base64, because one of them always survives
    // the environment-variable UI you happen to be using.
    sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('service account is missing client_email or private_key');
  return sa;
}

const b64url = buf => Buffer.from(buf).toString('base64url');

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signature = crypto.createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign({ key: sa.private_key }, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new Error(`google_auth_failed: ${data?.error_description || data?.error || res.status}`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function call(path) {
  const pkg = process.env.ANDROID_PACKAGE_NAME;
  if (!pkg) throw new Error('ANDROID_PACKAGE_NAME is not set');
  const token = await accessToken();
  const res = await fetch(`${API}/${encodeURIComponent(pkg)}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`play_api_${res.status}: ${data?.error?.message || 'unknown'}`);
    err.status = res.status;
    err.notFound = res.status === 404 || res.status === 400;
    throw err;
  }
  return data;
}

/* Subscriptions, v2. The v1 endpoint is deprecated and reports a different
   shape; v2 is what carries the line-item state we actually need. */
export async function getSubscription(purchaseToken) {
  const data = await call(`purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);

  const line = (data.lineItems || [])[0] || {};
  const state = data.subscriptionState;   // SUBSCRIPTION_STATE_ACTIVE, _CANCELED, ...
  const expiry = line.expiryTime || null;

  return {
    kind: 'subscription',
    productId: line.productId || null,
    expiresAt: expiry,
    // CANCELED still means paid-through-expiry, which is the same rule the
    // Lemon Squeezy path follows. Revoking early earns a chargeback.
    status: mapSubscriptionState(state),
    autoRenewing: line.autoRenewingPlan?.autoRenewEnabled ?? false,
    linkedPurchaseToken: data.linkedPurchaseToken || null,
    acknowledged: data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    orderId: data.latestOrderId || null,
    raw: data
  };
}

/* One-time products — the lifetime plan. */
export async function getProduct(productId, purchaseToken) {
  const data = await call(`purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`);
  return {
    kind: 'product',
    productId,
    // 0 = purchased, 1 = cancelled/refunded, 2 = pending
    status: data.purchaseState === 0 ? 'active' : data.purchaseState === 1 ? 'refunded' : 'pending',
    acknowledged: data.acknowledgementState === 1,
    orderId: data.orderId || null,
    expiresAt: null,
    raw: data
  };
}

/* An unacknowledged purchase is auto-refunded by Google after three days.
   Acknowledging is not optional — it is the difference between a sale and a
   refund the customer did not ask for. */
export async function acknowledge({ productId, purchaseToken, isSubscription }) {
  const pkg = process.env.ANDROID_PACKAGE_NAME;
  const token = await accessToken();
  const path = isSubscription
    ? `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`
    : `purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  const res = await fetch(`${API}/${encodeURIComponent(pkg)}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  // 409 means already acknowledged, which is a success from where we stand.
  if (!res.ok && res.status !== 409) {
    const body = await res.text().catch(() => '');
    throw new Error(`play_acknowledge_failed_${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

export function mapSubscriptionState(state) {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE': return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD': return 'past_due';
    case 'SUBSCRIPTION_STATE_ON_HOLD': return 'past_due';
    case 'SUBSCRIPTION_STATE_CANCELED': return 'cancelled';    // paid through expiry
    case 'SUBSCRIPTION_STATE_EXPIRED': return 'expired';
    case 'SUBSCRIPTION_STATE_PAUSED': return 'cancelled';
    case 'SUBSCRIPTION_STATE_PENDING': return 'none';
    default: return null;
  }
}

/* Real-time developer notifications arrive base64-encoded inside a Pub/Sub
   envelope. Decoding is not verification — the caller still re-reads the
   purchase from the API, because a notification is a hint that something
   changed, not a statement of what is true. */
export function decodeRtdn(body) {
  const encoded = body?.message?.data;
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export const isConfigured = () =>
  !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.ANDROID_PACKAGE_NAME);
