/* ============================================================ MEMORY MATRIX
   A grid flashes a pattern; you reproduce it from memory.

   Pure logic, deliberately: no DOM, no network, no imports. That is what lets
   the whole difficulty curve be unit-tested deterministically, and what lets
   the same module drive the web build and both native shells.

   The state machine is reveal -> recall -> resolve. This module owns pattern
   generation and difficulty; the caller owns timing and rendering. */

/* Same generator the daily challenge uses, inlined rather than imported so
   this module keeps its no-dependency property. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Grid grows as the player proves they can hold more. The thresholds are
   levels, not scores, so the ramp is the same for everyone. */
export const GRID_STEPS = [
  { fromLevel: 1,  size: 3 },
  { fromLevel: 6,  size: 4 },
  { fromLevel: 12, size: 5 },
  { fromLevel: 20, size: 6 }
];

export const REVEAL_START = 900;
export const REVEAL_FLOOR = 400;
export const REVEAL_DECAY = 25;    // ms shaved per level
export const EASE_STEP = 150;      // ms handed back after repeated failure
export const EASE_AFTER_FAILS = 2;

export function gridSizeFor(level) {
  let size = GRID_STEPS[0].size;
  for (const step of GRID_STEPS) if (level >= step.fromLevel) size = step.size;
  return size;
}

/* tiles = floor(2 + n*0.7), capped so a pattern can never fill more than half
   the grid — past that it stops being recall and becomes "remember the gaps",
   which is a different and much easier task. */
export function tileCountFor(level, size = gridSizeFor(level)) {
  const raw = Math.floor(2 + level * 0.7);
  const cap = Math.max(3, Math.floor((size * size) / 2));
  return Math.min(raw, cap);
}

/* Reveal time decays with level and is handed back when the player is
   struggling. Retention beats punishment: someone stuck at level 9 who is
   given 150ms back usually clears it and keeps playing, and someone who fails
   four times in a row usually closes the app. */
export function revealMsFor(level, consecutiveFails = 0) {
  const decayed = REVEAL_START - (level - 1) * REVEAL_DECAY;
  const eased = Math.floor(consecutiveFails / EASE_AFTER_FAILS) * EASE_STEP;
  return Math.max(REVEAL_FLOOR, Math.min(REVEAL_START, decayed + eased));
}

/* Fisher-Yates over the cell indices, so every pattern is equally likely and
   no cell can be picked twice. Sampling with rejection would bias toward
   whatever the RNG happens to favour when the grid is nearly full. */
export function makePattern(level, rnd = Math.random, opts = {}) {
  const size = opts.size ?? gridSizeFor(level);
  const count = opts.count ?? tileCountFor(level, size);
  const cells = Array.from({ length: size * size }, (_, i) => i);

  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  return {
    size,
    count,
    // Sorted so two patterns with the same cells compare equal, which makes
    // the daily challenge verifiable and the tests readable.
    cells: cells.slice(0, count).sort((a, b) => a - b),
    revealMs: opts.revealMs ?? revealMsFor(level, opts.consecutiveFails || 0)
  };
}

/* How long to allow for tapping the pattern back.
 *
 * The arithmetic modes budget one shrinking window per problem, because there
 * you type one number. Here you tap `count` tiles from memory, and a fixed
 * budget becomes impossible the moment the grid grows: 16 tiles in 5.5s is
 * nearly 3 taps a second *while recalling*, so the clock would end every run
 * and the curve above would never get to matter.
 *
 * Scales with the work: a base to orient on the grid, plus per-tile time that
 * tightens as the player gets better. */
export function recallSecondsFor(count, level = 1) {
  const perTile = Math.max(0.55, 0.95 - level * 0.012);
  return Math.round((1.8 + count * perTile) * 10) / 10;
}

/* Score rewards the size of what you held in memory and how fast you put it
   back, then multiplies by the streak. Deliberately not time-only: a 6x6
   pattern recalled slowly is a harder thing than a 3x3 recalled fast. */
export function scoreFor({ count, size, elapsedMs, streak = 0 }) {
  const base = count * 10 + (size - 3) * 15;
  const par = count * 700;
  const speed = Math.max(0, Math.min(1, (par - elapsedMs) / par));
  const mult = streak >= 15 ? 3 : streak >= 10 ? 2.5 : streak >= 6 ? 2 : streak >= 3 ? 1.5 : 1;
  return Math.max(1, Math.round((base + Math.round(base * 0.8 * speed)) * mult));
}

/* A tap is judged the moment it lands: tapping a cell outside the pattern is
   wrong immediately rather than at the end. Waiting until submission would
   let a player tap every cell and always "win". */
export function judgeTap(pattern, tapped, cell) {
  if (tapped.includes(cell)) return { status: 'ignored', tapped };
  const next = [...tapped, cell];
  if (!pattern.cells.includes(cell)) return { status: 'wrong', tapped: next, cell };
  const done = pattern.cells.every(c => next.includes(c));
  return { status: done ? 'complete' : 'hit', tapped: next, cell };
}

/* One run of Classic. Holds only what the rules need; rendering and timing
   live in the caller. */
export function createRun({ seed = null, lives = 3, startLevel = 1 } = {}) {
  const rnd = seed === null ? Math.random : mulberry32(seed);
  return {
    rnd,
    level: startLevel,
    lives,
    score: 0,
    streak: 0,
    bestStreak: 0,
    cleared: 0,
    consecutiveFails: 0,
    pattern: null,
    tapped: []
  };
}

export function deal(run) {
  run.pattern = makePattern(run.level, run.rnd, { consecutiveFails: run.consecutiveFails });
  run.tapped = [];
  return run.pattern;
}

export function clearLevel(run, elapsedMs) {
  run.score += scoreFor({
    count: run.pattern.count, size: run.pattern.size, elapsedMs, streak: run.streak
  });
  run.streak += 1;
  if (run.streak > run.bestStreak) run.bestStreak = run.streak;
  run.cleared += 1;
  run.level += 1;
  run.consecutiveFails = 0;   // the ease is earned back by clearing, not by time
  return run;
}

export function failLevel(run) {
  run.lives -= 1;
  run.streak = 0;
  run.consecutiveFails += 1;
  return run;
}

export const isOver = run => run.lives <= 0;
