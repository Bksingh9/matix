import { S } from './state.js';
import { OPSYM, mulberry32 } from './util.js';
import { makePattern } from './matrix.js';

/* ============================================================ CATALOGUE */
export const GAMES = {
  blitz:    { name: 'Blitz',    glyph: '⚡', pro: false, desc: 'Solve as many as you can before the clock dies.', input: 'pad',   timer: 'run',     duration: 60 },
  survival: { name: 'Survival', glyph: '♥', pro: false, desc: 'Three lives. Every answer buys you less time.',   input: 'pad',   timer: 'problem', lives: 3 },
  verify:   { name: 'Verify',   glyph: '⚖', pro: false, desc: 'True or false, fast. Trust your instinct.',       input: 'tf',    timer: 'run',     duration: 45 },
  operator: { name: 'Operator', glyph: '⁂', pro: false, desc: 'The numbers are given. Find the missing sign.',   input: 'ops',   timer: 'run',     duration: 60 },
  target:   { name: 'Target',   glyph: '◎', pro: true,  desc: 'Combine numbers to hit the target exactly.',      input: 'chips', timer: 'run',     duration: 90 },
  recall:   { name: 'Recall',   glyph: '◈', pro: true,  desc: 'A number flashes. Type it back from memory.',     input: 'pad',   timer: 'problem', lives: 3 },
  matrix:   { name: 'Matrix',   glyph: '⬛', pro: false, desc: 'A pattern flashes on the grid. Tap it back.',    input: 'grid',  timer: 'problem', lives: 3 },
  // Same board, three pressures. Rush trades lives for a clock; Zen removes
  // both, which is what makes it the mode to learn the game in.
  mrush:    { name: 'Matrix Rush', glyph: '⧗', pro: false, desc: 'Sixty seconds. As many grids as you can hold.', input: 'grid', timer: 'run', duration: 60 },
  mzen:     { name: 'Matrix Zen',  glyph: '◍', pro: false, desc: 'The grid, with no clock and nothing to lose.',  input: 'grid', timer: 'none' },
  zen:      { name: 'Zen',      glyph: '∞', pro: false, desc: 'No clock, no lives. Just repetitions.',           input: 'pad',   timer: 'none' },
  // Practice, not a test: no clock, no lives lost. The set comes from the
  // server pre-generated, and the band sets the difficulty — the difficulty
  // selector is deliberately ignored.
  drill:    { name: 'Drill',    glyph: '◇', pro: true,  desc: 'Twenty problems aimed at your weakest buckets.',  input: 'pad',   timer: 'problem', lives: 99 },
  daily:    { name: 'Daily',    glyph: '★', pro: false, desc: "Today's twelve.", input: 'pad', timer: 'none', hidden: true, total: 12 }
};

/* ============================================================ RNG
   Swapped to a seeded generator for the daily challenge so every player
   worldwide gets the same twelve problems. */
let RND = Math.random;
export const rnd = () => RND();
export const useSystemRandom = () => { RND = Math.random; };
export function seedFromDate(dateStr) {
  let seed = 0;
  for (let i = 0; i < dateStr.length; i++) seed = (seed * 31 + dateStr.charCodeAt(i)) | 0;
  RND = mulberry32(seed);
}

export const ri = (a, b) => Math.floor(RND() * (b - a + 1)) + a;
export const pick = a => a[Math.floor(RND() * a.length)];

/* ============================================================ GENERATORS */

/* Memory Matrix. The rules live in matrix.js, which is pure and unit-tested;
   this only decides which level the player is on and hands over the RNG — so
   the daily challenge gets a reproducible board with no extra work. */
/* Every variant deals the same board; only the pressure around it differs. */
export const isMatrix = g => g === 'matrix' || g === 'mrush' || g === 'mzen';

function genMatrix() {
  /* Level normally tracks clears, so the grid grows as the player proves they
     can hold more.

     In the daily it must track POSITION instead. Two players reach problem 8
     having got a different number right, so levelling by clears would hand
     them different grid sizes and different patterns — and the shared board,
     which is the entire point of a daily, would be a lie. The adaptive ease is
     dropped there for the same reason: it is per-player by definition. */
  const level = S.isDaily ? Math.floor(S.solved / 3) + 2 : S.correct + 1;
  const p = makePattern(level, rnd, {
    consecutiveFails: S.isDaily ? 0 : (S.matrixFails || 0)
  });
  return {
    kind: 'grid',
    // No arithmetic happened. Sending an operation would inflate a bucket and
    // quietly corrupt the weak-spot report, which is the thing Pro sells.
    op: null, a: null, b: null, answer: null,
    pattern: p,
    showMs: p.revealMs,
    sub: 'Memorise',
    small: true,
    html: p.size + ' × ' + p.size + ' <span class="op">·</span> ' + p.count + ' tiles'
  };
}
export function bands(d) {
  return ({
    easy:   { add: [1, 20],    sub: [5, 30],     mA: [2, 9],   mB: [2, 9],   dB: [2, 9],   dQ: [2, 9] },
    medium: { add: [10, 99],   sub: [20, 140],   mA: [2, 12],  mB: [2, 12],  dB: [2, 12],  dQ: [2, 12] },
    hard:   { add: [25, 300],  sub: [60, 600],   mA: [11, 29], mB: [3, 19],  dB: [3, 19],  dQ: [3, 19] },
    expert: { add: [120, 999], sub: [200, 1500], mA: [13, 49], mB: [7, 29],  dB: [7, 29],  dQ: [7, 29] }
  })[d] || { add: [10, 99], sub: [20, 140], mA: [2, 12], mB: [2, 12], dB: [2, 12], dQ: [2, 12] };
}

export function diff() {
  /* Matrix has no arithmetic, so the difficulty selector is meaningless to it
     — but points() keys off diff(), which made Expert worth ~3.8x Easy on a
     free mode whose scores go to a public leaderboard. Pinned, so the board
     ranks recall rather than which setting someone picked. */
  if (S.game === 'matrix') return 'medium';
  if (S.isDaily) return 'medium';
  if (S.game === 'survival' || S.game === 'recall') {
    const l = Math.floor(S.correct / 3) + 1;
    return l <= 2 ? 'easy' : l <= 4 ? 'medium' : (S.pro && l >= 7 ? 'expert' : 'hard');
  }
  return S.difficulty;
}

export function arith(d) {
  const b = bands(d);
  const ops = S.isDaily ? ['+', '-', '*', '/'] : (S.ops.length ? S.ops : ['+', '-', '*', '/']);
  const op = pick(ops);
  let a, x, ans;
  if (op === '+') { a = ri(b.add[0], b.add[1]); x = ri(b.add[0], b.add[1]); ans = a + x; }
  else if (op === '-') { a = ri(b.sub[0], b.sub[1]); x = ri(1, a); ans = a - x; }
  else if (op === '*') { a = ri(b.mA[0], b.mA[1]); x = ri(b.mB[0], b.mB[1]); ans = a * x; }
  else { x = ri(b.dB[0], b.dB[1]); const q = ri(b.dQ[0], b.dQ[1]); a = x * q; ans = q; }
  return { a, b: x, op, ans };
}

export function genPad() {
  const p = arith(diff());
  return { kind: 'pad', op: p.op, a: p.a, b: p.b, answer: p.ans, html: p.a + '<span class="op">' + OPSYM[p.op] + '</span>' + p.b, sub: '' };
}

export function genVerify() {
  const p = arith(diff()), tru = RND() < .5;
  let shown = p.ans;
  if (!tru) {
    const d = pick([1, 2, 3, 5, 9, 10]);
    shown = p.ans + (RND() < .5 ? -d : d);
    if (shown === p.ans || shown < 0) shown = p.ans + d;
  }
  return {
    kind: 'tf', op: p.op, a: p.a, b: p.b, answer: tru ? 1 : 0, realAnswer: p.ans, small: true, sub: 'True or false',
    html: p.a + '<span class="op">' + OPSYM[p.op] + '</span>' + p.b + '<span class="op">=</span>' + shown
  };
}

export function genOperator() {
  const p = arith(diff());
  return {
    kind: 'ops', op: p.op, a: p.a, b: p.b, answer: p.op, realAnswer: p.ans, small: true, sub: 'Find the sign',
    html: p.a + '<span class="op">?</span>' + p.b + '<span class="op">=</span>' + p.ans
  };
}

export function genTarget() {
  const d = diff();
  const n = (d === 'easy') ? 2 : (d === 'medium') ? 2 : 3;
  const hi = (d === 'easy') ? 15 : (d === 'medium') ? 30 : 60;
  const need = [];
  for (let i = 0; i < n; i++) need.push(ri(2, hi));
  const target = need.reduce((a, b) => a + b, 0);
  const pool = need.slice();
  while (pool.length < 6) pool.push(ri(2, hi));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(RND() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return { kind: 'chips', op: '+', answer: target, pool, sub: 'Pick numbers that total this', html: String(target) };
}

export function genRecall() {
  const len = Math.min(9, 3 + Math.floor(S.correct / 3));
  let s = String(ri(1, 9));
  for (let i = 1; i < len; i++) s += String(ri(0, 9));
  return { kind: 'recall', op: null, answer: parseInt(s, 10), digits: s, showMs: Math.max(700, 1500 - 60 * S.correct), sub: 'Memorise', html: s };
}

/* A drill problem comes from the server pre-generated, so pre/post
   comparison is honest. The client only renders it. */
const BAND_NOTE = { 1: '0–9', 2: '10–99', 3: '100–999', 4: '1000+' };

export function fromDrill(p) {
  return {
    kind: 'pad', op: p.op, a: p.a, b: p.b, answer: p.answer, band: p.band, difficulty: p.difficulty,
    html: p.a + '<span class="op">' + OPSYM[p.op] + '</span>' + p.b,
    // Says which bucket this problem is targeting, so the numbers ignoring the
    // difficulty selector reads as intent rather than a bug.
    sub: 'Targeting ' + (BAND_NOTE[p.band] || '')
  };
}

export function generate() {
  /* The daily mixes formats so twelve problems do not read as one drill, and
     every draw comes from the seeded RNG — so the mix, the numbers AND the
     grid patterns are identical for every player worldwide. That is the whole
     premise of a shared board.

     Matrix is in the mix at ~1 in 6: enough that a memory round shows up in
     most dailies, rare enough that it stays a change of pace rather than a
     different game. */
  if (S.isDaily) {
    const r = RND();
    if (r < .50) return genPad();
    if (r < .72) return genVerify();
    if (r < .84) return genOperator();
    return genMatrix();
  }
  if (S.game === 'verify') return genVerify();
  if (S.game === 'operator') return genOperator();
  if (S.game === 'target') return genTarget();
  if (isMatrix(S.game)) return genMatrix();
  if (S.game === 'recall') return genRecall();
  return genPad();
}
