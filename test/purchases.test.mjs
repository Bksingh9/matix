import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

/* Native in-app purchase verification.
 *
 * The property that matters: the client is never believed. It hands over a
 * token; the server asks the store. Everything below either proves that or
 * proves a refusal path works. */

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d';
const TOKEN = 'tok-iap';
let sb, verify, realFetch;
let stores = {};

/* A throwaway EC key so the Apple JWT signer runs for real. */
const { privateKey: appleKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const { privateKey: rsaKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const jws = obj => 'x.' + Buffer.from(JSON.stringify(obj)).toString('base64url') + '.y';

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.ANDROID_PACKAGE_NAME = 'app.mindsharp.game';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: rsaKey });
  process.env.APPLE_KEY_ID = 'ABC123';
  process.env.APPLE_ISSUER_ID = 'issuer-1';
  process.env.APPLE_BUNDLE_ID = 'app.mindsharp.game';
  process.env.APPLE_PRIVATE_KEY = appleKey;
  process.env.IAP_PRODUCT_MONTHLY = 'mindsharp.pro.monthly';
  process.env.IAP_PRODUCT_YEARLY = 'mindsharp.pro.yearly';
  process.env.IAP_PRODUCT_LIFETIME = 'mindsharp.pro.lifetime';

  sb = await fakeSupabase();
  sb.tables.__tokens = { [TOKEN]: { id: USER, email: 'p@example.com', user_metadata: {} } };
  process.env.SUPABASE_URL = sb.url;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }), { status: 200 });
    }
    for (const [prefix, handler] of Object.entries(stores)) {
      if (u.startsWith(prefix)) {
        const r = typeof handler === 'function' ? handler(u, opts) : handler;
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return realFetch(url, opts);
  };

  verify = (await import('../api/purchases/verify.js')).default;
});

after(async () => { globalThis.fetch = realFetch; await sb?.close(); });

const future = () => new Date(Date.now() + 30 * 86400000);

beforeEach(() => {
  sb.tables.profiles = [{ id: USER, email: 'p@example.com' }, { id: OTHER, email: 'o@example.com' }];
  sb.tables.entitlements = [];
  // The limiter is shared state and it works — 20 calls per 10 minutes on
  // this bucket. Without a reset the later tests get 429s.
  sb.tables.rate_limits = [];
  sb.requests.length = 0;
  stores = {
    'https://androidpublisher.googleapis.com': (u) => {
      if (u.includes(':acknowledge')) return { status: 200, body: {} };
      if (u.includes('subscriptionsv2')) {
        return {
          status: 200,
          body: {
            subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
            acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
            latestOrderId: 'GPA.1234',
            lineItems: [{ productId: 'mindsharp.pro.yearly', expiryTime: future().toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }]
          }
        };
      }
      return { status: 200, body: { purchaseState: 0, acknowledgementState: 0, orderId: 'GPA.9999' } };
    },
    'https://api.storekit.itunes.apple.com': (u) => {
      if (u.includes('/history/')) {
        return { status: 200, body: { signedTransactions: [jws({ productId: 'mindsharp.pro.lifetime', originalTransactionId: '200000111', bundleId: 'app.mindsharp.game' })] } };
      }
      return {
        status: 200,
        body: {
          data: [{
            lastTransactions: [{
              status: 1,
              signedTransactionInfo: jws({ productId: 'mindsharp.pro.yearly', originalTransactionId: '200000222', bundleId: 'app.mindsharp.game', expiresDate: future().getTime() }),
              signedRenewalInfo: jws({ autoRenewStatus: 1 })
            }]
          }]
        }
      };
    }
  };
});

async function call(body, token = TOKEN) {
  const req = mockReq({
    method: 'POST', url: '/api/purchases/verify',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body
  });
  const res = mockRes();
  await verify(req, res);
  await res.done;
  return res;
}

const ent = () => sb.tables.entitlements[0];

describe('the client is never believed', () => {
  test('an unauthenticated request never reaches a store', async () => {
    let touched = false;
    stores['https://androidpublisher.googleapis.com'] = () => { touched = true; return { status: 200, body: {} }; };
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'tok' }, null);
    assert.equal(res.statusCode, 401);
    assert.equal(touched, false);
  });

  test('a product the server does not know is refused, not guessed at', async () => {
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.free_please', purchaseToken: 'abcdefghijkl' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'unknown_product');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('an unknown platform is refused', async () => {
    const res = await call({ platform: 'windows', productId: 'mindsharp.pro.yearly', purchaseToken: 'abcdefghijkl' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'bad_platform');
  });

  test('a garbage token is refused before any network call', async () => {
    for (const bad of [undefined, '', 'x', 42, null]) {
      const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: bad });
      assert.equal(res.statusCode, 400, `token ${JSON.stringify(bad)}`);
    }
  });

  test('the plan comes from the product id, not from anything the client says', async () => {
    // The client asks for the product Google will actually confirm, but also
    // sends plan/status/isPro hoping one of them is believed. None is.
    const res = await call({
      platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123',
      plan: 'lifetime', status: 'active', isPro: true
    });
    assert.equal(res.statusCode, 200);
    assert.equal(ent().plan, 'yearly', 'the product mapping wins');
    assert.notEqual(ent().plan, 'lifetime');
  });

  test('claiming a different product than Google confirms is refused', async () => {
    // The mock returns a yearly subscription for this token. Claiming the
    // monthly one is a mislabelling attempt: access would still end on
    // Google's real expiry, but the plan on the account and the receipt would
    // both be wrong. verifyApple already checked this; verifyAndroid did not.
    const res = await call({
      platform: 'android', productId: 'mindsharp.pro.monthly', purchaseToken: 'valid-token-123'
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'product_mismatch');
  });
});

describe('Google Play', () => {
  test('an active subscription grants the mapped plan', async () => {
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.valid, true);
    assert.equal(ent().plan, 'yearly');
    assert.equal(ent().status, 'active');
    assert.equal(ent().source, 'play');
    assert.ok(ent().current_period_end);
  });

  test('an unacknowledged purchase is acknowledged, or Google auto-refunds it', async () => {
    let acknowledged = false;
    const base = stores['https://androidpublisher.googleapis.com'];
    stores['https://androidpublisher.googleapis.com'] = (u, o) => {
      if (u.includes(':acknowledge')) { acknowledged = true; return { status: 200, body: {} }; }
      return base(u, o);
    };
    await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123' });
    assert.equal(acknowledged, true, 'three days unacknowledged is an automatic refund');
  });

  test('a cancelled subscription keeps access to the expiry date', async () => {
    stores['https://androidpublisher.googleapis.com'] = () => ({
      status: 200,
      body: {
        subscriptionState: 'SUBSCRIPTION_STATE_CANCELED',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        lineItems: [{ productId: 'mindsharp.pro.yearly', expiryTime: future().toISOString() }]
      }
    });
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123' });
    assert.equal(res.json.status, 'cancelled');
    assert.equal(ent().cancel_at_period_end, true);
    assert.ok(ent().current_period_end, 'and they keep it until then');
  });

  test('a grace period keeps access while Google retries the card', async () => {
    stores['https://androidpublisher.googleapis.com'] = () => ({
      status: 200,
      body: {
        subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        lineItems: [{ productId: 'mindsharp.pro.monthly', expiryTime: future().toISOString() }]
      }
    });
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.monthly', purchaseToken: 'valid-token-123' });
    assert.equal(res.json.status, 'past_due');
  });

  test('an expired subscription grants nothing', async () => {
    stores['https://androidpublisher.googleapis.com'] = () => ({
      status: 200,
      body: { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', lineItems: [{ productId: 'mindsharp.pro.yearly', expiryTime: '2020-01-01T00:00:00Z' }] }
    });
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123' });
    assert.equal(res.statusCode, 200);
    assert.equal(ent().status, 'expired');
  });

  test('a refunded one-time purchase grants nothing', async () => {
    stores['https://androidpublisher.googleapis.com'] = () => ({ status: 200, body: { purchaseState: 1, acknowledgementState: 1 } });
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.lifetime', purchaseToken: 'valid-token-123' });
    assert.equal(ent().status, 'refunded');
  });

  test('a token Google has never seen is a 404, not a grant', async () => {
    stores['https://androidpublisher.googleapis.com'] = () => ({ status: 404, body: { error: { message: 'not found' } } });
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'made-up-token-xyz' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json.error, 'purchase_not_found');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('a Google outage is a 502, never a silent grant', async () => {
    stores['https://androidpublisher.googleapis.com'] = () => ({ status: 503, body: { error: { message: 'backend error' } } });
    const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123' });
    assert.equal(res.statusCode, 502);
    assert.equal(sb.tables.entitlements.length, 0);
  });
});

describe('Apple', () => {
  test('an active subscription grants the mapped plan', async () => {
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    assert.equal(res.statusCode, 200);
    assert.equal(ent().plan, 'yearly');
    assert.equal(ent().status, 'active');
    assert.equal(ent().source, 'appstore');
  });

  test('a lifetime purchase grants lifetime with no expiry', async () => {
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.lifetime', transactionId: '200000111' });
    assert.equal(res.statusCode, 200);
    assert.equal(ent().plan, 'lifetime');
    assert.equal(ent().current_period_end, null);
  });

  test('a transaction for a different app is refused', async () => {
    stores['https://api.storekit.itunes.apple.com'] = () => ({
      status: 200,
      body: {
        data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: jws({ productId: 'mindsharp.pro.yearly', originalTransactionId: '1', bundleId: 'com.someone.else', expiresDate: future().getTime() }), signedRenewalInfo: jws({}) }] }]
      }
    });
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'bundle_mismatch');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('a transaction for a different product is refused', async () => {
    // Buy the cheapest thing, claim it was the most expensive. A lifetime
    // claim reads the history endpoint, so that is what is stubbed.
    stores['https://api.storekit.itunes.apple.com'] = () => ({
      status: 200,
      body: {
        signedTransactions: [jws({
          productId: 'mindsharp.pro.monthly',
          originalTransactionId: '200000333',
          bundleId: 'app.mindsharp.game'
        })]
      }
    });
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.lifetime', transactionId: '200000222' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'product_mismatch');
    assert.equal(sb.tables.entitlements.length, 0, 'and nothing is granted');
  });

  test('a revoked transaction grants nothing', async () => {
    stores['https://api.storekit.itunes.apple.com'] = () => ({
      status: 200,
      body: { signedTransactions: [jws({ productId: 'mindsharp.pro.lifetime', originalTransactionId: '1', bundleId: 'app.mindsharp.game', revocationDate: Date.now() })] }
    });
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.lifetime', transactionId: '200000111' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'purchase_refunded');
  });

  test('a billing-retry transaction keeps access', async () => {
    stores['https://api.storekit.itunes.apple.com'] = () => ({
      status: 200,
      body: {
        data: [{ lastTransactions: [{ status: 3, signedTransactionInfo: jws({ productId: 'mindsharp.pro.monthly', originalTransactionId: '1', bundleId: 'app.mindsharp.game', expiresDate: future().getTime() }), signedRenewalInfo: jws({ autoRenewStatus: 1 }) }] }]
      }
    });
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.monthly', transactionId: '200000222' });
    assert.equal(res.json.status, 'past_due');
  });

  test('a malformed transaction id never reaches Apple', async () => {
    let touched = false;
    stores['https://api.storekit.itunes.apple.com'] = () => { touched = true; return { status: 200, body: {} }; };
    for (const bad of ['abc', '../../etc', '1', 'x'.repeat(40)]) {
      const res = await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: bad });
      assert.equal(res.statusCode, 400, `id ${bad}`);
    }
    assert.equal(touched, false);
  });

  test('production is tried before sandbox, so App Review still works', async () => {
    // A production build under review buys against sandbox. An app that only
    // asks production rejects the reviewer's own purchase, and gets rejected.
    const seen = [];
    stores['https://api.storekit.itunes.apple.com'] = () => { seen.push('production'); return { status: 404, body: {} }; };
    stores['https://api.storekit-sandbox.itunes.apple.com'] = () => {
      seen.push('sandbox');
      return {
        status: 200,
        body: { data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: jws({ productId: 'mindsharp.pro.yearly', originalTransactionId: '3', bundleId: 'app.mindsharp.game', expiresDate: future().getTime() }), signedRenewalInfo: jws({ autoRenewStatus: 1 }) }] }] }
      };
    };
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, ['production', 'sandbox'], 'production first, sandbox as the fallback');
    assert.equal(res.json.environment, 'sandbox');
    delete stores['https://api.storekit-sandbox.itunes.apple.com'];
  });
});

describe('one purchase, one account', () => {
  test('a transaction already attached elsewhere is refused, not transferred', async () => {
    sb.tables.entitlements = [{ id: 1, user_id: OTHER, store_txn_id: 'apple:200000222', plan: 'yearly', status: 'active' }];
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'purchase_in_use');
    assert.equal(sb.tables.entitlements[0].user_id, OTHER, 'the original owner keeps it');
  });

  test('re-verifying the same purchase on the same account is fine', async () => {
    await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    const res = await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    assert.equal(res.statusCode, 200, 'restore-purchases must not fail');
    assert.equal(sb.tables.entitlements.length, 1);
  });

  test('a store purchase writes the same entitlements row as any other rail', async () => {
    // One definition of Pro; nothing downstream needs to know who paid.
    await call({ platform: 'ios', productId: 'mindsharp.pro.yearly', transactionId: '200000222' });
    const row = ent();
    assert.equal(row.user_id, USER);
    assert.ok(['active', 'cancelled', 'past_due'].includes(row.status));
    assert.ok(row.plan);
    const { isPro } = await import('../lib/entitlement.js');
    assert.equal(isPro(row), true, 'and isPro reads it without special-casing');
  });
});

describe('missing configuration', () => {
  test('unconfigured billing is a 503, not a crash and not a grant', async () => {
    const saved = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    try {
      const res = await call({ platform: 'android', productId: 'mindsharp.pro.yearly', purchaseToken: 'valid-token-123' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json.error, 'billing_not_configured');
      assert.equal(sb.tables.entitlements.length, 0);
    } finally {
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = saved;
    }
  });
});
