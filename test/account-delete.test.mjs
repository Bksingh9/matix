import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

/* Drives api/account/delete.js as written.
 *
 * App Store guideline 5.1.1(v) and Play's data-deletion policy both require
 * in-app account deletion. The interesting cases are not "the row is gone" —
 * that is a foreign key doing its job — but the three ways deleting an account
 * can leave someone worse off: a store subscription that keeps billing, a
 * Lemon Squeezy subscription we failed to cancel, and a lifetime licence key
 * stranded on a user id that no longer exists. */

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d';
const TOKEN = 'access-token-for-user';

let sb, handler, realFetch;
let lsCalls = [];
let lsCancelStatus = 204;

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.LEMONSQUEEZY_API_KEY = 'ls-test-key';
  process.env.LEMONSQUEEZY_STORE_ID = '42';

  sb = await fakeSupabase();
  sb.tables.__tokens = { [TOKEN]: { id: USER, email: 'player@example.com', user_metadata: {} } };
  process.env.SUPABASE_URL = sb.url;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.lemonsqueezy.com/v1/subscriptions/')) {
      lsCalls.push({ url: u, method: opts?.method });
      // 204 must carry a null body — Response throws otherwise.
      const noBody = [204, 205, 304].includes(lsCancelStatus);
      return new Response(noBody ? null : JSON.stringify({ errors: [] }), { status: lsCancelStatus });
    }
    return realFetch(url, opts);
  };

  handler = (await import('../api/account/delete.js')).default;
});

after(async () => { globalThis.fetch = realFetch; await sb?.close(); });

beforeEach(() => {
  sb.tables.__users = [{ id: USER, email: 'player@example.com' }, { id: OTHER, email: 'other@example.com' }];
  sb.tables.profiles = [{ id: USER, email: 'player@example.com' }, { id: OTHER, email: 'other@example.com' }];
  sb.tables.entitlements = [];
  sb.tables.runs = [];
  sb.tables.attempts = [];
  sb.tables.player_progress = [];
  sb.tables.achievements = [];
  sb.tables.league_members = [];
  sb.tables.league_standing = [];
  sb.tables.daily_scores = [];
  sb.tables.store_notifications = [];
  sb.tables.webhook_events = [];
  sb.tables.rate_limits = [];
  sb.requests.length = 0;
  lsCalls = [];
  lsCancelStatus = 204;
});

const call = (body = { confirm: 'DELETE' }, token = TOKEN) => {
  const req = mockReq({
    method: 'POST', url: '/api/account/delete',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body
  });
  const res = mockRes();
  return handler(req, res).then(() => res);
};

describe('deleting an account', () => {
  test('requires a signed-in user', async () => {
    const res = await call({ confirm: 'DELETE' }, null);
    assert.equal(res.statusCode, 401);
    assert.equal(sb.tables.__users.length, 2, 'nobody was deleted');
  });

  test('refuses without the typed confirmation', async () => {
    // A stray fetch must not be able to close someone's account.
    for (const body of [{}, { confirm: 'delete' }, { confirm: true }, { confirm: 'YES' }]) {
      const res = await call(body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.json.error, 'confirm_required');
    }
    assert.equal(sb.tables.__users.length, 2);
  });

  test('rejects anything but POST', async () => {
    const req = mockReq({ method: 'GET', url: '/api/account/delete', headers: { authorization: `Bearer ${TOKEN}` } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
  });

  test('deletes the user and everything that cascades from them', async () => {
    sb.tables.runs = [{ id: 1, user_id: USER }, { id: 2, user_id: OTHER }];
    sb.tables.attempts = [{ id: 1, run_id: 1, user_id: USER }];
    sb.tables.player_progress = [{ user_id: USER, xp: 900 }, { user_id: OTHER, xp: 10 }];
    sb.tables.achievements = [{ user_id: USER, key: 'first_run' }];
    sb.tables.league_members = [{ group_id: 1, user_id: USER, xp: 40 }];
    sb.tables.league_standing = [{ user_id: USER, tier: 2 }];
    sb.tables.daily_scores = [{ user_id: USER, score: 300 }];

    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.deleted, true);

    assert.equal(sb.tables.__users.find(u => u.id === USER), undefined);
    for (const t of ['profiles', 'runs', 'attempts', 'player_progress',
                     'achievements', 'league_members', 'league_standing', 'daily_scores']) {
      assert.equal(sb.tables[t].some(r => (r.user_id ?? r.id) === USER), false, `${t} still holds their rows`);
    }

    // And nobody else's data went with it.
    assert.equal(sb.tables.runs.length, 1);
    assert.equal(sb.tables.player_progress.length, 1);
    assert.equal(sb.tables.__users.length, 1);
  });

  test('refuses while an App Store subscription is live', async () => {
    // We cannot cancel this one — only Apple can. Deleting the account here
    // leaves a card being charged for a product with no account behind it.
    sb.tables.entitlements = [{
      user_id: USER, plan: 'yearly', status: 'active', source: 'appstore',
      store_txn_id: 'apple:200000123456789'
    }];

    const res = await call();
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'store_subscription_active');
    assert.equal(res.json.source, 'appstore', 'the client needs to name the right store');
    assert.equal(sb.tables.__users.length, 2, 'and nothing was deleted');
  });

  test('refuses while a Play subscription is live', async () => {
    sb.tables.entitlements = [{ user_id: USER, plan: 'monthly', status: 'active', source: 'play' }];
    const res = await call();
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.source, 'play');
  });

  test('past_due through a store still blocks — the card is still being retried', async () => {
    sb.tables.entitlements = [{ user_id: USER, plan: 'monthly', status: 'past_due', source: 'play' }];
    assert.equal((await call()).statusCode, 409);
  });

  test('an expired store subscription does not block', async () => {
    // Nothing is billing any more, so there is nothing to protect them from.
    sb.tables.entitlements = [{ user_id: USER, plan: 'monthly', status: 'expired', source: 'appstore' }];
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(sb.tables.__users.length, 1);
  });

  test('cancels a live Lemon Squeezy subscription before deleting', async () => {
    sb.tables.entitlements = [{
      user_id: USER, plan: 'yearly', status: 'active', source: 'lemonsqueezy',
      ls_subscription_id: 'sub_999', ls_customer_id: 'cus_111'
    }];

    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(lsCalls.length, 1, 'the subscription must actually be cancelled');
    assert.equal(lsCalls[0].method, 'DELETE');
    assert.match(lsCalls[0].url, /\/subscriptions\/sub_999$/);
    assert.equal(sb.tables.__users.length, 1);
  });

  test('keeps the account when the cancellation fails', async () => {
    // Deleting anyway would delete the account and keep charging them, which
    // is the one outcome worse than refusing.
    lsCancelStatus = 500;
    sb.tables.entitlements = [{
      user_id: USER, plan: 'yearly', status: 'active',
      source: 'lemonsqueezy', ls_subscription_id: 'sub_999'
    }];

    const res = await call();
    assert.equal(res.statusCode, 503);
    assert.equal(res.json.error, 'cancel_failed');
    assert.equal(sb.tables.__users.length, 2, 'the account survives so they can retry');
  });

  test('a subscription already gone from Lemon Squeezy is not an error', async () => {
    lsCancelStatus = 404;
    sb.tables.entitlements = [{
      user_id: USER, plan: 'yearly', status: 'active',
      source: 'lemonsqueezy', ls_subscription_id: 'sub_gone'
    }];
    assert.equal((await call()).statusCode, 200);
  });

  test('does not call Lemon Squeezy for a lifetime purchase', async () => {
    // There is no subscription to cancel, and a stray DELETE against a
    // subscription id we do not have would be a bug looking for a victim.
    sb.tables.entitlements = [{
      user_id: USER, plan: 'lifetime', status: 'active',
      source: 'lemonsqueezy', licence_key: 'MS-AAAA-BBBB-CCCC'
    }];
    const res = await call();
    assert.equal(res.statusCode, 200);
    assert.equal(lsCalls.length, 0);
  });

  test('releases the licence key so it can be redeemed again', async () => {
    // Otherwise a lifetime key stays bound to a deleted user id forever —
    // including for the person who paid for it, on their new account.
    sb.tables.entitlements = [{
      user_id: USER, plan: 'lifetime', status: 'active', source: 'lemonsqueezy',
      licence_key: 'MS-AAAA-BBBB-CCCC', ls_customer_id: 'cus_111', store_txn_id: 'apple:1'
    }];

    await call();

    const scrub = sb.requests.find(r => r.method === 'PATCH' && r.path === '/rest/v1/entitlements');
    assert.ok(scrub, 'the identifiers must be released before the row cascades away');
    assert.equal(scrub.body.licence_key, null);
    assert.equal(scrub.body.ls_customer_id, null);
    assert.equal(scrub.body.ls_subscription_id, null);
    assert.equal(scrub.body.store_txn_id, null);
  });

  test('keeps the payment audit trail', async () => {
    // webhook_events and store_notifications answer "did this person pay", and
    // a refund request can arrive after the account is gone. Both are keyed by
    // the provider's event id, not by us.
    sb.tables.webhook_events = [{ id: 'evt_1', event_name: 'order_created', payload: { user: USER } }];
    sb.tables.store_notifications = [{ id: 'ntf_1', provider: 'play', kind: 'SUBSCRIPTION_RENEWED' }];

    await call();

    assert.equal(sb.tables.webhook_events.length, 1, 'the audit trail survives');
    assert.equal(sb.tables.store_notifications.length, 1);
  });

  test('clears the rate-limit buckets keyed to them', async () => {
    // No foreign key reaches these, so the id would sit there after the
    // account is gone.
    sb.tables.rate_limits = [
      { bucket: `checkout:${USER}`, count: 3 },
      { bucket: `runs:${USER}`, count: 9 },
      { bucket: `runs:${OTHER}`, count: 4 },
      { bucket: 'licence:203.0.113.9', count: 1 }
    ];

    await call();

    const left = sb.tables.rate_limits.map(r => r.bucket);
    assert.equal(left.some(b => b.includes(USER)), false, 'their buckets are gone');
    assert.ok(left.includes(`runs:${OTHER}`), 'and nobody else lost theirs');
    assert.ok(left.includes('licence:203.0.113.9'), 'including the IP-keyed ones');
  });

  test('refuses when it cannot read the entitlement', async () => {
    // An unreachable table must not read as "no subscription" — that deletes
    // the account of someone whose card is still being charged.
    sb.fail('entitlements');
    try {
      const res = await call();
      assert.equal(res.statusCode, 503);
      assert.equal(res.json.error, 'entitlement_unreadable');
      assert.equal(sb.tables.__users.length, 2, 'nothing was deleted');
    } finally {
      sb.unfail('entitlements');
    }
  });
});
