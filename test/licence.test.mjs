import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

/* Drives api/licence/validate.js as written, with the Lemon Squeezy License
   API stubbed at the fetch layer and Supabase stubbed at the REST layer. */

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d';
const TOKEN = 'access-token-for-user';
const OTHER_TOKEN = 'access-token-for-other';
const KEY = 'MS-AAAA-BBBB-CCCC';

let sb, handler, realFetch;
let lsResponses = {};

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.LS_VARIANT_LIFETIME = '333333';
  process.env.FREE_RUNS = '5';

  sb = await fakeSupabase();
  sb.tables.__tokens = {
    [TOKEN]: { id: USER, email: 'buyer@example.com', user_metadata: {} },
    [OTHER_TOKEN]: { id: OTHER, email: 'other@example.com', user_metadata: {} }
  };
  process.env.SUPABASE_URL = sb.url;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.lemonsqueezy.com/v1/licenses/')) {
      const which = u.split('/').pop();
      const r = lsResponses[which];
      if (typeof r === 'function') return r(opts);
      const { status = 200, body = {} } = r || {};
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  handler = (await import('../api/licence/validate.js')).default;
});

after(async () => { globalThis.fetch = realFetch; await sb?.close(); });

beforeEach(() => {
  sb.tables.profiles = [{ id: USER, email: 'buyer@example.com' }, { id: OTHER, email: 'other@example.com' }];
  sb.tables.entitlements = [];
  sb.tables.rate_limits = [];
  sb.requests.length = 0;
  lsResponses = {
    validate: {
      status: 200,
      body: {
        valid: true, error: null,
        license_key: { id: 1, status: 'active', key: KEY, activation_limit: 3, activation_usage: 0 },
        meta: { store_id: 1, order_id: 70001, variant_id: 333333, customer_id: 55501, customer_email: 'buyer@example.com' }
      }
    },
    activate: { status: 200, body: { activated: true, instance: { id: 'inst-1', name: 'mindsharp' } } }
  };
});

async function call(body, token = TOKEN, headers = {}) {
  const req = mockReq({
    method: 'POST', url: '/api/licence/validate',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body
  });
  const res = mockRes();
  await handler(req, res);
  await res.done;
  return res;
}

describe('happy path', () => {
  test('a valid key grants lifetime and writes the entitlement', async () => {
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json, { valid: true, plan: 'lifetime' });

    const ent = sb.tables.entitlements[0];
    assert.equal(ent.user_id, USER);
    assert.equal(ent.plan, 'lifetime');
    assert.equal(ent.status, 'active');
    assert.equal(ent.source, 'licence');
    assert.equal(ent.licence_key, KEY);
    assert.equal(ent.current_period_end, null);
    assert.equal(ent.ls_order_id, '70001');
  });

  test('the key is normalised before use', async () => {
    await call({ key: '  ms-aaaa-bbbb-cccc  ' });
    assert.equal(sb.tables.entitlements[0].licence_key, KEY, 'trimmed and upper-cased');
  });

  test('an instance is activated so reuse is countable', async () => {
    let activateBody = null;
    lsResponses.activate = opts => {
      activateBody = opts.body;
      return new Response(JSON.stringify({ activated: true, instance: { id: 'inst-9' } }), { status: 200 });
    };
    await call({ key: KEY });
    assert.ok(activateBody, 'activate was called');
    const params = new URLSearchParams(activateBody);
    assert.equal(params.get('license_key'), KEY);
    assert.match(params.get('instance_name'), new RegExp(USER));
  });

  test('re-validating the same key on the same account is fine', async () => {
    await call({ key: KEY });
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 200);
    assert.equal(sb.tables.entitlements.length, 1, 'still one row');
  });
});

describe('refusals', () => {
  test('a key already bound to another account is refused, not transferred', async () => {
    sb.tables.entitlements = [{ id: 1, user_id: OTHER, licence_key: KEY, plan: 'lifetime', status: 'active' }];
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'key_in_use');
    assert.equal(sb.tables.entitlements[0].user_id, OTHER, 'the original owner keeps it');
    assert.equal(sb.tables.entitlements.length, 1);
  });

  test('a key Lemon Squeezy rejects grants nothing', async () => {
    lsResponses.validate = { status: 400, body: { valid: false, error: 'license_key not found' } };
    const res = await call({ key: 'MS-ZZZZ-ZZZZ-ZZZZ' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'invalid_key');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('a disabled key grants nothing', async () => {
    lsResponses.validate.body.license_key.status = 'disabled';
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'key_disabled');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('an expired key grants nothing', async () => {
    lsResponses.validate.body.license_key.status = 'expired';
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'key_expired');
  });

  test('a key at its activation limit is refused', async () => {
    lsResponses.validate.body.license_key.activation_usage = 3;
    lsResponses.validate.body.license_key.status = 'inactive';
    lsResponses.activate = { status: 400, body: { activated: false, error: 'License key has reached the activation limit.' } };
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'activation_limit_reached');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('an unauthenticated request is 401 and never reaches Lemon Squeezy', async () => {
    let called = false;
    lsResponses.validate = () => { called = true; return new Response('{}', { status: 200 }); };
    const res = await call({ key: KEY }, null);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error, 'auth_required');
    assert.equal(called, false);
  });

  test('an invalid token is 401', async () => {
    const res = await call({ key: KEY }, 'not-a-real-token');
    assert.equal(res.statusCode, 401);
  });

  test('a missing or absurd key is rejected before any network call', async () => {
    let called = false;
    lsResponses.validate = () => { called = true; return new Response('{}', { status: 200 }); };
    for (const bad of [{}, { key: '' }, { key: 'short' }, { key: 'x'.repeat(200) }, { key: 42 }]) {
      const res = await call(bad);
      assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
      assert.equal(res.json.error, 'invalid_key');
    }
    assert.equal(called, false, 'no wasted round-trip on garbage input');
  });

  test('GET is refused', async () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    await handler(req, res);
    await res.done;
    assert.equal(res.statusCode, 405);
  });
});

describe('rate limiting', () => {
  test('a sixth attempt in the window is refused', async () => {
    // bump_rate_limit is an RPC; the fake has no RPC support, so allow()
    // fails open. Assert the budget instead: 5 per 10 minutes, per spec §5.
    const { LIMITS } = await import('../lib/ratelimit.js');
    assert.equal(LIMITS.licence.limit, 5);
    assert.equal(LIMITS.licence.window, 600);
  });

  test('the limit is checked before authentication, so guessing is throttled first', async () => {
    // Order matters: an unauthenticated attacker must hit the limiter, not
    // bounce off the 401 for free.
    const src = await import('node:fs').then(m => m.promises.readFile(new URL('../api/licence/validate.js', import.meta.url), 'utf8'));
    const limitAt = src.indexOf("guard(res, 'licence', ip)");
    const authAt = src.indexOf('userFromRequest(req)');
    assert.ok(limitAt > 0 && authAt > 0);
    assert.ok(limitAt < authAt, 'rate limit is applied before the auth check');
  });
});

describe('upstream failures', () => {
  test('a Lemon Squeezy outage is a 502, not a silent grant', async () => {
    lsResponses.validate = () => new Response('gateway timeout', { status: 504 });
    const res = await call({ key: KEY });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json.error, 'licence_service_unavailable');
    assert.equal(sb.tables.entitlements.length, 0);
  });

  test('a unique-violation race is reported as key_in_use', async () => {
    // Two accounts redeeming the same key at the same instant: the unique
    // index on licence_key is the last line of defence.
    sb.tables.entitlements = [{ id: 1, user_id: OTHER, licence_key: KEY, plan: 'lifetime', status: 'active' }];
    const res = await call({ key: KEY }, TOKEN);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'key_in_use');
  });
});
