import { TARGET_MS, bucketLabel } from './weakness.js';

/* Generates the actual problems for a drill.
 *
 * Difficulty inside a bucket follows the band, not the user's global
 * difficulty setting — a drill that respected the selector would be drilling
 * the wrong numbers. The UI says so, so it doesn't read as a bug.
 */

/* A generated problem must land in the band it was generated for, or the drill
   is targeting one bucket and logging another — and the before/after
   comparison silently compares different things.
 *
 * bandOf() keys off max(|a|,|b|), and off the dividend for division. So the
 * invariant is: the LARGER operand sits inside the band's range (the dividend,
 * for division). Ranges that merely "feel" like the band are not enough:
 * 23 x 7 reads as a three-digit problem and is banded as a two-digit one. */
const BAND_RANGE = { 1: [2, 9], 2: [10, 99], 3: [100, 999], 4: [1000, 9999] };

/* The companion operand. Kept small so the problem stays mental arithmetic
   rather than long multiplication. */
const SMALL = { 1: [2, 9], 2: [2, 9], 3: [2, 12], 4: [2, 12] };

const DIFFICULTY_FOR_BAND = { 1: 'easy', 2: 'medium', 3: 'hard', 4: 'expert' };

export function problemFor(op, band, rnd = Math.random) {
  const [lo, hi] = BAND_RANGE[band] || BAND_RANGE[2];
  const [slo, shi] = SMALL[band] || SMALL[2];
  const ri = (l, h) => l + Math.floor(rnd() * (h - l + 1));
  let a, b, answer;

  if (op === '+') {
    a = ri(lo, hi); b = ri(lo, hi); answer = a + b;
  } else if (op === '-') {
    a = ri(Math.max(lo, 2), hi);
    b = ri(1, a - 1);                       // never negative, never a no-op
    answer = a - b;
  } else if (op === '*') {
    const big = ri(lo, hi);
    const small = ri(slo, shi);
    // Present it either way round; max(a,b) is still `big` for band >= 2, and
    // for band 1 both operands are single digits anyway.
    if (rnd() < 0.5) { a = big; b = small; } else { a = small; b = big; }
    answer = a * b;
  } else {
    // Build division from its answer so it always divides exactly, and choose
    // a divisor that can produce a dividend inside the band. Picking the
    // dividend first and hoping it factors is how you get 997 / 7.
    const options = [];
    for (let d = slo; d <= shi; d++) {
      const qmin = Math.max(2, Math.ceil(lo / d));
      const qmax = Math.floor(hi / d);
      if (qmax >= qmin) options.push([d, qmin, qmax]);
    }
    if (options.length) {
      const [d, qmin, qmax] = options[Math.floor(rnd() * options.length)];
      b = d;
      answer = ri(qmin, qmax);
      a = b * answer;
    } else {
      // Only reachable if a band is too narrow to hold a quotient of 2.
      b = 2; answer = Math.max(1, Math.floor(hi / 2)); a = b * answer;
    }
  }

  return { op, a, b, answer, band, difficulty: DIFFICULTY_FOR_BAND[band] || 'medium' };
}

/* Turn an ordered list of buckets into concrete problems, avoiding an exact
   repeat of the same question inside one drill — twenty problems that include
   7x8 three times feels like a bug, not practice. */
export function generateProblems(bucketOrder, rnd = Math.random) {
  const seen = new Set();
  return bucketOrder.map(b => {
    let p = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      p = problemFor(b.op, b.band, rnd);
      const key = `${p.op}:${p.a}:${p.b}`;
      if (!seen.has(key)) { seen.add(key); return p; }
    }
    return p;   // small bands run out of distinct problems; a repeat beats a gap
  });
}

/* The pre-drill snapshot, stored alongside the problems so the after-screen
   compares like with like. Without it, "you improved" would be measured
   against numbers that had already moved. */
export function snapshotTargets(scored, bucketOrder) {
  const counts = new Map();
  for (const b of bucketOrder) {
    const k = `${b.op}:${b.band}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].map(([k, count]) => {
    const [op, bandStr] = k.split(':');
    const band = Number(bandStr);
    const s = scored.find(x => x.op === op && x.band === band) || {};
    return {
      op, band, count,
      label: bucketLabel(op, band),
      weakness: s.weakness ?? null,
      accuracy: s.accuracy ?? null,
      medianMs: s.medianMs ?? null,
      targetMs: TARGET_MS[band] || TARGET_MS[2],
      seen: s.seen ?? 0
    };
  }).sort((x, y) => (y.weakness ?? 0) - (x.weakness ?? 0));
}
