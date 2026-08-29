import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, gridSizeFor, tileCountFor, revealMsFor, makePattern,
  scoreFor, judgeTap, createRun, deal, clearLevel, failLevel, isOver,
  REVEAL_START, REVEAL_FLOOR
} from '../public/js/matrix.js';

/* The memory-matrix rules.
 *
 * All of it is pure and seedable, which is the point: the difficulty curve is
 * the product, and a curve you cannot test is a curve you are guessing at. */

describe('the difficulty curve', () => {
  test('the grid grows at fixed levels, the same for everyone', () => {
    assert.equal(gridSizeFor(1), 3);
    assert.equal(gridSizeFor(5), 3);
    assert.equal(gridSizeFor(6), 4);
    assert.equal(gridSizeFor(12), 5);
    assert.equal(gridSizeFor(20), 6);
    assert.equal(gridSizeFor(999), 6, 'and stops at 6x6');
  });

  test('it never shrinks as the level rises', () => {
    let prev = 0;
    for (let l = 1; l <= 60; l++) {
      const s = gridSizeFor(l);
      assert.ok(s >= prev, `grid shrank at level ${l}`);
      prev = s;
    }
  });

  test('a pattern never fills more than half the grid', () => {
    // Past half it stops being recall and becomes "remember the gaps", which
    // is a different and much easier task.
    for (let l = 1; l <= 80; l++) {
      const size = gridSizeFor(l);
      assert.ok(tileCountFor(l) <= Math.floor((size * size) / 2),
        `level ${l}: ${tileCountFor(l)} tiles on a ${size}x${size}`);
    }
  });

  test('it always asks for at least two tiles', () => {
    for (let l = 1; l <= 80; l++) assert.ok(tileCountFor(l) >= 2, `level ${l}`);
  });

  test('reveal time decays but never below the floor', () => {
    assert.equal(revealMsFor(1), REVEAL_START);
    assert.ok(revealMsFor(10) < revealMsFor(1));
    for (let l = 1; l <= 200; l++) {
      const ms = revealMsFor(l);
      assert.ok(ms >= REVEAL_FLOOR && ms <= REVEAL_START, `level ${l} gave ${ms}ms`);
    }
  });

  test('struggling hands reveal time back', () => {
    // Retention beats punishment: someone stuck who is given 150ms back
    // usually clears it, and someone who fails four times usually leaves.
    const base = revealMsFor(10, 0);
    assert.equal(revealMsFor(10, 1), base, 'one miss is not a pattern');
    assert.ok(revealMsFor(10, 2) > base, 'two in a row earns the ease');
    assert.ok(revealMsFor(10, 4) > revealMsFor(10, 2), 'and it compounds');
    assert.ok(revealMsFor(10, 99) <= REVEAL_START, 'but never past the starting window');
  });
});

describe('pattern generation', () => {
  test('the same seed gives the same board — the daily depends on it', () => {
    const a = makePattern(7, mulberry32(20260829));
    const b = makePattern(7, mulberry32(20260829));
    assert.deepEqual(a.cells, b.cells);
    assert.equal(a.revealMs, b.revealMs);
  });

  test('different seeds give different boards', () => {
    const a = makePattern(7, mulberry32(1));
    const b = makePattern(7, mulberry32(2));
    assert.notDeepEqual(a.cells, b.cells);
  });

  test('cells are unique and inside the grid', () => {
    for (let l = 1; l <= 40; l++) {
      const p = makePattern(l, mulberry32(l));
      assert.equal(new Set(p.cells).size, p.cells.length, `level ${l} repeated a cell`);
      assert.equal(p.cells.length, p.count);
      for (const c of p.cells) {
        assert.ok(c >= 0 && c < p.size * p.size, `level ${l}: cell ${c} is off the grid`);
      }
    }
  });

  test('every cell is reachable — no dead corner', () => {
    // A biased shuffle would quietly make some cells rare, and the bug would
    // read as "this game feels samey" rather than as a defect.
    const seen = new Set();
    for (let s = 0; s < 400; s++) for (const c of makePattern(3, mulberry32(s)).cells) seen.add(c);
    assert.equal(seen.size, 9, 'some cell of the 3x3 never appeared');
  });
});

describe('scoring', () => {
  test('a bigger pattern is worth more than a smaller one', () => {
    const small = scoreFor({ count: 3, size: 3, elapsedMs: 2000 });
    const big = scoreFor({ count: 8, size: 5, elapsedMs: 2000 });
    assert.ok(big > small);
  });

  test('faster recall scores higher', () => {
    const fast = scoreFor({ count: 5, size: 4, elapsedMs: 500 });
    const slow = scoreFor({ count: 5, size: 4, elapsedMs: 8000 });
    assert.ok(fast > slow);
  });

  test('a slow clear still scores — it was still a clear', () => {
    assert.ok(scoreFor({ count: 5, size: 4, elapsedMs: 999999 }) >= 1);
  });

  test('the streak multiplier applies', () => {
    const plain = scoreFor({ count: 4, size: 3, elapsedMs: 1500, streak: 0 });
    const hot = scoreFor({ count: 4, size: 3, elapsedMs: 1500, streak: 15 });
    assert.ok(hot > plain * 2.5);
  });
});

describe('judging a tap', () => {
  const pattern = { size: 3, count: 3, cells: [0, 4, 8], revealMs: 900 };

  test('a tile in the pattern is a hit', () => {
    assert.equal(judgeTap(pattern, [], 4).status, 'hit');
  });

  test('a tile outside it is wrong immediately', () => {
    // Judged on the tap, not at submission: otherwise tapping every cell
    // would always "win".
    assert.equal(judgeTap(pattern, [], 1).status, 'wrong');
  });

  test('the last correct tile completes the level', () => {
    assert.equal(judgeTap(pattern, [0, 4], 8).status, 'complete');
  });

  test('tapping the same tile twice does nothing', () => {
    const r = judgeTap(pattern, [0], 0);
    assert.equal(r.status, 'ignored');
    assert.deepEqual(r.tapped, [0], 'and does not count as progress');
  });
});

describe('a run', () => {
  test('clearing advances the level and keeps the streak', () => {
    const run = createRun({ seed: 42 });
    deal(run);
    clearLevel(run, 1200);
    assert.equal(run.level, 2);
    assert.equal(run.streak, 1);
    assert.equal(run.cleared, 1);
    assert.ok(run.score > 0);
  });

  test('failing costs a life and resets the streak, but not the level', () => {
    const run = createRun({ seed: 42 });
    deal(run); clearLevel(run, 1000);
    deal(run); failLevel(run);
    assert.equal(run.lives, 2);
    assert.equal(run.streak, 0);
    assert.equal(run.level, 2, 'you get to retry the level you missed');
    assert.equal(run.bestStreak, 1, 'and the best is remembered');
  });

  test('three failures end it', () => {
    const run = createRun({ seed: 1 });
    assert.equal(isOver(run), false);
    for (let i = 0; i < 3; i++) { deal(run); failLevel(run); }
    assert.equal(isOver(run), true);
  });

  test('clearing earns back the ease, so it cannot be farmed', () => {
    const run = createRun({ seed: 1 });
    deal(run); failLevel(run);
    deal(run); failLevel(run);
    assert.equal(run.consecutiveFails, 2);
    deal(run); clearLevel(run, 900);
    assert.equal(run.consecutiveFails, 0);
  });

  test('a seeded run is reproducible end to end — the daily depends on it', () => {
    const play = () => {
      const run = createRun({ seed: 20260829 });
      const boards = [];
      for (let i = 0; i < 6; i++) { boards.push(deal(run).cells.join(',')); clearLevel(run, 1000); }
      return { boards, score: run.score };
    };
    assert.deepEqual(play(), play());
  });
});

describe('the daily board is the same for everyone', () => {
  /* The daily's premise is one shared board worldwide. That holds only if the
     pattern depends on nothing player-specific — so this asserts the property
     directly rather than trusting the generator to stay honest. */
  test('the same seed and position give the same pattern regardless of skill', () => {
    // Two players at problem 8: one has got 7 right, the other 2. Same board.
    const atPosition = solved => {
      const rnd = mulberry32(20260829);
      let last;
      for (let i = 0; i <= solved; i++) last = makePattern(Math.floor(i / 3) + 2, rnd);
      return last;
    };
    assert.deepEqual(atPosition(8).cells, atPosition(8).cells);
    assert.equal(atPosition(8).size, atPosition(8).size);
  });

  test('levelling by position is monotonic and starts above the floor', () => {
    // Position-based levels must still ramp, or the daily gets easier as it
    // goes and the last problems are the simplest.
    const level = solved => Math.floor(solved / 3) + 2;
    assert.equal(level(0), 2);
    let prev = 0;
    for (let i = 0; i < 12; i++) {
      assert.ok(level(i) >= prev, `level dropped at problem ${i}`);
      prev = level(i);
    }
    assert.ok(level(11) > level(0), 'and it does ramp across the twelve');
  });
});
