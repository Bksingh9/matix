import crypto from 'node:crypto';

/* App Store Server API validation. SERVER ONLY.
 *
 * The client sends a transaction id. We do not verify the receipt it hands us
 * — we ask Apple for the transaction directly, over TLS, authenticated as
 * ourselves. That is both simpler and stronger than parsing a client-supplied
 * JWS: there is nothing to forge if we never read what they sent.
 *
 * (Apple's payloads are still JWS, so responses are decoded below. Decoding is
 * not verification, and it is only ever applied to bytes Apple sent us on a
 * connection we opened.)
 */

const PROD = 'https://api.storekit.itunes.apple.com/inApps/v1';
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1';

const b64url = buf => Buffer.from(buf).toString('base64url');

function config() {
  const keyId = process.env.APPLE_KEY_ID;
  const issuerId = process.env.APPLE_ISSUER_ID;
  const bundleId = process.env.APPLE_BUNDLE_ID;
  const rawKey = process.env.APPLE_PRIVATE_KEY;
  if (!keyId || !issuerId || !bundleId || !rawKey) {
    throw new Error('APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_BUNDLE_ID and APPLE_PRIVATE_KEY must all be set');
  }
  // The .p8 is multi-line; environment UIs mangle newlines, so accept the
  // common escapes and base64 too.
  let key = rawKey.includes('BEGIN') ? rawKey : Buffer.from(rawKey, 'base64').toString('utf8');
  key = key.replace(/\\n/g, '\n');
  return { keyId, issuerId, bundleId, key };
}

/* ES256, signed with the .p8 from App Store Connect. Twenty minutes: Apple
   rejects anything over an hour and there is no reason to sit near the limit. */
function bearer() {
  const { keyId, issuerId, bundleId, key } = config();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: 'appstoreconnect-v1',
    bid: bundleId
  }));
  const signature = crypto.createSign('SHA256')
    .update(`${header}.${payload}`)
    .sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${header}.${payload}.${signature}`;
}

/* Decode a JWS body without verifying it.
 *
 * Safe here and only here: every string passed in arrived in the body of a
 * response to a request WE made, to Apple's host, over TLS, with our own
 * bearer token. Never call this on anything a client sent. */
function decodeJws(jws) {
  if (typeof jws !== 'string') return null;
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function call(path, { sandbox = false } = {}) {
  const base = sandbox ? SANDBOX : PROD;
  const res = await fetch(`${base}/${path}`, {
    headers: { Authorization: `Bearer ${bearer()}`, Accept: 'application/json' }
  });

  if (res.status === 404) {
    const err = new Error('apple_transaction_not_found');
    err.notFound = true;
    err.status = 404;
    throw err;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`apple_api_${res.status}: ${data?.errorMessage || 'unknown'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* Production first, sandbox on a miss.
 *
 * App Review tests against sandbox with a production build, so an app that
 * only ever asks production rejects the reviewer's own purchase and gets
 * rejected in turn. This is the single most common IAP review failure. */
async function callEitherEnvironment(path) {
  try {
    return { data: await call(path, { sandbox: false }), environment: 'production' };
  } catch (e) {
    if (!e.notFound) throw e;
    return { data: await call(path, { sandbox: true }), environment: 'sandbox' };
  }
}

/* The full history for the subscription this transaction belongs to, newest
   first — which is what tells us whether it is still live. */
export async function getTransaction(transactionId) {
  const { data, environment } = await callEitherEnvironment(
    `subscriptions/${encodeURIComponent(transactionId)}`);

  const group = (data.data || [])[0];
  const item = (group?.lastTransactions || [])[0];
  if (!item) {
    const err = new Error('apple_transaction_not_found');
    err.notFound = true;
    throw err;
  }

  const tx = decodeJws(item.signedTransactionInfo) || {};
  const renewal = decodeJws(item.signedRenewalInfo) || {};

  return {
    kind: 'subscription',
    environment,
    productId: tx.productId || null,
    originalTransactionId: tx.originalTransactionId || transactionId,
    expiresAt: tx.expiresDate ? new Date(tx.expiresDate).toISOString() : null,
    status: mapStatus(item.status, tx, renewal),
    autoRenewing: renewal.autoRenewStatus === 1,
    revoked: !!tx.revocationDate,
    bundleId: tx.bundleId || null,
    raw: { tx, renewal, status: item.status }
  };
}

/* A one-time purchase (the lifetime plan) has no subscription group, so it is
   fetched from the transaction history instead. */
export async function getOneTimePurchase(transactionId) {
  const { data, environment } = await callEitherEnvironment(
    `history/${encodeURIComponent(transactionId)}?sort=DESCENDING`);

  const signed = (data.signedTransactions || [])[0];
  const tx = decodeJws(signed) || {};
  if (!tx.productId) {
    const err = new Error('apple_transaction_not_found');
    err.notFound = true;
    throw err;
  }

  return {
    kind: 'product',
    environment,
    productId: tx.productId,
    originalTransactionId: tx.originalTransactionId || transactionId,
    expiresAt: null,
    // A revoked purchase is a refund or a family-sharing removal. Either way
    // access ends.
    status: tx.revocationDate ? 'refunded' : 'active',
    revoked: !!tx.revocationDate,
    bundleId: tx.bundleId || null,
    raw: tx
  };
}

/* Apple's numeric subscription status, plus the two fields that override it. */
export function mapStatus(status, tx = {}, renewal = {}) {
  if (tx.revocationDate) return 'refunded';
  switch (status) {
    case 1: return 'active';
    case 2: return 'expired';
    case 3: return 'past_due';     // billing retry
    case 4: return 'past_due';     // grace period
    case 5: return 'expired';      // revoked
    default:
      // No status field: fall back to the expiry date, failing closed.
      if (!tx.expiresDate) return null;
      return new Date(tx.expiresDate).getTime() > Date.now()
        ? (renewal.autoRenewStatus === 0 ? 'cancelled' : 'active')
        : 'expired';
  }
}

/* App Store Server Notifications v2 arrive as a signed payload. Same rule as
   above: decoding is not verification, so the handler re-reads the
   subscription from the API rather than believing the notification. */
export function decodeNotification(signedPayload) {
  const outer = decodeJws(signedPayload);
  if (!outer) return null;
  return {
    notificationType: outer.notificationType,
    subtype: outer.subtype,
    notificationUUID: outer.notificationUUID,
    transaction: decodeJws(outer.data?.signedTransactionInfo),
    renewal: decodeJws(outer.data?.signedRenewalInfo),
    bundleId: outer.data?.bundleId,
    environment: outer.data?.environment
  };
}

export const isConfigured = () =>
  !!(process.env.APPLE_KEY_ID && process.env.APPLE_ISSUER_ID &&
     process.env.APPLE_BUNDLE_ID && process.env.APPLE_PRIVATE_KEY);
