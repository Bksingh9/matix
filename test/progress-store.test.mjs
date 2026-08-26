import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

/* Drives lib/progress-store.js against a fake PostgREST, then the whole
   /api/runs route, so the progression a real run produces is what is asserted. */

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'tok-progress';
let sb, applyRun, loadProgress, runsHandler;

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  process.env.SUPABASE_ANON_KEY = 'anon';
  sb = await fakeSupabase();
  sb.tables.__tokens = { [TOKEN]: { id: USER, email: 'p@example.com', user_metadata: {} } };
  process.env.SUPABASE_URL = sb.url;
  ({ applyRun, loadProgress } = await import('../lib/progress-store.js'));
  runsHandler = (await import('../api/runs.js')).default;
});
after(async () => { await sb?.close(); });

beforeEach(() => {
  sb.tables.player_progress = [];
  sb.tables.achievements = [];
  sb.tables.entitlements = [{ id: 1, user_id: USER, plan: 'free', status: 'none' }];
  sb.tables.runs = [];
  sb.tables.attempts = [];
  sb.requests.length = 0;
});

const run = (over = {}) => ({
  game: 'blitz', difficulty: 'medium', score: 300, solved: 20, correct: 18,
  wrong: 2, best_streak: 9, duration_ms: 60000, is_daily: false, daily_date: null,
  drill_id: null, ...over
});

const attempts = (n, band = 2, correct = true) =>
  Array.from({ length: n }, () => ({ kind: 'pad', op: '*', band, isCorrect: correct, answer: 56 }));

describe('applyRun', () => {
  test('awards XP and writes the row on a first-ever run', async () => {
    const p = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    assert.ok(p.xpGained > 0);
    assert.equal(p.level.level >= 1, true);
    assert.equal(p.streak.dayStreak, 1, 'first day starts the streak');

    const row = sb.tables.player_progress[0];
    assert.equal(row.user_id, USER);
    assert.equal(row.xp, p.xpGained);
    assert.equal(row.total_solved, 20);
    assert.equal(row.total_correct, 18);
    assert.equal(row.last_day, '2026-08-26');
    assert.deepEqual(row.modes_played, ['blitz']);
  });

  test('accumulates across runs without double-counting the day', async () => {
    const a = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    const b = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    assert.equal(sb.tables.player_progress.length, 1, 'one row per player');
    assert.equal(sb.tables.player_progress[0].total_solved, 40);
    assert.equal(b.streak.dayStreak, 1, 'still day one');
    assert.ok(b.xpGained < a.xpGained, 'the first-of-day bonus is not paid twice');
  });

  test('extends the streak on a consecutive day', async () => {
    await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-25' });
    const p = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    assert.equal(p.streak.dayStreak, 2);
    assert.equal(p.streak.extended, true);
  });

  test('a week of play earns a freeze and hits the 7-day milestone', async () => {
    const days = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26'];
    let last;
    for (const d of days) last = await applyRun(USER, run(), { attempts: attempts(18), today: d });
    assert.equal(last.streak.dayStreak, 7);
    assert.equal(last.streak.milestone, 7, 'the milestone fires on the day it is crossed');
    assert.ok(last.xpLines.some(l => l.code === 'milestone'), 'and is itemised');
    assert.ok(sb.tables.player_progress[0].streak_freezes >= 1, 'five days played earned a freeze');
  });

  test('a missed day is covered by a freeze rather than breaking a long streak', async () => {
    sb.tables.player_progress = [{
      id: 1, user_id: USER, xp: 5000, level: 9, day_streak: 40, longest_streak: 40,
      streak_freezes: 2, days_played: 40, last_day: '2026-08-24', total_solved: 800,
      total_correct: 700, modes_played: ['blitz']
    }];
    const p = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    assert.equal(p.streak.dayStreak, 41, '40 days should not die to one bad Tuesday');
    assert.equal(p.streak.freezesUsed, 1);
    assert.equal(sb.tables.player_progress[0].streak_freezes, 1);
  });

  test('too long away resets the streak but keeps the longest', async () => {
    sb.tables.player_progress = [{
      id: 1, user_id: USER, xp: 5000, level: 9, day_streak: 40, longest_streak: 40,
      streak_freezes: 0, days_played: 40, last_day: '2026-07-01', total_solved: 800,
      total_correct: 700, modes_played: ['blitz']
    }];
    const p = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    assert.equal(p.streak.dayStreak, 1, 'restarted');
    assert.equal(p.streak.wasBroken, true);
    assert.equal(sb.tables.player_progress[0].longest_streak, 40, 'the record stands');
  });

  test('unlocks achievements and records them once', async () => {
    sb.tables.player_progress = [{
      id: 1, user_id: USER, xp: 400, level: 3, day_streak: 1, longest_streak: 1,
      streak_freezes: 0, days_played: 1, last_day: '2026-08-25', total_solved: 95,
      total_correct: 90, modes_played: ['blitz']
    }];
    const p = await applyRun(USER, run({ solved: 10, correct: 10 }), { attempts: attempts(10), today: '2026-08-26' });
    assert.ok(p.achievements.some(a => a.code === 'solved_100'), '95 + 10 crosses 100');
    assert.ok(sb.tables.achievements.some(r => r.code === 'solved_100'));
    assert.ok(p.xpLines.some(l => l.code === 'achievements'), 'the XP is itemised');

    const again = await applyRun(USER, run({ solved: 10, correct: 10 }), { attempts: attempts(10), today: '2026-08-27' });
    assert.equal(again.achievements.some(a => a.code === 'solved_100'), false, 'no duplicate unlock');
  });

  test('level-up is reported so the client can celebrate it', async () => {
    const p = await applyRun(USER, run({ solved: 60, correct: 60, best_streak: 60 }), { attempts: attempts(60, 4), today: '2026-08-26' });
    assert.equal(p.levelledUp, true);
    assert.ok(p.levelsGained >= 1);
    assert.equal(sb.tables.player_progress[0].level, p.level.level);
  });

  test('tracks per-mode counters the achievements read', async () => {
    await applyRun(USER, run({ game: 'zen', solved: 30, correct: 28 }), { attempts: attempts(28), today: '2026-08-26' });
    await applyRun(USER, run({ game: 'survival', solved: 26, correct: 25 }), { attempts: attempts(25), today: '2026-08-26' });
    await applyRun(USER, run({ game: 'drill', solved: 20, correct: 20 }), { attempts: attempts(20), today: '2026-08-26' });
    const row = sb.tables.player_progress[0];
    assert.equal(row.zen_solved, 30);
    assert.equal(row.best_survival, 25);
    assert.equal(row.drills_done, 1);
    assert.deepEqual([...row.modes_played].sort(), ['drill', 'survival', 'zen']);
  });

  test('records the longest recalled number', async () => {
    await applyRun(USER, run({ game: 'recall', solved: 3, correct: 3 }), {
      attempts: [
        { kind: 'recall', op: null, isCorrect: true, answer: 481 },
        { kind: 'recall', op: null, isCorrect: true, answer: 481203957 },
        { kind: 'recall', op: null, isCorrect: false, answer: 4812039571 }
      ],
      today: '2026-08-26'
    });
    assert.equal(sb.tables.player_progress[0].best_recall_digits, 9, 'the wrong one does not count');
  });

  test('a perfect run and a fast run are both counted', async () => {
    await applyRun(USER, run({ solved: 16, correct: 16, duration_ms: 16000 }), { attempts: attempts(16), today: '2026-08-26' });
    const row = sb.tables.player_progress[0];
    assert.equal(row.perfect_runs, 1);
    assert.equal(row.sub_two_sec_runs, 1, '1000ms per problem');
  });

  test('a daily challenge pays its premium and counts', async () => {
    const p = await applyRun(USER, run({ game: 'daily', is_daily: true, solved: 12, correct: 12 }), { attempts: attempts(12), today: '2026-08-26' });
    assert.ok(p.xpLines.some(l => l.code === 'daily'));
    assert.ok(p.xpLines.some(l => l.code === 'daily_perfect'));
    const row = sb.tables.player_progress[0];
    assert.equal(row.dailies_done, 1);
    assert.equal(row.perfect_dailies, 1);
  });

  test('Pro gets a third streak freeze', async () => {
    const days = ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
      '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25',
      '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];
    for (const d of days) await applyRun(USER, run(), { attempts: attempts(18), isPro: true, today: d });
    assert.equal(sb.tables.player_progress[0].streak_freezes, 3, 'capped at the Pro maximum');
  });

  test('league XP is attempted but never fails the run', async () => {
    const p = await applyRun(USER, run(), { attempts: attempts(18), today: '2026-08-26' });
    assert.ok(p.xpGained > 0, 'the run still returned progression');
    const called = sb.requests.filter(r => r.path.endsWith('/rpc/add_league_xp'));
    assert.equal(called.length, 1);
    assert.equal(called[0].body.p_xp, p.xpGained);
  });

  test('XP never goes backwards', async () => {
    let prev = 0;
    for (const d of ['2026-08-24', '2026-08-25', '2026-08-26']) {
      await applyRun(USER, run(), { attempts: attempts(18), today: d });
      const xp = sb.tables.player_progress[0].xp;
      assert.ok(xp > prev, `${xp} should exceed ${prev}`);
      prev = xp;
    }
  });
});

describe('/api/runs returns progression', () => {
  async function post(body) {
    const req = mockReq({
      method: 'POST', url: '/api/runs',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body
    });
    const res = mockRes();
    await runsHandler(req, res);
    await res.done;
    return res;
  }

  const payload = (over = {}) => ({
    game: 'blitz', difficulty: 'medium', score: 300, solved: 12, correct: 12,
    wrong: 0, bestStreak: 12, durationMs: 30000, isDaily: false, dailyDate: null,
    drillId: null, clientTs: new Date().toISOString(),
    attempts: Array.from({ length: 12 }, () => ({
      kind: 'pad', op: '*', a: 7, b: 8, answer: 56, given: 56,
      isCorrect: true, timedOut: false, elapsedMs: 1800, difficulty: 'medium'
    })),
    ...over
  });

  test('a finished run comes back with XP, level and streak', async () => {
    const res = await post(payload());
    assert.equal(res.statusCode, 200);
    assert.ok(res.json.progress, 'progression is in the response');
    assert.ok(res.json.progress.xpGained > 0);
    assert.equal(res.json.progress.streak.dayStreak, 1);
    assert.ok(Array.isArray(res.json.progress.xpLines));
    assert.equal(res.json.progress.level.level >= 1, true);
  });

  test('bands computed server-side drive the XP', async () => {
    // The client sends operands, not bands, so XP cannot be inflated by
    // claiming every problem was four digits.
    const small = await post(payload({ attempts: payload().attempts.map(a => ({ ...a, a: 3, b: 4, answer: 7, given: 7 })) }));
    const big = await post(payload({ attempts: payload().attempts.map(a => ({ ...a, a: 4000, b: 12, answer: 48000, given: 48000, band: 1 })) }));
    assert.ok(big.json.progress.xpGained > small.json.progress.xpGained,
      'bigger numbers earn more, and the claimed band is ignored');
  });

  test('an import backfill awards nothing', async () => {
    // Handing out a level 20 for migrating local history would give away every
    // volume achievement at once and make the arc meaningless.
    const res = await post({
      game: 'import', difficulty: 'mixed', score: 0, solved: 5000, correct: 4500,
      wrong: 500, bestStreak: 60, durationMs: 0, isDaily: false, dailyDate: null,
      drillId: null, clientTs: new Date().toISOString(), attempts: []
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.progress, undefined);
    assert.equal(sb.tables.player_progress.length, 0);
  });

  test('a progression failure does not lose the run', async () => {
    // player_progress is unreachable; the run itself must still persist.
    sb.fail('player_progress');
    try {
      const res = await post(payload());
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.accepted, true, 'a run is worth more than its XP');
      assert.equal(res.json.progress, undefined, 'no progression, but no lost run either');
      assert.equal(sb.tables.runs.length, 1, 'the run is on disk');
    } finally {
      sb.unfail('player_progress');
    }
  });

  test('an anonymous post still gets no progression', async () => {
    const req = mockReq({ method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/json' }, body: payload() });
    const res = mockRes();
    await runsHandler(req, res);
    await res.done;
    assert.equal(res.statusCode, 401);
    assert.equal(sb.tables.player_progress.length, 0);
  });
});

describe('loadProgress', () => {
  test('a player with no row reads as a fresh start, not an error', async () => {
    const p = await loadProgress('00000000-0000-0000-0000-000000000000');
    assert.equal(p.xp, 0);
    assert.equal(p.level, 1);
    assert.equal(p.day_streak, 0);
    assert.deepEqual(p.modes_played, []);
  });
});
