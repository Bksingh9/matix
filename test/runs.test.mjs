import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'token-user';
let sb, handler, rpcCalls;

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  process.env.SUPABASE_ANON_KEY = 'anon';
  sb = await fakeSupabase();
  sb.tables.__tokens = { [TOKEN]: { id: USER, email: 'p@example.com', user_metadata: {} } };
  process.env.SUPABASE_URL = sb.url;
  handler = (await import('../api/runs.js')).default;
});
after(async () => { await sb?.close(); });

beforeEach(() => {
  sb.tables.runs = [];
  sb.tables.daily_scores = [];
  sb.tables.drills = [];
  sb.requests.length = 0;
  rpcCalls = () => sb.requests.filter(r => r.path.endsWith('/rpc/insert_run_with_attempts'));
});

const baseRun = (over = {}) => ({
  game: 'blitz', difficulty: 'medium',
  score: 412, solved: 24, correct: 22, wrong: 2,
  bestStreak: 11, durationMs: 60000,
  isDaily: false, dailyDate: null, drillId: null,
  clientTs: '2026-08-26T10:00:00.000Z',
  attempts: [],
  ...over
});

const attempt = (over = {}) => ({
  kind: 'pad', op: '*', a: 7, b: 8, answer: 56, given: 56,
  isCorrect: true, timedOut: false, elapsedMs: 1840, difficulty: 'medium',
  ...over
});

async function call(body, token = TOKEN, method = 'POST') {
  const req = mockReq({
    method, url: '/api/runs',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body
  });
  const res = mockRes();
  await handler(req, res);
  await res.done;
  return res;
}

const lastRpc = () => {
  const calls = rpcCalls();
  return calls.length ? calls[calls.length - 1].body : null;
};

describe('auth and method', () => {
  test('an anonymous post is 401', async () => {
    const res = await call(baseRun(), null);
    assert.equal(res.statusCode, 401);
    assert.equal(rpcCalls().length, 0);
  });

  test('GET is refused', async () => {
    const res = await call(null, TOKEN, 'GET');
    assert.equal(res.statusCode, 405);
  });
});

describe('bands are computed server-side', () => {
  test('never trusts a client-supplied band', async () => {
    // A client bug — or a client lie — would otherwise poison the exact
    // dataset the weak-spot report is built from.
    await call(baseRun({
      attempts: [attempt({ op: '/', a: 84, b: 12, answer: 7, band: 4, difficulty: 'medium' })]
    }));
    const rows = lastRpc().p_attempts;
    assert.equal(rows[0].band, 2, 'banded off the dividend, not the claimed value');
  });

  test('bands each operation by magnitude', async () => {
    await call(baseRun({
      attempts: [
        attempt({ op: '+', a: 3, b: 4, answer: 7 }),
        attempt({ op: '*', a: 40, b: 7, answer: 280 }),
        attempt({ op: '-', a: 640, b: 12, answer: 628 }),
        attempt({ op: '+', a: 4000, b: 12, answer: 4012 })
      ]
    }));
    assert.deepEqual(lastRpc().p_attempts.map(a => a.band), [1, 2, 3, 4]);
  });

  test('recall attempts carry no operation', async () => {
    await call(baseRun({
      game: 'recall',
      attempts: [attempt({ kind: 'recall', op: null, a: null, b: null, answer: 48213, given: 48213 })]
    }));
    const row = lastRpc().p_attempts[0];
    assert.equal(row.op, null, 'a memory round is not addition');
    assert.equal(row.kind, 'recall');
  });

  test('an unrecognised op is stored as null rather than guessed', async () => {
    await call(baseRun({ attempts: [attempt({ op: '^' })] }));
    assert.equal(lastRpc().p_attempts[0].op, null);
  });
});

describe('attempt shaping', () => {
  test('a timed-out attempt has no given answer', async () => {
    await call(baseRun({
      attempts: [attempt({ isCorrect: false, timedOut: true, given: 12345, elapsedMs: 7000 })]
    }));
    const row = lastRpc().p_attempts[0];
    assert.equal(row.given, null);
    assert.equal(row.timed_out, true);
    assert.equal(row.is_correct, false);
  });

  test('an absurd elapsed time is clamped, not dropped', async () => {
    // A stopwatch glitch on one problem should not discard a run's worth of
    // otherwise good data.
    await call(baseRun({ attempts: [attempt({ elapsedMs: 99_999_999 }), attempt({ elapsedMs: -5 })] }));
    const rows = lastRpc().p_attempts;
    assert.equal(rows[0].elapsed_ms, 600_000);
    assert.equal(rows[1].elapsed_ms, 0);
  });

  test('operands beyond integer range become null rather than erroring', async () => {
    await call(baseRun({ attempts: [attempt({ a: 1e18, b: 3, answer: 3e18 })] }));
    const row = lastRpc().p_attempts[0];
    assert.equal(row.operand_a, null);
    assert.equal(row.operand_b, 3);
  });

  test('attempts with an unknown kind are dropped', async () => {
    await call(baseRun({ attempts: [attempt(), attempt({ kind: 'telepathy' }), null, 'nope'] }));
    assert.equal(lastRpc().p_attempts.length, 1);
  });

  test('truthiness is not accepted for booleans', async () => {
    await call(baseRun({ attempts: [attempt({ isCorrect: 'yes', timedOut: 1 })] }));
    const row = lastRpc().p_attempts[0];
    assert.equal(row.is_correct, false, 'only a real true is correct');
    assert.equal(row.timed_out, false);
  });
});

describe('validation', () => {
  test('rejects an unknown game', async () => {
    const res = await call(baseRun({ game: 'chess' }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'bad_game');
  });

  test('rejects an unknown difficulty', async () => {
    assert.equal((await call(baseRun({ difficulty: 'nightmare' }))).json.error, 'bad_difficulty');
  });

  test('rejects negative, absurd and non-numeric counters', async () => {
    for (const over of [{ score: -1 }, { solved: 'lots' }, { durationMs: 99 * 3600 * 1000 }, { correct: NaN }]) {
      const res = await call(baseRun(over));
      assert.equal(res.statusCode, 400, JSON.stringify(over));
    }
  });

  test('rejects a score the engine could not have paid', async () => {
    // daily_scores feeds the public leaderboard directly, so an unbounded
    // client number there is not a score, it is a text field.
    const res = await call(baseRun({ solved: 10, correct: 10, wrong: 0, bestStreak: 10, score: 1_000_000 }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'implausible_score');
  });

  test('accepts a strong but achievable score', async () => {
    // The hardest band, full speed bonus, top streak multiplier, every answer
    // correct. The bound must not punish someone who is simply very good.
    const res = await call(baseRun({ solved: 30, correct: 30, wrong: 0, bestStreak: 30, score: 30 * 206 }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.json));
  });

  test('the score ceiling follows correct answers, not attempts', async () => {
    // Padding `solved` must buy no headroom — only correct answers pay out.
    const res = await call(baseRun({ solved: 500, correct: 1, wrong: 499, bestStreak: 1, score: 5000 }));
    assert.equal(res.json.error, 'implausible_score');
  });

  test('rejects internally inconsistent counts', async () => {
    let res = await call(baseRun({ solved: 5, correct: 9 }));
    assert.equal(res.json.error, 'inconsistent_counts');
    res = await call(baseRun({ solved: 5, correct: 3, bestStreak: 40 }));
    assert.equal(res.json.error, 'inconsistent_counts');
  });

  test('rejects more than 500 attempts', async () => {
    const res = await call(baseRun({ attempts: Array.from({ length: 501 }, () => attempt()) }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error, 'too_many_attempts');
    assert.equal(rpcCalls().length, 0);
  });

  test('accepts exactly 500', async () => {
    const res = await call(baseRun({ solved: 500, correct: 500, attempts: Array.from({ length: 500 }, () => attempt()) }));
    assert.equal(res.statusCode, 200);
  });

  test('a bad clientTs becomes null instead of a database error', async () => {
    await call(baseRun({ clientTs: 'last tuesday' }));
    assert.equal(lastRpc().p_run.client_ts, null);
  });
});

describe('implausible timing', () => {
  test('is flagged and logged, not rejected', async () => {
    // Score integrity only matters once there is a public leaderboard. Log it,
    // don't ban — a false positive would delete a real player's history.
    const attempts = Array.from({ length: 20 }, (_, i) => attempt({ elapsedMs: i < 10 ? 40 : 3000 }));
    const res = await call(baseRun({ solved: 20, correct: 20, wrong: 0, attempts }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.accepted, true);
    assert.equal(res.json.flagged, 'timing');
    assert.equal(lastRpc().p_attempts.length, 20, 'the data is still kept');
  });

  test('a fast but human run is not flagged', async () => {
    const attempts = Array.from({ length: 20 }, () => attempt({ elapsedMs: 700 }));
    const res = await call(baseRun({ solved: 20, correct: 20, wrong: 0, attempts }));
    assert.equal(res.json.flagged, undefined);
  });

  test('a very short run is not flagged on a single fast answer', async () => {
    const res = await call(baseRun({ solved: 2, correct: 2, wrong: 0, attempts: [attempt({ elapsedMs: 50 }), attempt()] }));
    assert.equal(res.json.flagged, undefined);
  });
});

describe('the daily challenge', () => {
  test('is recorded on the leaderboard', async () => {
    const res = await call(baseRun({ game: 'daily', isDaily: true, dailyDate: '2026-08-26', grid: '🟩🟩🟥' }));
    assert.equal(res.statusCode, 200);
    assert.equal(sb.tables.daily_scores.length, 1);
    assert.equal(sb.tables.daily_scores[0].daily_date, '2026-08-26');
    assert.equal(sb.tables.daily_scores[0].score, 412);
  });

  test('a second submission for the same day is a 409 carrying the first', async () => {
    sb.tables.runs = [{ id: 77, user_id: USER, daily_date: '2026-08-26', is_daily: true, score: 300 }];
    const res = await call(baseRun({ game: 'daily', isDaily: true, dailyDate: '2026-08-26' }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error, 'daily_already_submitted');
    assert.equal(res.json.runId, 77);
    assert.equal(res.json.score, 300);
    assert.equal(rpcCalls().length, 0, 'nothing written');
  });

  test('a missing date defaults to today rather than failing', async () => {
    await call(baseRun({ game: 'daily', isDaily: true, dailyDate: null }));
    assert.equal(lastRpc().p_run.daily_date, new Date().toISOString().slice(0, 10));
  });

  test('a malformed date is replaced, not passed through', async () => {
    await call(baseRun({ game: 'daily', isDaily: true, dailyDate: '26/08/2026' }));
    assert.match(lastRpc().p_run.daily_date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('drills', () => {
  test('a completed drill run marks the drill complete', async () => {
    sb.tables.drills = [{ id: 88, user_id: USER, completed_at: null }];
    const res = await call(baseRun({ game: 'drill', difficulty: 'mixed', drillId: 88 }));
    assert.equal(res.statusCode, 200);
    assert.ok(sb.tables.drills[0].completed_at, 'completion timestamp written');
  });

  test('a drill belonging to someone else is not touched', async () => {
    sb.tables.drills = [{ id: 88, user_id: 'someone-else', completed_at: null }];
    await call(baseRun({ game: 'drill', difficulty: 'mixed', drillId: 88 }));
    assert.equal(sb.tables.drills[0].completed_at, null);
  });
});

describe('the import backfill', () => {
  test('accepts a synthetic import run with no attempts', async () => {
    const res = await call({
      game: 'import', difficulty: 'mixed', score: 0,
      solved: 240, correct: 205, wrong: 35, bestStreak: 17, durationMs: 0,
      isDaily: false, dailyDate: null, drillId: null,
      clientTs: new Date().toISOString(),
      importDays: ['2026-08-20', '2026-08-21'], attempts: []
    });
    assert.equal(res.statusCode, 200);
    assert.equal(lastRpc().p_run.game, 'import');
    assert.equal(lastRpc().p_attempts.length, 0);
  });
});
