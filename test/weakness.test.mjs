import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandOf, wilsonLower, weaknessOf, isEligible, isMastered, trendOf,
  buildReport, chooseBuckets, interleave, bucketKey, TARGET_MS, MIN_SEEN
} from '../lib/weakness.js';

describe('banding', () => {
  test('bands by magnitude', () => {
    assert.equal(bandOf('+', 3, 4), 1);
    assert.equal(bandOf('+', 40, 7), 2);
    assert.equal(bandOf('*', 250, 9), 3);
    assert.equal(bandOf('+', 4000, 12), 4);
  });

  test('takes the larger operand', () => {
    assert.equal(bandOf('*', 3, 40), 2, '3 x 40 is a two-digit problem');
    assert.equal(bandOf('-', 900, 4), 3);
  });

  test('division bands off the dividend', () => {
    // 84 ÷ 12 is a two-digit problem. Banding on the divisor would call it
    // single-digit and file it next to 6 ÷ 2.
    assert.equal(bandOf('/', 84, 12), 2);
    assert.equal(bandOf('/', 8, 2), 1);
    assert.equal(bandOf('/', 840, 12), 3);
  });

  test('boundaries land on the right side', () => {
    assert.equal(bandOf('+', 9, 9), 1);
    assert.equal(bandOf('+', 10, 1), 2);
    assert.equal(bandOf('+', 99, 1), 2);
    assert.equal(bandOf('+', 100, 1), 3);
    assert.equal(bandOf('+', 999, 1), 3);
    assert.equal(bandOf('+', 1000, 1), 4);
  });

  test('handles negatives and junk without throwing', () => {
    assert.equal(bandOf('-', -45, 3), 2, 'magnitude, not sign');
    assert.equal(bandOf('+', null, undefined), 1);
    assert.equal(bandOf('+', NaN, 'x'), 1);
  });
});

describe('Wilson lower bound', () => {
  test('is below raw accuracy, and more so on small samples', () => {
    const small = wilsonLower(3, 4);      // 75% from four attempts
    const large = wilsonLower(300, 400);  // 75% from four hundred
    assert.ok(small < 0.75);
    assert.ok(large < 0.75);
    assert.ok(large > small, 'the same rate is stronger evidence with more data');
  });

  test('approaches the true rate as the sample grows', () => {
    assert.ok(wilsonLower(9000, 10000) > 0.89);
    assert.ok(wilsonLower(9, 10) < 0.85);
  });

  test('a perfect small sample is not treated as certainty', () => {
    assert.ok(wilsonLower(3, 3) < 0.5, 'three from three proves little');
    assert.ok(wilsonLower(100, 100) > 0.95);
  });

  test('stays inside [0,1] on edge inputs', () => {
    for (const [c, n] of [[0, 0], [0, 1], [1, 1], [0, 10], [10, 10], [5, 5]]) {
      const v = wilsonLower(c, n);
      assert.ok(v >= 0 && v <= 1, `${c}/${n} → ${v}`);
    }
    assert.equal(wilsonLower(0, 0), 0);
    assert.equal(wilsonLower(5, 0), 0);
  });
});

describe('weakness score', () => {
  /* The check the spec names explicitly: a 3/4 bucket must not outrank a
     300/400 bucket. Without the Wilson bound both read as 75% accurate and the
     tiny sample wins on noise, so the drill chases whatever the user last got
     unlucky on. */
  test('a 3/4 bucket does not outrank a 300/400 bucket', () => {
    const tiny = weaknessOf({ correct: 3, seen: 4, medianMs: 3200, band: 2 });
    const big = weaknessOf({ correct: 300, seen: 400, medianMs: 3200, band: 2 });
    assert.ok(big > tiny,
      `300/400 (${big.toFixed(3)}) must rank weaker than 3/4 (${tiny.toFixed(3)}) at the same rate`);
  });

  test('a genuinely bad small sample still does not beat a slightly-bad large one', () => {
    const tiny = weaknessOf({ correct: 1, seen: 8, medianMs: 3200, band: 2 });     // 12.5% of 8
    const big = weaknessOf({ correct: 60, seen: 400, medianMs: 3200, band: 2 });   // 15% of 400
    assert.ok(big > tiny, 'the well-evidenced weakness wins');
  });

  test('lower accuracy is weaker, all else equal', () => {
    const good = weaknessOf({ correct: 95, seen: 100, medianMs: 3200, band: 2 });
    const bad = weaknessOf({ correct: 55, seen: 100, medianMs: 3200, band: 2 });
    assert.ok(bad > good);
  });

  test('slowness adds weakness independently of accuracy', () => {
    const fast = weaknessOf({ correct: 90, seen: 100, medianMs: 1000, band: 2 });
    const slow = weaknessOf({ correct: 90, seen: 100, medianMs: 9000, band: 2 });
    assert.ok(slow > fast);
    // Being at or under target contributes nothing.
    const atTarget = weaknessOf({ correct: 90, seen: 100, medianMs: TARGET_MS[2], band: 2 });
    assert.equal(fast.toFixed(4), atTarget.toFixed(4));
  });

  test('slowness is judged against the band, not an absolute', () => {
    // 5000ms is slow for single digits and fine for four-digit work.
    const b1 = weaknessOf({ correct: 90, seen: 100, medianMs: 5000, band: 1 });
    const b4 = weaknessOf({ correct: 90, seen: 100, medianMs: 5000, band: 4 });
    assert.ok(b1 > b4);
  });

  test('slowness is capped so one stalled problem cannot dominate', () => {
    const slow = weaknessOf({ correct: 90, seen: 100, medianMs: 60_000, band: 2 });
    const insane = weaknessOf({ correct: 90, seen: 100, medianMs: 600_000, band: 2 });
    assert.equal(slow, insane, 'slowness saturates at 1');
    assert.ok(slow <= 1);
  });

  test('always in [0,1]', () => {
    assert.ok(weaknessOf({ correct: 0, seen: 400, medianMs: 900_000, band: 1 }) <= 1);
    assert.ok(weaknessOf({ correct: 400, seen: 400, medianMs: 0, band: 4 }) >= 0);
  });
});

describe('eligibility', () => {
  test('buckets under the minimum are never ranked', () => {
    assert.equal(isEligible({ seen: MIN_SEEN - 1 }), false);
    assert.equal(isEligible({ seen: MIN_SEEN }), true);
    assert.equal(isEligible({}), false);
    assert.equal(isEligible(null), false);
  });

  test('the report excludes them entirely', () => {
    const r = buildReport([
      { op: '/', band: 2, seen: 4, correct: 1, medianMs: 8000 },
      { op: '+', band: 1, seen: 60, correct: 57, medianMs: 1500 }
    ]);
    assert.equal(r.buckets.length, 1);
    assert.equal(r.buckets[0].op, '+', 'the four-attempt division bucket is not insight');
  });
});

describe('mastery', () => {
  test('graduates on accuracy and speed together', () => {
    assert.equal(isMastered({ seen: 10, correct: 10, medianMs: 1800 }, 1), true);
    assert.equal(isMastered({ seen: 10, correct: 9, medianMs: 2200 }, 1), true);
  });

  test('accurate but slow does not graduate', () => {
    assert.equal(isMastered({ seen: 10, correct: 10, medianMs: 4000 }, 1), false);
  });

  test('fast but inaccurate does not graduate', () => {
    assert.equal(isMastered({ seen: 10, correct: 8, medianMs: 900 }, 1), false);
  });

  test('needs a full ten attempts', () => {
    assert.equal(isMastered({ seen: 9, correct: 9, medianMs: 900 }, 1), false);
    assert.equal(isMastered(null, 1), false);
  });
});

describe('trend', () => {
  const win = (correct, seen, medianMs) => ({ correct, seen, medianMs });

  test('reports nothing unless both windows have enough data', () => {
    assert.equal(trendOf(win(5, 6, 3000), win(50, 100, 3000), 2), null);
    assert.equal(trendOf(win(50, 100, 3000), win(5, 6, 3000), 2), null);
    assert.equal(trendOf(null, win(50, 100, 3000), 2), null);
  });

  test('detects worsening and improving', () => {
    assert.equal(trendOf(win(30, 100, 6000), win(90, 200, 2500), 2), 'worsening');
    assert.equal(trendOf(win(95, 100, 2200), win(100, 200, 6000), 2), 'improving');
  });

  test('small movement is steady, not a story', () => {
    assert.equal(trendOf(win(88, 100, 3200), win(178, 200, 3250), 2), 'steady');
  });
});

describe('report shaping', () => {
  const buckets = [
    { op: '/', band: 2, seen: 60, correct: 33, medianMs: 5200 },
    { op: '*', band: 2, seen: 40, correct: 31, medianMs: 3600 },
    { op: '+', band: 1, seen: 50, correct: 48, medianMs: 1300 },
    { op: '-', band: 2, seen: 30, correct: 26, medianMs: 3100 }
  ];

  test('ranks weakest first and names the strongest', () => {
    const r = buildReport(buckets);
    assert.equal(r.buckets[0].op, '/', 'division is the weak spot');
    assert.equal(r.strongest.op, '+');
    for (let i = 1; i < r.buckets.length; i++) {
      assert.ok(r.buckets[i - 1].weakness >= r.buckets[i].weakness, 'sorted by weakness');
    }
  });

  test('labels buckets in words, not codes', () => {
    assert.equal(buildReport(buckets).buckets[0].label, 'Division, 10–99');
  });

  test('flags a sample too small to speak from', () => {
    const thin = buildReport([{ op: '+', band: 1, seen: 12, correct: 9, medianMs: 2000 }]);
    assert.equal(thin.sampleTooSmall, true);
    assert.equal(thin.attemptsNeeded, 28);

    const thick = buildReport(buckets);
    assert.equal(thick.sampleTooSmall, false);
    assert.equal(thick.attemptsNeeded, 0);
  });

  test('overall accuracy is computed across every bucket, eligible or not', () => {
    const r = buildReport(buckets);
    assert.equal(r.overall.attemptsAnalysed, 180);
    assert.ok(r.overall.accuracy > 0.7 && r.overall.accuracy < 0.85);
  });

  test('an empty history does not throw', () => {
    const r = buildReport([]);
    assert.deepEqual(r.buckets, []);
    assert.equal(r.strongest, null);
    assert.equal(r.sampleTooSmall, true);
    assert.equal(r.overall.accuracy, null);
  });
});

describe('drill composition', () => {
  const scored = buildReport([
    { op: '/', band: 2, seen: 60, correct: 33, medianMs: 5200 },
    { op: '*', band: 3, seen: 40, correct: 26, medianMs: 4900 },
    { op: '*', band: 2, seen: 40, correct: 31, medianMs: 3600 },
    { op: '-', band: 2, seen: 30, correct: 26, medianMs: 3100 },
    { op: '+', band: 1, seen: 50, correct: 49, medianMs: 1200 }
  ]).buckets;

  test('produces exactly the requested number of problems', () => {
    for (const size of [10, 20, 30]) {
      assert.equal(chooseBuckets(scored, size).length, size);
    }
  });

  test('is dominated by the weakest buckets', () => {
    const picked = chooseBuckets(scored, 20);
    const weakest = bucketKey(scored[0].op, scored[0].band);
    const top3 = new Set(scored.slice(0, 3).map(b => bucketKey(b.op, b.band)));
    const fromTop3 = picked.filter(b => top3.has(bucketKey(b.op, b.band))).length;
    assert.ok(fromTop3 >= 13, `70% should come from the top 3 weakest, got ${fromTop3}/20`);
    assert.ok(picked.filter(b => bucketKey(b.op, b.band) === weakest).length >= 4,
      'the worst bucket gets the largest share');
  });

  /* The acceptance criterion: a user with a deliberately bad division record
     gets a drill that is visibly division-heavy. */
  test('a bad division record yields a division-heavy drill', () => {
    const picked = chooseBuckets(scored, 20);
    const division = picked.filter(b => b.op === '/').length;
    assert.ok(division >= 5, `expected a visibly division-heavy drill, got ${division}/20`);
  });

  test('includes some easy wins so the set is not twenty failures', () => {
    const picked = chooseBuckets(scored, 20);
    const strongest = scored[scored.length - 1];
    const wins = picked.filter(b => bucketKey(b.op, b.band) === bucketKey(strongest.op, strongest.band)).length;
    assert.ok(wins >= 1, 'an all-weakness drill is twenty problems of failing, and people quit');
  });

  test('skips mastered buckets', () => {
    const withMastery = scored.map(b => b.op === '/' ? { ...b, mastered: true } : b);
    const picked = chooseBuckets(withMastery, 20);
    assert.equal(picked.filter(b => b.op === '/').length, 0, 'graduated buckets stop being drilled');
  });

  test('degrades gracefully with one bucket, or none', () => {
    assert.equal(chooseBuckets([scored[0]], 20).length, 20);
    assert.deepEqual(chooseBuckets([], 20), []);
  });
});

describe('interleaving', () => {
  const runOf = list => {
    let worst = 1, cur = 1;
    for (let i = 1; i < list.length; i++) {
      cur = bucketKey(list[i].op, list[i].band) === bucketKey(list[i - 1].op, list[i - 1].band) ? cur + 1 : 1;
      worst = Math.max(worst, cur);
    }
    return worst;
  };

  test('never blocks more than two of the same bucket in a row', () => {
    const items = [
      ...Array(10).fill({ op: '/', band: 2 }),
      ...Array(6).fill({ op: '*', band: 3 }),
      ...Array(4).fill({ op: '+', band: 1 })
    ];
    let rngState = 1;
    const rnd = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
    for (let trial = 0; trial < 40; trial++) {
      const out = interleave(items, rnd);
      assert.equal(out.length, items.length, 'no problems lost');
      assert.ok(runOf(out) <= 2, `run of ${runOf(out)} on trial ${trial}`);
    }
  });

  test('preserves the multiset exactly', () => {
    const items = [
      ...Array(7).fill({ op: '/', band: 2 }),
      ...Array(3).fill({ op: '+', band: 1 })
    ];
    const out = interleave(items, () => 0.5);
    assert.equal(out.filter(b => b.op === '/').length, 7);
    assert.equal(out.filter(b => b.op === '+').length, 3);
  });

  test('a single-bucket drill still returns every problem', () => {
    const items = Array(20).fill({ op: '/', band: 2 });
    const out = interleave(items, () => 0.5);
    assert.equal(out.length, 20, 'accept the run rather than dropping problems the user is owed');
  });
});
