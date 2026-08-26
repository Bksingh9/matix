import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPro, shape, FREE_ENTITLEMENT } from '../lib/entitlement.js';

const HOUR = 3600_000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();
const past = () => new Date(Date.now() - 24 * HOUR).toISOString();

describe('isPro', () => {
  test('no row is not Pro', () => {
    assert.equal(isPro(null), false);
    assert.equal(isPro(undefined), false);
  });

  test('an active subscription inside its period is Pro', () => {
    assert.equal(isPro({ plan: 'yearly', status: 'active', current_period_end: future() }), true);
    assert.equal(isPro({ plan: 'monthly', status: 'active', current_period_end: future() }), true);
  });

  test('an active subscription past its period end is not Pro', () => {
    assert.equal(isPro({ plan: 'monthly', status: 'active', current_period_end: past() }), false);
  });

  test('cancelled keeps access until the period ends', () => {
    // They paid through the period. Revoking early earns a chargeback, which
    // costs more than the subscription was worth.
    assert.equal(isPro({ plan: 'yearly', status: 'cancelled', current_period_end: future() }), true);
    assert.equal(isPro({ plan: 'yearly', status: 'cancelled', current_period_end: past() }), false);
  });

  test('past_due keeps access through the dunning window', () => {
    // The card failed and Lemon Squeezy is retrying. Cutting access mid-retry
    // loses a customer who was about to pay.
    assert.equal(isPro({ plan: 'monthly', status: 'past_due', current_period_end: future() }), true);
  });

  test('expired and refunded end access immediately', () => {
    assert.equal(isPro({ plan: 'yearly', status: 'expired', current_period_end: future() }), false);
    assert.equal(isPro({ plan: 'lifetime', status: 'refunded', current_period_end: null }), false);
    assert.equal(isPro({ plan: 'lifetime', status: 'expired', current_period_end: null }), false);
  });

  test('lifetime needs no period end', () => {
    assert.equal(isPro({ plan: 'lifetime', status: 'active', current_period_end: null }), true);
  });

  test('comp is Pro without a payment', () => {
    // Phase 1 acceptance: a manually-set comp row must unlock Pro.
    assert.equal(isPro({ plan: 'comp', status: 'active', current_period_end: null }), true);
  });

  test('a subscription with no period end is not Pro', () => {
    // A missing renews_at means the webhook wrote a partial row. Failing
    // closed here surfaces the bug instead of silently granting access.
    assert.equal(isPro({ plan: 'monthly', status: 'active', current_period_end: null }), false);
  });

  test('free/none is not Pro', () => {
    assert.equal(isPro({ plan: 'free', status: 'none', current_period_end: null }), false);
  });

  test('an unknown status is not Pro', () => {
    assert.equal(isPro({ plan: 'yearly', status: 'wat', current_period_end: future() }), false);
  });
});

describe('shape', () => {
  test('a missing row shapes to the free entitlement', () => {
    assert.deepEqual(shape(null), { ...FREE_ENTITLEMENT });
  });

  test('carries the fields the client needs', () => {
    const end = future();
    assert.deepEqual(
      shape({ plan: 'yearly', status: 'cancelled', current_period_end: end, cancel_at_period_end: true }),
      { isPro: true, plan: 'yearly', status: 'cancelled', currentPeriodEnd: end, cancelAtPeriodEnd: true, source: null }
    );
  });

  test('exposes which rail paid, so a cancellation goes to the right place', () => {
    assert.equal(shape({ plan: 'yearly', status: 'active', source: 'appstore' }).source, 'appstore');
    assert.equal(shape({ plan: 'yearly', status: 'active', source: 'play' }).source, 'play');
    assert.equal(shape(null).source, null, 'and the free shape carries the same key');
  });

  test('never leaks store identifiers to the browser', () => {
    const out = shape({
      plan: 'lifetime', status: 'active', current_period_end: null,
      ls_customer_id: 'cus_123', ls_subscription_id: 'sub_456',
      licence_key: 'SECRET-KEY-0001', user_id: 'uuid',
      store_txn_id: 'apple:200000123456789', store_product_id: 'mindsharp.pro.yearly'
    });
    const serialised = JSON.stringify(out);
    for (const leak of ['cus_123', 'sub_456', 'SECRET-KEY-0001', 'uuid', '200000123456789']) {
      assert.equal(serialised.includes(leak), false, `${leak} must not reach the client`);
    }
  });
});
