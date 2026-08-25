import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifySignature, eventId, variantToPlan, mapLsStatus, entitlementPatch,
  identityHints, buyLinkWithCustomData, KNOWN_EVENTS
} from '../lib/lemonsqueezy.js';
import { isPro } from '../lib/entitlement.js';

const SECRET = 'whsec_test_secret_value';
const V_MONTHLY = '111111';
const V_YEARLY = '222222';
const V_LIFETIME = '333333';

beforeEach(() => {
  process.env.LS_VARIANT_MONTHLY = V_MONTHLY;
  process.env.LS_VARIANT_YEARLY = V_YEARLY;
  process.env.LS_VARIANT_LIFETIME = V_LIFETIME;
});

const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';

/* Payload shapes mirror the live Lemon Squeezy envelope: meta.event_name,
   meta.custom_data, data.id, data.attributes. */
const subEvent = (event, attrs = {}) => ({
  meta: { event_name: event, custom_data: { user_id: USER }, test_mode: false },
  data: {
    type: 'subscriptions', id: '900001',
    attributes: {
      store_id: 1, customer_id: 55501, order_id: 70001, product_id: 3,
      variant_id: Number(V_YEARLY), status: 'active', cancelled: false,
      renews_at: '2027-08-26T00:00:00.000000Z', ends_at: null,
      user_email: 'buyer@example.com', test_mode: false,
      ...attrs
    }
  }
});

const orderEvent = (event, attrs = {}) => ({
  meta: { event_name: event, custom_data: { user_id: USER }, test_mode: false },
  data: {
    type: 'orders', id: '70001',
    attributes: {
      store_id: 1, customer_id: 55501, user_email: 'buyer@example.com',
      status: 'paid', refunded: false, test_mode: false,
      first_order_item: { id: 1, order_id: 70001, product_id: 3, variant_id: Number(V_LIFETIME) },
      ...attrs
    }
  }
});

describe('signature verification', () => {
  test('accepts a correct HMAC over the raw bytes', () => {
    const body = Buffer.from(JSON.stringify(subEvent('subscription_created')));
    assert.equal(verifySignature(body, sign(body), SECRET), true);
  });

  test('rejects a signature made with the wrong secret', () => {
    const body = Buffer.from('{"a":1}');
    assert.equal(verifySignature(body, sign(body, 'other_secret'), SECRET), false);
  });

  test('rejects a body altered after signing', () => {
    const body = Buffer.from('{"amount":500}');
    const sig = sign(body);
    assert.equal(verifySignature(Buffer.from('{"amount":999}'), sig, SECRET), false);
  });

  test('rejects a re-stringified body — the classic silent failure', () => {
    // JSON.parse + JSON.stringify changes whitespace and key order, so the
    // HMAC no longer matches. This is why the route reads raw bytes.
    const original = '{"meta":{"event_name":"order_created"},  "data":{"id":"1"}}';
    const sig = sign(Buffer.from(original));
    const round = JSON.stringify(JSON.parse(original));
    assert.notEqual(round, original, 'precondition: re-stringify changes the bytes');
    assert.equal(verifySignature(Buffer.from(round), sig, SECRET), false);
  });

  test('rejects missing, empty, non-hex and wrong-length signatures', () => {
    const body = Buffer.from('{"a":1}');
    for (const bad of [null, undefined, '', 'not-hex-at-all', 'ab', sign(body) + 'ff', 123]) {
      assert.equal(verifySignature(body, bad, SECRET), false, `should reject ${String(bad)}`);
    }
  });

  test('throws rather than passing when no secret is configured', () => {
    assert.throws(() => verifySignature(Buffer.from('{}'), 'ab', ''), /WEBHOOK_SECRET/);
  });
});

describe('idempotency key', () => {
  test('identical bytes produce identical ids', () => {
    const body = Buffer.from(JSON.stringify(subEvent('subscription_created')));
    assert.equal(eventId(body, 'subscription_created'), eventId(body, 'subscription_created'));
  });

  test('different payloads produce different ids', () => {
    const a = Buffer.from(JSON.stringify(subEvent('subscription_created')));
    const b = Buffer.from(JSON.stringify(subEvent('subscription_created', { renews_at: '2028-01-01T00:00:00Z' })));
    assert.notEqual(eventId(a, 'subscription_created'), eventId(b, 'subscription_created'));
  });

  test('the same body under different event names does not collide', () => {
    const body = Buffer.from('{"x":1}');
    assert.notEqual(eventId(body, 'subscription_created'), eventId(body, 'subscription_updated'));
  });
});

describe('variant mapping', () => {
  test('maps configured variants to plans', () => {
    assert.equal(variantToPlan(V_MONTHLY), 'monthly');
    assert.equal(variantToPlan(Number(V_YEARLY)), 'yearly');
    assert.equal(variantToPlan(V_LIFETIME), 'lifetime');
  });

  test('an unknown or empty variant maps to nothing', () => {
    assert.equal(variantToPlan('999999'), null);
    assert.equal(variantToPlan(''), null);
    assert.equal(variantToPlan(null), null);
  });

  test('does not match a variant that is merely unset in the environment', () => {
    delete process.env.LS_VARIANT_MONTHLY;
    assert.equal(variantToPlan(''), null);
    assert.equal(variantToPlan(undefined), null);
  });
});

describe('Lemon Squeezy status mapping', () => {
  const cases = {
    on_trial: 'active', active: 'active', past_due: 'past_due',
    cancelled: 'cancelled', paused: 'cancelled', unpaid: 'expired', expired: 'expired'
  };
  for (const [ls, ours] of Object.entries(cases)) {
    test(`${ls} → ${ours}`, () => assert.equal(mapLsStatus(ls), ours));
  }
  test('an unrecognised status maps to nothing rather than guessing', () => {
    assert.equal(mapLsStatus('brand_new_status'), null);
  });
});

/* The spec's requirement is that every row of the event table is exercised
   against a real payload shape, not merely written. */
describe('event → entitlement map', () => {
  test('order_created for the lifetime variant grants lifetime', () => {
    const p = entitlementPatch('order_created', orderEvent('order_created'));
    assert.equal(p.plan, 'lifetime');
    assert.equal(p.status, 'active');
    assert.equal(p.ls_order_id, '70001');
    assert.equal(p.current_period_end, null);
    assert.equal(isPro({ ...p }), true);
  });

  test('order_created for a subscription variant grants nothing here', () => {
    // subscription_created carries the renewal date; granting from the order
    // would write an active subscription with no period end.
    const ev = orderEvent('order_created', { first_order_item: { variant_id: Number(V_MONTHLY) } });
    assert.equal(entitlementPatch('order_created', ev), null);
  });

  test('subscription_created stores the subscription and its renewal date', () => {
    const p = entitlementPatch('subscription_created', subEvent('subscription_created'));
    assert.equal(p.plan, 'yearly');
    assert.equal(p.status, 'active');
    assert.equal(p.ls_subscription_id, '900001');
    assert.equal(p.ls_customer_id, '55501');
    assert.equal(p.current_period_end, '2027-08-26T00:00:00.000000Z');
    assert.equal(p.cancel_at_period_end, false);
    assert.equal(isPro({ ...p }), true);
  });

  test('subscription_updated handles a plan switch', () => {
    const ev = subEvent('subscription_updated', { variant_id: Number(V_MONTHLY), status: 'active' });
    const p = entitlementPatch('subscription_updated', ev);
    assert.equal(p.plan, 'monthly');
    assert.equal(p.status, 'active');
  });

  test('subscription_cancelled keeps access until the period ends', () => {
    const ev = subEvent('subscription_cancelled', {
      status: 'cancelled', cancelled: true,
      ends_at: '2027-08-26T00:00:00.000000Z', renews_at: null
    });
    const p = entitlementPatch('subscription_cancelled', ev);
    assert.equal(p.status, 'cancelled');
    assert.equal(p.cancel_at_period_end, true);
    assert.equal(p.current_period_end, '2027-08-26T00:00:00.000000Z');
    assert.equal(isPro({ ...p }), true, 'still Pro — they paid through the period');
  });

  test('a cancelled subscription stops being Pro once the period passes', () => {
    const ev = subEvent('subscription_cancelled', {
      status: 'cancelled', cancelled: true,
      ends_at: '2020-01-01T00:00:00.000000Z', renews_at: null
    });
    const p = entitlementPatch('subscription_cancelled', ev);
    assert.equal(isPro({ ...p }), false);
  });

  test('subscription_expired ends access now', () => {
    const ev = subEvent('subscription_expired', { status: 'expired', ends_at: '2026-08-01T00:00:00Z', renews_at: null });
    const p = entitlementPatch('subscription_expired', ev);
    assert.equal(p.status, 'expired');
    assert.equal(isPro({ ...p }), false);
  });

  test('subscription_payment_failed keeps access through dunning', () => {
    const ev = subEvent('subscription_payment_failed', { status: 'past_due' });
    const p = entitlementPatch('subscription_payment_failed', ev);
    assert.equal(p.status, 'past_due');
    assert.equal(isPro({ ...p }), true, 'the card failed but LS is still retrying');
  });

  test('subscription_payment_success extends the period', () => {
    const ev = subEvent('subscription_payment_success', { status: 'active', renews_at: '2028-08-26T00:00:00.000000Z' });
    const p = entitlementPatch('subscription_payment_success', ev);
    assert.equal(p.status, 'active');
    assert.equal(p.current_period_end, '2028-08-26T00:00:00.000000Z');
  });

  test('subscription_payment_recovered restores access after dunning', () => {
    const ev = subEvent('subscription_payment_recovered', { status: 'active' });
    assert.equal(entitlementPatch('subscription_payment_recovered', ev).status, 'active');
  });

  test('order_refunded revokes immediately', () => {
    const p = entitlementPatch('order_refunded', orderEvent('order_refunded', { refunded: true }));
    assert.equal(p.status, 'refunded');
    assert.equal(isPro({ plan: 'lifetime', ...p }), false);
  });

  test('subscription_payment_refunded revokes immediately', () => {
    // Even though the subscription status may still read "active".
    const ev = subEvent('subscription_payment_refunded', { status: 'active' });
    const p = entitlementPatch('subscription_payment_refunded', ev);
    assert.equal(p.status, 'refunded');
    assert.equal(isPro({ plan: 'yearly', current_period_end: '2030-01-01T00:00:00Z', ...p }), false);
  });

  test('license_key_created stores the key', () => {
    const ev = {
      meta: { event_name: 'license_key_created', custom_data: { user_id: USER } },
      data: { type: 'license-keys', id: '5001', attributes: { key: 'MS-AAAA-BBBB-CCCC', status: 'active', customer_id: 55501 } }
    };
    const p = entitlementPatch('license_key_created', ev);
    assert.equal(p.licence_key, 'MS-AAAA-BBBB-CCCC');
    assert.equal(p.source, 'licence');
  });

  test('a disabled licence key revokes', () => {
    const ev = {
      meta: { event_name: 'license_key_updated', custom_data: { user_id: USER } },
      data: { type: 'license-keys', id: '5001', attributes: { key: 'MS-AAAA-BBBB-CCCC', status: 'disabled' } }
    };
    assert.equal(entitlementPatch('license_key_updated', ev).status, 'expired');
  });

  /* ---- events beyond the spec's table, which a live store will send ---- */

  test('subscription_paused honours the paid period, then expires', () => {
    const ev = subEvent('subscription_paused', { status: 'paused', ends_at: '2027-01-01T00:00:00Z', renews_at: null });
    const p = entitlementPatch('subscription_paused', ev);
    assert.equal(p.status, 'cancelled');
    assert.equal(p.cancel_at_period_end, true);
    assert.equal(isPro({ ...p }), true);
  });

  test('subscription_resumed and _unpaused restore active', () => {
    for (const e of ['subscription_resumed', 'subscription_unpaused']) {
      const p = entitlementPatch(e, subEvent(e, { status: 'active', cancelled: false }));
      assert.equal(p.status, 'active', e);
      assert.equal(p.cancel_at_period_end, false, e);
    }
  });

  test('an unknown event yields no patch', () => {
    assert.equal(entitlementPatch('some_future_event', subEvent('some_future_event')), null);
    assert.equal(KNOWN_EVENTS.has('some_future_event'), false);
  });

  test('an active subscription with no dates is flagged, not silently written', () => {
    const ev = subEvent('subscription_created', { renews_at: null, ends_at: null });
    const p = entitlementPatch('subscription_created', ev);
    assert.ok(p._warning, 'the handler logs this rather than writing a row isPro() will reject');
  });

  test('renews_at and ends_at both present: the later one wins', () => {
    const ev = subEvent('subscription_updated', {
      status: 'cancelled', cancelled: true,
      renews_at: '2027-01-01T00:00:00Z', ends_at: '2027-06-01T00:00:00Z'
    });
    assert.equal(entitlementPatch('subscription_updated', ev).current_period_end, '2027-06-01T00:00:00Z');
  });
});

describe('identity hints', () => {
  test('reads user_id from custom_data, plus customer and email', () => {
    const h = identityHints(subEvent('subscription_created'));
    assert.equal(h.userId, USER);
    assert.equal(h.customerId, '55501');
    assert.equal(h.email, 'buyer@example.com');
    assert.equal(h.testMode, false);
  });

  test('flags test-mode events', () => {
    assert.equal(identityHints(subEvent('subscription_created', { test_mode: true })).testMode, true);
    const meta = subEvent('subscription_created');
    meta.meta.test_mode = true;
    assert.equal(identityHints(meta).testMode, true);
  });

  test('a payload with no custom_data still yields the other hints', () => {
    const ev = subEvent('subscription_created');
    delete ev.meta.custom_data;
    const h = identityHints(ev);
    assert.equal(h.userId, null);
    assert.equal(h.customerId, '55501');
    assert.equal(h.email, 'buyer@example.com');
  });
});

describe('buy-link fallback', () => {
  test('attaches user_id in the query-string form', () => {
    const url = buyLinkWithCustomData('https://store.lemonsqueezy.com/buy/abc123', USER, 'a@b.co');
    const u = new URL(url);
    assert.equal(u.searchParams.get('checkout[custom][user_id]'), USER);
    assert.equal(u.searchParams.get('checkout[email]'), 'a@b.co');
  });

  test('preserves existing query parameters', () => {
    const url = buyLinkWithCustomData('https://store.lemonsqueezy.com/buy/abc123?discount=0', USER);
    assert.equal(new URL(url).searchParams.get('discount'), '0');
  });
});
