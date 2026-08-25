import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

/* Drives api/webhooks/lemonsqueezy.js as written, against a fake PostgREST.
   The handler, the supabase-js client and the signature code are all real. */

const SECRET = 'whsec_integration_secret';
const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d';
const V_MONTHLY = '111111', V_YEARLY = '222222', V_LIFETIME = '333333';

let sb, handler;

before(async () => {
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;
  process.env.LS_VARIANT_MONTHLY = V_MONTHLY;
  process.env.LS_VARIANT_YEARLY = V_YEARLY;
  process.env.LS_VARIANT_LIFETIME = V_LIFETIME;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.VERCEL_ENV;

  sb = await fakeSupabase();
  process.env.SUPABASE_URL = sb.url;
  handler = (await import('../api/webhooks/lemonsqueezy.js')).default;
});

after(async () => { await sb?.close(); });

beforeEach(() => {
  sb.tables.profiles = [{ id: USER, email: 'buyer@example.com' }, { id: OTHER, email: 'other@example.com' }];
  sb.tables.entitlements = [];
  sb.tables.webhook_events = [];
  sb.requests.length = 0;
});

const sign = body => crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');

async function deliver(payload, { signature, secret, headers = {}, rawOverride } = {}) {
  const raw = rawOverride ?? JSON.stringify(payload);
  const sig = signature ?? (secret
    ? crypto.createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex')
    : sign(raw));
  const req = mockReq({ method: 'POST', url: '/api/webhooks/lemonsqueezy', headers: { 'x-signature': sig, ...headers }, raw });
  const res = mockRes();
  await handler(req, res);
  await res.done;
  return res;
}

const sub = (event, attrs = {}, meta = {}) => ({
  meta: { event_name: event, custom_data: { user_id: USER }, test_mode: false, ...meta },
  data: {
    type: 'subscriptions', id: '900001',
    attributes: {
      customer_id: 55501, variant_id: Number(V_YEARLY), status: 'active', cancelled: false,
      renews_at: '2027-08-26T00:00:00.000000Z', ends_at: null,
      user_email: 'buyer@example.com', test_mode: false, ...attrs
    }
  }
});

const order = (event, attrs = {}, meta = {}) => ({
  meta: { event_name: event, custom_data: { user_id: USER }, test_mode: false, ...meta },
  data: {
    type: 'orders', id: '70001',
    attributes: {
      customer_id: 55501, user_email: 'buyer@example.com', test_mode: false,
      first_order_item: { variant_id: Number(V_LIFETIME) }, ...attrs
    }
  }
});

const ent = () => sb.tables.entitlements[0];

describe('signature enforcement', () => {
  test('a valid signature is accepted', async () => {
    const res = await deliver(sub('subscription_created'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.applied, true);
  });

  test('a wrong signature is rejected with 401 and writes nothing', async () => {
    const res = await deliver(sub('subscription_created'), { secret: 'wrong_secret' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error, 'bad_signature');
    assert.equal(sb.tables.entitlements.length, 0);
    assert.equal(sb.tables.webhook_events.length, 0, 'a forged event is not even recorded');
  });

  test('a missing signature header is rejected', async () => {
    const raw = JSON.stringify(sub('subscription_created'));
    const req = mockReq({ method: 'POST', headers: {}, raw });
    const res = mockRes();
    await handler(req, res);
    await res.done;
    assert.equal(res.statusCode, 401);
  });

  test('a body altered in transit is rejected', async () => {
    const good = JSON.stringify(sub('subscription_created'));
    const tampered = good.replace('"222222"', '"333333"').replace('222222', '333333');
    const res = await deliver(null, { signature: sign(good), rawOverride: tampered });
    assert.equal(res.statusCode, 401);
  });

  test('GET is refused', async () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    await handler(req, res);
    await res.done;
    assert.equal(res.statusCode, 405);
  });
});

describe('idempotency', () => {
  test('a replayed delivery is a no-op that still returns 200', async () => {
    const payload = sub('subscription_created');
    const first = await deliver(payload);
    assert.equal(first.json.applied, true);

    const replay = await deliver(payload);
    assert.equal(replay.statusCode, 200, 'LS must be told to stop retrying');
    assert.equal(replay.json.duplicate, true);
    assert.equal(sb.tables.webhook_events.length, 1, 'recorded once');
    assert.equal(sb.tables.entitlements.length, 1, 'no double-write');
  });

  test('two genuinely different events both apply', async () => {
    await deliver(sub('subscription_created'));
    await deliver(sub('subscription_payment_success', { renews_at: '2028-08-26T00:00:00.000000Z' }));
    assert.equal(sb.tables.webhook_events.length, 2);
    assert.equal(ent().current_period_end, '2028-08-26T00:00:00.000000Z');
  });
});

describe('the full event map, end to end', () => {
  test('buy monthly → Pro', async () => {
    await deliver(sub('subscription_created', { variant_id: Number(V_MONTHLY) }));
    assert.equal(ent().user_id, USER);
    assert.equal(ent().plan, 'monthly');
    assert.equal(ent().status, 'active');
    assert.equal(ent().ls_subscription_id, '900001');
  });

  test('buy lifetime → Pro with no period end', async () => {
    await deliver(order('order_created'));
    assert.equal(ent().plan, 'lifetime');
    assert.equal(ent().status, 'active');
    assert.equal(ent().current_period_end, null);
    assert.equal(ent().ls_order_id, '70001');
  });

  test('cancel → access persists to period end', async () => {
    await deliver(sub('subscription_created'));
    await deliver(sub('subscription_cancelled', { status: 'cancelled', cancelled: true, renews_at: null, ends_at: '2027-08-26T00:00:00.000000Z' }));
    assert.equal(ent().status, 'cancelled');
    assert.equal(ent().cancel_at_period_end, true);
    assert.equal(ent().current_period_end, '2027-08-26T00:00:00.000000Z');
  });

  test('expire → access ends', async () => {
    await deliver(sub('subscription_created'));
    await deliver(sub('subscription_expired', { status: 'expired', renews_at: null, ends_at: '2026-08-01T00:00:00Z' }));
    assert.equal(ent().status, 'expired');
  });

  test('payment failed → past_due, then recovered → active', async () => {
    await deliver(sub('subscription_created'));
    await deliver(sub('subscription_payment_failed', { status: 'past_due' }));
    assert.equal(ent().status, 'past_due');
    await deliver(sub('subscription_payment_recovered', { status: 'active' }));
    assert.equal(ent().status, 'active');
  });

  test('refund → access ends immediately', async () => {
    await deliver(order('order_created'));
    assert.equal(ent().status, 'active');
    await deliver(order('order_refunded', { refunded: true }));
    assert.equal(ent().status, 'refunded');
  });

  test('plan switch monthly → yearly is reflected', async () => {
    await deliver(sub('subscription_created', { variant_id: Number(V_MONTHLY) }));
    assert.equal(ent().plan, 'monthly');
    await deliver(sub('subscription_updated', { variant_id: Number(V_YEARLY), status: 'active' }));
    assert.equal(ent().plan, 'yearly');
    assert.equal(sb.tables.entitlements.length, 1, 'one row per user, updated in place');
  });

  test('an unknown event is recorded and ignored', async () => {
    const res = await deliver(sub('subscription_something_new'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ignored, 'unknown_event');
    assert.equal(sb.tables.entitlements.length, 0);
  });
});

describe('attribution', () => {
  test('prefers custom_data.user_id', async () => {
    await deliver(sub('subscription_created'));
    assert.equal(ent().user_id, USER);
  });

  test('falls back to the Lemon Squeezy customer id', async () => {
    sb.tables.entitlements = [{ id: 1, user_id: OTHER, ls_customer_id: '55501', plan: 'free', status: 'none' }];
    const p = sub('subscription_created');
    delete p.meta.custom_data;
    p.data.attributes.user_email = 'nobody@nowhere.invalid';
    await deliver(p);
    assert.equal(sb.tables.entitlements[0].user_id, OTHER);
    assert.equal(sb.tables.entitlements[0].plan, 'yearly');
  });

  test('falls back to the purchase email against profiles', async () => {
    const p = sub('subscription_created');
    delete p.meta.custom_data;
    p.data.attributes.customer_id = 99999;
    p.data.attributes.user_email = 'other@example.com';
    await deliver(p);
    assert.equal(ent().user_id, OTHER);
  });

  test('email matching is case-insensitive', async () => {
    const p = sub('subscription_created');
    delete p.meta.custom_data;
    p.data.attributes.customer_id = 99999;
    p.data.attributes.user_email = 'OTHER@Example.COM';
    await deliver(p);
    assert.equal(ent()?.user_id, OTHER);
  });

  test('an unattributable paid event is flagged, never dropped', async () => {
    const p = sub('subscription_created');
    delete p.meta.custom_data;
    p.data.attributes.customer_id = 424242;
    p.data.attributes.user_email = 'ghost@nowhere.invalid';
    const res = await deliver(p);

    assert.equal(res.statusCode, 200, 'still 200 so LS stops retrying');
    assert.equal(res.json.unresolved, true);
    assert.equal(sb.tables.entitlements.length, 0);

    const rec = sb.tables.webhook_events[0];
    assert.equal(rec.unresolved, true, 'surfaced for the admin list');
    assert.match(rec.resolve_note, /unattributed/);
    assert.ok(rec.payload, 'the full payload is kept so it can be granted by hand');
  });

  test('a user_id that does not exist falls through to the other hints', async () => {
    const p = sub('subscription_created', {}, { custom_data: { user_id: '00000000-0000-0000-0000-000000000000' } });
    await deliver(p);
    assert.equal(ent().user_id, USER, 'matched on the purchase email instead');
  });

  test('a non-uuid user_id does not become a database error', async () => {
    const p = sub('subscription_created', {}, { custom_data: { user_id: "'; drop table entitlements; --" } });
    const res = await deliver(p);
    assert.equal(res.statusCode, 200);
    assert.equal(ent().user_id, USER, 'fell through to email matching');
  });
});

describe('test mode', () => {
  test('a test-mode purchase does not grant Pro on production', async () => {
    process.env.VERCEL_ENV = 'production';
    try {
      const res = await deliver(sub('subscription_created', { test_mode: true }, { test_mode: true }));
      assert.equal(res.json.ignored, 'test_mode_event_on_production');
      assert.equal(sb.tables.entitlements.length, 0);
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });

  test('a test-mode purchase works on a preview deployment', async () => {
    const res = await deliver(sub('subscription_created', { test_mode: true }, { test_mode: true }));
    assert.equal(res.json.applied, true);
  });
});

describe('malformed input', () => {
  test('a correctly signed non-JSON body is a 400', async () => {
    const res = await deliver(null, { rawOverride: 'not json at all' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'bad_json');
  });

  test('a signed payload with no event name is a 400', async () => {
    const res = await deliver({ meta: {}, data: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'no_event_name');
  });

  test('an empty signed body is a 400', async () => {
    const res = await deliver(null, { rawOverride: '' });
    assert.equal(res.statusCode, 400);
  });
});
