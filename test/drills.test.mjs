import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase, mockReq, mockRes } from './fake-supabase.mjs';
import { bandOf } from '../lib/weakness.js';
import { problemFor, generateProblems, snapshotTargets } from '../lib/drillgen.js';

const USER = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'token-user';
let sb, drills, weakspots;

before(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  process.env.SUPABASE_ANON_KEY = 'anon';
  sb = await fakeSupabase();
  sb.tables.__tokens = { [TOKEN]: { id: USER, email: 'p@example.com', user_metadata: {} } };
  process.env.SUPABASE_URL = sb.url;
  drills = (await import('../api/drills.js')).default;
  weakspots = (await import('../api/weakspots.js')).default;
});
after(async () => { await sb?.close(); });

/* A deliberately lopsided history: division 10–99 is bad and slow, addition
   0–9 is near-perfect and fast. Mirrors sql/004_seed_dev.sql. */
const LOPSIDED = [
  { user_id: USER, op: '/', band: 2, seen: 60, correct: 33, avg_ms: 5300, median_ms: 5200 },
  { user_id: USER, op: '*', band: 3, seen: 40, correct: 26, avg_ms: 5000, median_ms: 4900 },
  { user_id: USER, op: '*', band: 2, seen: 40, correct: 31, avg_ms: 3700, median_ms: 3600 },
  { user_id: USER, op: '-', band: 2, seen: 30, correct: 26, avg_ms: 3150, median_ms: 3100 },
  { user_id: USER, op: '+', band: 1, seen: 50, correct: 49, avg_ms: 1250, median_ms: 1200 }
];

function seed({ buckets = LOPSIDED, attempts = 220, pro = true, trend = [], recent10 = [] } = {}) {
  sb.tables.entitlements = [{
    id: 1, user_id: USER,
    plan: pro ? 'yearly' : 'free',
    status: pro ? 'active' : 'none',
    current_period_end: pro ? '2099-01-01T00:00:00Z' : null
  }];
  sb.tables.v_bucket_stats = buckets;
  sb.tables.v_bucket_trend = trend;
  sb.tables.v_bucket_recent10 = recent10;
  sb.tables.attempts = Array.from({ length: attempts }, (_, i) => ({ id: i + 1, user_id: USER }));
  sb.tables.drills = [];
  sb.requests.length = 0;
}

async function call(handler, url = '/api/drills', token = TOKEN, method = 'GET') {
  const req = mockReq({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const res = mockRes();
  await handler(req, res);
  await res.done;
  return res;
}

beforeEach(() => seed());

describe('GET /api/drills — gating', () => {
  test('anonymous is 401', async () => {
    assert.equal((await call(drills, '/api/drills', null)).statusCode, 401);
  });

  test('a free user is 403 pro_required', async () => {
    seed({ pro: false });
    const res = await call(drills);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json.error, 'pro_required');
  });

  test('a cold-start user gets 422 with how many more answers are needed', async () => {
    // Do not fabricate a drill from nothing. A generic set labelled
    // "personalised" is what gets a refund request.
    seed({ attempts: 12, buckets: [] });
    const res = await call(drills);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json.error, 'insufficient_data');
    assert.equal(res.json.attemptsNeeded, 28);
    assert.equal(res.json.attemptsSoFar, 12);
    assert.equal(sb.tables.drills.length, 0, 'nothing persisted');
  });

  test('enough attempts but no bucket over the threshold is still 422', async () => {
    seed({ attempts: 60, buckets: [{ user_id: USER, op: '+', band: 1, seen: 5, correct: 4, median_ms: 2000 }] });
    const res = await call(drills);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json.error, 'insufficient_data');
  });

  test('a fully mastered profile says so rather than serving filler', async () => {
    seed({
      buckets: [{ user_id: USER, op: '+', band: 1, seen: 50, correct: 50, median_ms: 1200 }],
      recent10: [{ user_id: USER, op: '+', band: 1, seen: 10, correct: 10, median_ms: 1100 }]
    });
    const res = await call(drills);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json.error, 'all_mastered');
  });

  test('POST is refused', async () => {
    assert.equal((await call(drills, '/api/drills', TOKEN, 'POST')).statusCode, 405);
  });
});

describe('GET /api/drills — composition', () => {
  /* The Phase 5 acceptance criterion. */
  test('a bad division record produces a visibly division-heavy drill', async () => {
    const res = await call(drills);
    assert.equal(res.statusCode, 200);
    const division = res.json.problems.filter(p => p.op === '/').length;
    assert.ok(division >= 5, `expected a division-heavy drill, got ${division}/20`);
    assert.equal(res.json.targeted[0].op, '/', 'division is named as the top target');
  });

  test('returns exactly twenty problems by default', async () => {
    const res = await call(drills);
    assert.equal(res.json.problems.length, 20);
    assert.equal(res.json.size, 20);
  });

  test('honours a size parameter within sane bounds', async () => {
    assert.equal((await call(drills, '/api/drills?size=10')).json.problems.length, 10);
    assert.equal((await call(drills, '/api/drills?size=1')).json.problems.length, 5, 'floor');
    assert.equal((await call(drills, '/api/drills?size=9999')).json.problems.length, 50, 'ceiling');
    assert.equal((await call(drills, '/api/drills?size=abc')).json.problems.length, 20, 'default');
  });

  test('every problem is arithmetically correct', async () => {
    const res = await call(drills, '/api/drills?size=50');
    for (const p of res.json.problems) {
      const expected = p.op === '+' ? p.a + p.b : p.op === '-' ? p.a - p.b : p.op === '*' ? p.a * p.b : p.a / p.b;
      assert.equal(p.answer, expected, `${p.a} ${p.op} ${p.b} should be ${expected}, got ${p.answer}`);
      assert.ok(Number.isInteger(p.answer), 'answers are whole numbers');
      assert.ok(p.answer >= 0, 'never negative');
    }
  });

  test('each problem is banded consistently with the server-side rule', async () => {
    const res = await call(drills, '/api/drills?size=50');
    for (const p of res.json.problems) {
      assert.equal(bandOf(p.op, p.a, p.b), p.band, `${p.a} ${p.op} ${p.b} banded as ${p.band}`);
    }
  });

  test('interleaves rather than blocking', async () => {
    const res = await call(drills);
    const keys = res.json.problems.map(p => `${p.op}:${p.band}`);
    let run = 1, worst = 1;
    for (let i = 1; i < keys.length; i++) {
      run = keys[i] === keys[i - 1] ? run + 1 : 1;
      worst = Math.max(worst, run);
    }
    assert.ok(worst <= 2, `blocked run of ${worst}; interleaved practice retains better`);
  });

  test('includes at least one easy win', async () => {
    const res = await call(drills);
    // The strongest bucket is addition 0–9; an all-weakness set is twenty
    // problems of failing and people quit.
    assert.ok(res.json.problems.some(p => p.op === '+'), 'some wins in the set');
  });

  test('persists the drill with its pre-drill snapshot', async () => {
    const res = await call(drills);
    assert.equal(sb.tables.drills.length, 1);
    const row = sb.tables.drills[0];
    assert.equal(row.user_id, USER);
    assert.equal(row.problems.length, 20);
    assert.equal(res.json.drillId, row.id);

    const div = row.buckets.find(b => b.op === '/' && b.band === 2);
    assert.ok(div, 'the targeted bucket is recorded');
    assert.ok(typeof div.accuracy === 'number', 'with its pre-drill accuracy');
    assert.ok(typeof div.weakness === 'number');
    assert.equal(div.medianMs, 5200, 'and its pre-drill pace');
  });

  test('skips mastered buckets in targeting', async () => {
    seed({
      recent10: [{ user_id: USER, op: '/', band: 2, seen: 10, correct: 10, median_ms: 2000 }]
    });
    const res = await call(drills);
    assert.equal(res.json.problems.filter(p => p.op === '/').length, 0, 'graduated buckets stop being drilled');
  });
});

describe('GET /api/weakspots', () => {
  test('anonymous is 401, free is 403', async () => {
    assert.equal((await call(weakspots, '/api/weakspots', null)).statusCode, 401);
    seed({ pro: false });
    assert.equal((await call(weakspots, '/api/weakspots')).statusCode, 403);
  });

  test('ranks the weak spots and names the strongest', async () => {
    const res = await call(weakspots, '/api/weakspots');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.buckets[0].op, '/');
    assert.equal(res.json.buckets[0].label, 'Division, 10–99');
    assert.equal(res.json.strongest.op, '+');
    assert.equal(res.json.sampleTooSmall, false);
  });

  test('flags a sample too small to speak from', async () => {
    seed({ attempts: 20 });
    const res = await call(weakspots, '/api/weakspots');
    assert.equal(res.json.sampleTooSmall, true);
    assert.equal(res.json.attemptsNeeded, 20);
  });

  test('reports a trend only when both windows have data', async () => {
    seed({
      trend: [
        { user_id: USER, op: '/', band: 2, window: 'recent', seen: 40, correct: 12, median_ms: 6200 },
        { user_id: USER, op: '/', band: 2, window: 'prior', seen: 20, correct: 18, median_ms: 2800 },
        { user_id: USER, op: '+', band: 1, window: 'recent', seen: 30, correct: 29, median_ms: 1200 }
      ]
    });
    const res = await call(weakspots, '/api/weakspots');
    const div = res.json.buckets.find(b => b.op === '/');
    const add = res.json.buckets.find(b => b.op === '+');
    assert.equal(div.trend, 'worsening');
    assert.equal(add.trend, null, 'one window is not a trend');
  });

  test('marks mastered buckets', async () => {
    seed({ recent10: [{ user_id: USER, op: '+', band: 1, seen: 10, correct: 10, median_ms: 1100 }] });
    const res = await call(weakspots, '/api/weakspots');
    assert.equal(res.json.buckets.find(b => b.op === '+').mastered, true);
    assert.equal(res.json.buckets.find(b => b.op === '/').mastered, false);
  });

  test('never exposes store identifiers', async () => {
    const res = await call(weakspots, '/api/weakspots');
    const s = JSON.stringify(res.json);
    for (const leak of ['user_id', 'licence', 'ls_', USER]) {
      assert.equal(s.includes(leak), false, `${leak} must not reach the client`);
    }
  });
});

describe('problem generation', () => {
  test('respects the band, not the caller\'s difficulty preference', () => {
    for (const band of [1, 2, 3, 4]) {
      for (let i = 0; i < 50; i++) {
        for (const op of ['+', '-', '*', '/']) {
          const p = problemFor(op, band);
          assert.equal(bandOf(p.op, p.a, p.b), band, `${op} band ${band}: ${p.a} ${op} ${p.b}`);
        }
      }
    }
  });

  test('division always divides exactly', () => {
    for (const band of [1, 2, 3, 4]) {
      for (let i = 0; i < 100; i++) {
        const p = problemFor('/', band);
        assert.equal(p.a % p.b, 0, `${p.a} / ${p.b} must be exact`);
        assert.equal(p.answer, p.a / p.b);
      }
    }
  });

  test('subtraction never goes negative', () => {
    for (const band of [1, 2, 3, 4]) {
      for (let i = 0; i < 100; i++) {
        assert.ok(problemFor('-', band).answer >= 0);
      }
    }
  });

  test('avoids repeating the identical question inside one drill', () => {
    const order = Array.from({ length: 20 }, () => ({ op: '*', band: 3 }));
    const problems = generateProblems(order);
    const keys = problems.map(p => `${p.a}:${p.b}`);
    assert.ok(new Set(keys).size >= 18, `${new Set(keys).size}/20 distinct — a set with 7x8 three times reads as a bug`);
  });

  test('a tiny band still returns a full set rather than a short one', () => {
    const order = Array.from({ length: 20 }, () => ({ op: '+', band: 1 }));
    assert.equal(generateProblems(order).length, 20, 'a repeat beats a gap');
  });
});

describe('pre-drill snapshot', () => {
  test('records each targeted bucket once, with its count and score', () => {
    const scored = [
      { op: '/', band: 2, weakness: 0.62, accuracy: 0.55, medianMs: 5200, seen: 60 },
      { op: '+', band: 1, weakness: 0.05, accuracy: 0.98, medianMs: 1200, seen: 50 }
    ];
    const order = [
      ...Array(14).fill({ op: '/', band: 2 }),
      ...Array(6).fill({ op: '+', band: 1 })
    ];
    const snap = snapshotTargets(scored, order);
    assert.equal(snap.length, 2);
    assert.equal(snap[0].op, '/', 'weakest first');
    assert.equal(snap[0].count, 14);
    assert.equal(snap[0].accuracy, 0.55);
    assert.equal(snap[1].count, 6);
  });

  test('a bucket with no prior score still appears, with nulls', () => {
    const snap = snapshotTargets([], [{ op: '*', band: 2 }]);
    assert.equal(snap.length, 1);
    assert.equal(snap[0].accuracy, null);
    assert.equal(snap[0].label, 'Multiplication, 10–99');
  });
});
