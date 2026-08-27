import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

/* The league and daily leaderboard endpoints, driven as written.
 *
 * The behaviour that matters most here is what happens at low player counts:
 * a solo launch has single-digit daily actives for weeks, and a leaderboard
 * with four names on it reads as a dead product. */

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'tok-league';

/* Dates are computed from the clock, never written as literals.
 *
 * These endpoints resolve "today" and "the current season" from the system
 * clock, so a seeded literal is a test that passes until the date rolls over
 * and then fails for a reason that has nothing to do with the code. This file
 * previously hard-coded the day it was written on, and broke the next morning. */
const ymd = d => d.toISOString().slice(0, 10);
const daysFromNow = n => ymd(new Date(Date.now() + n * 86400000));
const TODAY = daysFromNow(0);

/* The Monday-to-Sunday week containing today, which is the season shape
   settle_season assumes. */
const MONDAY = (() => {
  const d = new Date();
  const back = (d.getUTCDay() + 6) % 7;      // Sunday is 0, and weeks start Monday
  return ymd(new Date(d.getTime() - back * 86400000));
})();
const SUNDAY = ymd(new Date(new Date(MONDAY).getTime() + 6 * 86400000));
let sb, league, leaderboard, settle;

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.CRON_SECRET = 'cron-secret-value';
  sb = await fakeSupabase();
  sb.tables.__tokens = { [TOKEN]: { id: USER, email: 'p@example.com', user_metadata: {} } };
  process.env.SUPABASE_URL = sb.url;

  // join_league / settle_season are plpgsql in the real database; emulate the
  // contract here so the handlers exercise their own code paths.
  sb.rpc = {};
  league = (await import('../api/league.js')).default;
  leaderboard = (await import('../api/leaderboard.js')).default;
  settle = (await import('../api/league/settle.js')).default;
});
after(async () => { await sb?.close(); });

beforeEach(() => {
  sb.tables.profiles = [{ id: USER, email: 'p@example.com', handle: null }];
  sb.tables.league_seasons = [{ id: 1, starts_on: MONDAY, ends_on: SUNDAY }];
  sb.tables.league_groups = [{ id: 10, season_id: 1, tier: 1 }];
  sb.tables.league_members = [];
  sb.tables.league_standing = [];
  sb.tables.daily_scores = [];
  sb.tables.v_daily_leaderboard = [];
  sb.requests.length = 0;
});

async function call(handler, { url = '/api/league', method = 'GET', token = TOKEN, body } = {}) {
  const req = mockReq({
    method, url,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body
  });
  const res = mockRes();
  await handler(req, res);
  await res.done;
  return res;
}

const members = n => Array.from({ length: n }, (_, i) => ({
  group_id: 10,
  user_id: i === 0 ? USER : `user-${String(i).padStart(4, '0')}`,
  xp: (n - i) * 100,
  joined_at: `${MONDAY}T0${i % 10}:00:00Z`
}));

describe('GET /api/league', () => {
  test('an anonymous request is 401', async () => {
    assert.equal((await call(league, { token: null })).statusCode, 401);
  });

  test('a solo player sees their own board rather than an error', async () => {
    sb.tables.league_members = members(1);
    const res = await call(league);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.size, 1);
    assert.equal(res.json.meaningful, false, 'one player is not a leaderboard');
    assert.equal(res.json.tierName, 'Bronze');
    assert.equal(res.json.you.isYou, true);
  });

  test('under five players it is honest rather than a podium', async () => {
    sb.tables.league_members = members(4);
    const res = await call(league);
    assert.equal(res.json.meaningful, false);
    assert.equal(res.json.promoteCount, 0, 'no promotion zone in a group of four');
    assert.equal(res.json.relegateCount, 0);
  });

  test('a full group ranks by XP with the player marked', async () => {
    sb.tables.league_members = members(20);
    const res = await call(league);
    assert.equal(res.json.meaningful, true);
    assert.equal(res.json.entries.length, 20);
    assert.equal(res.json.entries[0].rank, 1);
    assert.ok(res.json.entries[0].xp >= res.json.entries[1].xp, 'sorted by XP');
    assert.equal(res.json.entries.filter(e => e.isYou).length, 1);
  });

  test('promotion and relegation zones appear only once the group is big enough', async () => {
    sb.tables.league_members = members(9);
    let res = await call(league);
    assert.equal(res.json.promoteCount, 0, 'finishing last in a group of nine is not a result');
    assert.ok(res.json.entries.every(e => e.zone === 'hold'));

    sb.tables.league_members = members(20);
    res = await call(league);
    assert.equal(res.json.promoteCount, 5);
    assert.equal(res.json.entries.filter(e => e.zone === 'promote').length, 5);
  });

  test('only players who scored nothing all week are in the drop zone', async () => {
    // Relegating someone who played but placed low punishes participation.
    const rows = members(20).map((m, i) => ({ ...m, xp: i >= 18 ? 0 : (20 - i) * 10 }));
    sb.tables.league_members = rows;
    const res = await call(league);
    const relegating = res.json.entries.filter(e => e.zone === 'relegate');
    assert.equal(relegating.length, 2, 'exactly the two who scored zero');
    assert.ok(relegating.every(e => e.xp === 0));
  });

  test('shows a handle, never an email', async () => {
    sb.tables.profiles = [{ id: USER, email: 'private@example.com', handle: 'brij' }];
    sb.tables.league_members = members(8);
    const res = await call(league);
    const me = res.json.entries.find(e => e.isYou);
    assert.equal(me.handle, 'brij');
    assert.equal(JSON.stringify(res.json).includes('private@example.com'), false,
      'a leaderboard that leaks addresses is a breach with a scoreboard on top');
  });

  test('a player with no handle gets a stable placeholder, not a UUID', async () => {
    sb.tables.league_members = members(8);
    const res = await call(league);
    const me = res.json.entries.find(e => e.isYou);
    assert.match(me.handle, /^Player [0-9a-f]{4}$/i);
    assert.equal(me.handle.includes(USER), false);
    assert.equal(res.json.handleSet, false, 'so the client can prompt for one');
  });

  test('reports last week’s result so it can be celebrated or softened', async () => {
    sb.tables.league_standing = [{ user_id: USER, tier: 2, last_result: 'promoted' }];
    sb.tables.league_members = members(12);
    const res = await call(league);
    assert.equal(res.json.lastResult, 'promoted');
  });

  test('carries the season window so the client can show a countdown', async () => {
    sb.tables.league_members = members(8);
    const res = await call(league);
    assert.equal(res.json.season.startsOn, MONDAY);
    assert.ok(res.json.season.endsAt.startsWith(SUNDAY), 'ends at the end of the last day');
  });
});

describe('POST /api/league (handle)', () => {
  const setHandle = handle => call(league, { method: 'POST', body: { handle } });

  test('accepts a reasonable name', async () => {
    const res = await setHandle('brij');
    assert.equal(res.statusCode, 200);
    assert.equal(sb.tables.profiles[0].handle, 'brij');
  });

  test('rejects an email address outright', async () => {
    const res = await setHandle('me@example.com');
    assert.equal(res.statusCode, 400);
    assert.equal(sb.tables.profiles[0].handle, null, 'never publish an address on a public board');
  });

  test('rejects too short, too long and hostile input', async () => {
    for (const bad of ['', 'a', 'x'.repeat(17), '<script>', '  ', '../../etc']) {
      const res = await setHandle(bad);
      assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('an anonymous request is 401', async () => {
    assert.equal((await call(league, { method: 'POST', token: null, body: { handle: 'x' } })).statusCode, 401);
  });
});

describe('GET /api/leaderboard', () => {
  const board = n => Array.from({ length: n }, (_, i) => ({
    daily_date: TODAY,
    user_id: i === 0 ? USER : `u-${i}`,
    handle: i === 0 ? 'brij' : `Player ${i}`,
    score: (n - i) * 50,
    grid: '🟩🟩🟩',
    rank: i + 1
  }));

  test('is readable without an account — that is the point of a leaderboard', async () => {
    sb.tables.v_daily_leaderboard = board(10);
    sb.tables.daily_scores = board(10).map(r => ({ daily_date: r.daily_date, user_id: r.user_id, score: r.score, grid: r.grid }));
    const res = await call(leaderboard, { url: '/api/leaderboard', token: null });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.entries.length, 10);
    assert.equal(res.json.meaningful, true);
    assert.ok(res.json.entries.every(e => e.isYou === false));
  });

  test('marks the signed-in player', async () => {
    sb.tables.v_daily_leaderboard = board(10);
    sb.tables.daily_scores = board(10).map(r => ({ daily_date: r.daily_date, user_id: r.user_id, score: r.score, grid: r.grid }));
    const res = await call(leaderboard, { url: '/api/leaderboard' });
    assert.equal(res.json.entries.filter(e => e.isYou).length, 1);
    assert.equal(res.json.you.handle, 'brij');
  });

  test('an empty day is not an error', async () => {
    const res = await call(leaderboard, { url: '/api/leaderboard' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.entries, []);
    assert.equal(res.json.meaningful, false);
  });

  test('a handful of players is reported as such, not as a podium', async () => {
    sb.tables.v_daily_leaderboard = board(3);
    sb.tables.daily_scores = board(3).map(r => ({ daily_date: r.daily_date, user_id: r.user_id, score: r.score, grid: r.grid }));
    const res = await call(leaderboard, { url: '/api/leaderboard' });
    assert.equal(res.json.meaningful, false);
    assert.equal(res.json.playerCount, 3);
  });

  test('a malformed date falls back to today rather than erroring', async () => {
    const res = await call(leaderboard, { url: '/api/leaderboard?date=yesterday' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.date, new Date().toISOString().slice(0, 10));
  });

  test('never exposes emails or user ids', async () => {
    sb.tables.v_daily_leaderboard = board(8);
    sb.tables.daily_scores = board(8).map(r => ({ daily_date: r.daily_date, user_id: r.user_id, score: r.score, grid: r.grid }));
    const res = await call(leaderboard, { url: '/api/leaderboard' });
    const s = JSON.stringify(res.json);
    assert.equal(s.includes('@'), false);
    assert.equal(s.includes(USER), false);
  });
});

describe('POST /api/league/settle', () => {
  test('refuses without the shared secret', async () => {
    const req = mockReq({ method: 'POST', url: '/api/league/settle', headers: {} });
    const res = mockRes();
    await settle(req, res);
    await res.done;
    assert.equal(res.statusCode, 401, 'anyone could otherwise end the season early');
  });

  test('refuses a wrong secret', async () => {
    const req = mockReq({ method: 'POST', headers: { authorization: 'Bearer nope' } });
    const res = mockRes();
    await settle(req, res);
    await res.done;
    assert.equal(res.statusCode, 401);
  });

  test('refuses a secret of the wrong length without throwing', async () => {
    // timingSafeEqual throws on a length mismatch, so this must be guarded.
    for (const bad of ['', 'x', 'cron-secret-value-longer']) {
      const req = mockReq({ method: 'POST', headers: { authorization: `Bearer ${bad}` } });
      const res = mockRes();
      await settle(req, res);
      await res.done;
      assert.equal(res.statusCode, 401, `bad secret ${JSON.stringify(bad)}`);
    }
  });

  test('accepts the correct secret and reports what it closed', async () => {
    sb.tables.league_seasons = [{ id: 1, starts_on: daysFromNow(-21), ends_on: daysFromNow(-15) }];
    const req = mockReq({ method: 'POST', headers: { authorization: 'Bearer cron-secret-value' } });
    const res = mockRes();
    await settle(req, res);
    await res.done;
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json.settled));
  });

  test('leaves the current season alone', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    sb.tables.league_seasons = [{ id: 2, starts_on: new Date().toISOString().slice(0, 10), ends_on: future }];
    const req = mockReq({ method: 'POST', headers: { authorization: 'Bearer cron-secret-value' } });
    const res = mockRes();
    await settle(req, res);
    await res.done;
    assert.equal(res.json.count, 0, 'a season still running is not settled');
  });
});
