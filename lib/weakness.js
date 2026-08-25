/* Bucketing, the Wilson lower bound, and the weakness score.
 *
 * This is the feature people pay for, so it is a pure module with no I/O:
 * every rule below is directly unit-testable, and the drill generator and the
 * report read from the same functions.
 */

export const OPS = ['+', '-', '*', '/'];

/* ============================================================ BANDS
   A bucket is (op, band). 4 ops x 4 bands = 16 buckets max.

   Computed server-side from the operands, never taken from the client: a
   client bug would silently poison the exact dataset the whole Pro feature
   rests on. */
export function bandOf(op, a, b) {
  const A = Math.abs(Number(a) || 0);
  const B = Math.abs(Number(b) || 0);
  // Division bands off the dividend: 84 ÷ 12 is a two-digit problem, and
  // banding on the divisor would call it a single-digit one.
  const m = op === '/' ? A : Math.max(A, B);
  if (m < 10) return 1;
  if (m < 100) return 2;
  if (m < 1000) return 3;
  return 4;
}

export const TARGET_MS = { 1: 2200, 2: 3200, 3: 4800, 4: 6500 };

const BAND_LABEL = { 1: '0–9', 2: '10–99', 3: '100–999', 4: '1000+' };
const OP_LABEL = { '+': 'Addition', '-': 'Subtraction', '*': 'Multiplication', '/': 'Division' };

export const bucketLabel = (op, band) => `${OP_LABEL[op] || op}, ${BAND_LABEL[band] || band}`;
export const bucketKey = (op, band) => `${op}:${band}`;

/* ============================================================ WILSON
   Wilson score interval, lower bound, 95% (z = 1.96).

   Raw accuracy over a small sample is not a fact, it is a rumour. Three misses
   out of four is not "25% accurate"; it is weak evidence of a problem. Without
   this smoothing the drill engine chases noise and the report contradicts
   itself between sessions, which reads to a paying user as a broken product. */
export function wilsonLower(correct, seen, z = 1.96) {
  if (!seen || seen <= 0) return 0;
  const n = seen;
  const p = Math.max(0, Math.min(1, correct / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / denom));
}

export const clamp01 = n => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/* ============================================================ WEAKNESS
   weakness = 0.65 * miss_lower + 0.35 * slowness

   DEVIATION FROM SPEC §7, deliberate — the spec's formula contradicts its own
   stated goal and its own named unit test.

   §7 says: acc_lower = Wilson lower bound of accuracy;
            weakness  = 0.65 * (1 - acc_lower) + 0.35 * slowness

   Applied to a 3/4 bucket and a 300/400 bucket — both 75% accurate — that
   gives 0.455 and 0.192. The four-attempt bucket ranks 2.4x weaker than the
   four-hundred-attempt one, because a lower bound on accuracy is *most*
   pessimistic when the sample is smallest. That is precisely the noise-chasing
   §7 says the Wilson bound exists to prevent, and it fails the unit test §8
   names ("a 3/4 bucket must not outrank a 300/400 bucket").

   The fix keeps the intent and the machinery: apply the Wilson lower bound to
   the MISS rate rather than the accuracy. Now the score answers "how confident
   are we that this bucket is genuinely bad", which is the question a drill
   ranking needs, and a weakness has to be evidenced before it is acted on.
   Same two buckets: 0.030 and 0.137 — the well-evidenced weakness wins.

   (Identically: miss_lower = 1 - wilsonUpper(accuracy). The Wilson interval is
   symmetric under p -> 1-p with the bounds swapped, so this is the same
   function, not a second one.) */
export const MIN_SEEN = 8;

export function weaknessOf({ correct, seen, medianMs, band }) {
  const n = Number(seen) || 0;
  const wrong = Math.max(0, n - (Number(correct) || 0));
  const missLower = wilsonLower(wrong, n);
  const target = TARGET_MS[band] || TARGET_MS[2];
  const slowness = clamp01(((Number(medianMs) || 0) - target) / target);
  return clamp01(0.65 * missLower + 0.35 * slowness);
}

/* A bucket with too few attempts is `insufficient_data`: never ranked, never
   drilled as a weakness, never shown as insight. "You're weak at division"
   from four attempts is a coin flip presented as a finding. */
export const isEligible = b => (b?.seen ?? 0) >= MIN_SEEN;

/* ============================================================ MASTERY
   A bucket graduates when its last 10 attempts are >=90% correct AND its
   median time is at or under target. Graduated buckets drop out of drill
   targeting but stay in the report with a marker — visible graduation is what
   makes a yearly plan feel worth renewing. */
export function isMastered(recent10, band) {
  if (!recent10 || (recent10.seen ?? 0) < 10) return false;
  const acc = recent10.correct / recent10.seen;
  const target = TARGET_MS[band] || TARGET_MS[2];
  return acc >= 0.9 && (Number(recent10.medianMs) || Infinity) <= target;
}

/* ============================================================ TREND
   The most recent 100 attempts against the prior 200. Only reported when both
   windows have at least MIN_SEEN in that bucket — a trend computed from one
   window is just the level again, dressed up. */
export function trendOf(recentWindow, priorWindow, band) {
  if (!isEligible(recentWindow) || !isEligible(priorWindow)) return null;
  const delta = weaknessOf({ ...recentWindow, band }) - weaknessOf({ ...priorWindow, band });
  if (delta > 0.08) return 'worsening';
  if (delta < -0.08) return 'improving';
  return 'steady';
}

/* ============================================================ REPORT
   buckets: [{ op, band, seen, correct, medianMs, recent?, prior?, recent10? }] */
export function buildReport(buckets, { minAttempts = 40 } = {}) {
  const total = buckets.reduce((s, b) => s + (b.seen || 0), 0);
  const eligible = buckets.filter(isEligible);

  const scored = eligible.map(b => {
    const weakness = weaknessOf(b);
    return {
      op: b.op,
      band: b.band,
      label: bucketLabel(b.op, b.band),
      seen: b.seen,
      accuracy: round3(b.correct / b.seen),
      medianMs: Math.round(Number(b.medianMs) || 0),
      targetMs: TARGET_MS[b.band] || TARGET_MS[2],
      weakness: round3(weakness),
      trend: trendOf(b.recent, b.prior, b.band),
      mastered: isMastered(b.recent10, b.band)
    };
  }).sort((x, y) => y.weakness - x.weakness);

  const strongest = scored.length
    ? [...scored].sort((x, y) => x.weakness - y.weakness)[0]
    : null;

  const overall = {
    accuracy: total ? round3(buckets.reduce((s, b) => s + (b.correct || 0), 0) / total) : null,
    medianMs: medianOfBuckets(buckets),
    attemptsAnalysed: total
  };

  return {
    buckets: scored,
    strongest: strongest ? { op: strongest.op, band: strongest.band, label: strongest.label, accuracy: strongest.accuracy } : null,
    overall,
    // Confident numbers from twelve data points is how you lose a paying
    // user's trust. Say "not yet" instead.
    sampleTooSmall: total < minAttempts,
    attemptsNeeded: Math.max(0, minAttempts - total)
  };
}

/* ============================================================ DRILL PICK
   70% from the top 3 weakest eligible buckets, weighted by weakness;
   20% from mid-ranked; 10% from the strongest.

   The 10% strong is deliberate. An all-weakness drill is twenty problems of
   failing, and people quit. Wins keep them in the set. */
export function chooseBuckets(scored, size = 20) {
  const pool = scored.filter(b => !b.mastered);
  if (!pool.length) return [];

  const nWeak = Math.round(size * 0.7);
  const nMid = Math.round(size * 0.2);
  const nStrong = Math.max(0, size - nWeak - nMid);

  const weak = pool.slice(0, Math.min(3, pool.length));
  const strong = pool[pool.length - 1];
  const midPool = pool.slice(weak.length, Math.max(weak.length, pool.length - 1));
  const mid = midPool.length ? midPool : weak;

  const out = [];
  // Weighted by weakness, so the worst bucket gets the most repetitions
  // rather than all three splitting the budget evenly.
  const totalW = weak.reduce((s, b) => s + Math.max(0.01, b.weakness), 0);
  let assigned = 0;
  weak.forEach((b, i) => {
    const share = i === weak.length - 1
      ? nWeak - assigned
      : Math.round(nWeak * (Math.max(0.01, b.weakness) / totalW));
    assigned += share;
    for (let k = 0; k < share; k++) out.push(b);
  });

  for (let i = 0; i < nMid; i++) out.push(mid[i % mid.length]);
  for (let i = 0; i < nStrong; i++) out.push(strong);

  return out.slice(0, size);
}

/* Interleave, don't block: the same bucket never appears more than twice in a
   row. Blocked practice *feels* easier, which makes people rate it higher
   while learning less. Interleave anyway. */
export function interleave(items, rnd = Math.random) {
  const groups = new Map();
  for (const it of items) {
    const k = bucketKey(it.op, it.band);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  // Shuffle within each bucket so the order isn't an artefact of the weighting.
  for (const arr of groups.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  /* Always spend from the largest remaining bucket that isn't blocked.
     A reactive "pick anything that differs" greedy looks fine early and then
     strands the big bucket at the end — with 10 division and 10 others it can
     happily emit all ten others first, then ten divisions in a row. Draining
     largest-first keeps enough separators in hand to the last problem. */
  const out = [];
  const total = items.length;
  while (out.length < total) {
    const n = out.length;
    let blocked = null;
    if (n >= 2) {
      const a = bucketKey(out[n - 1].op, out[n - 1].band);
      if (a === bucketKey(out[n - 2].op, out[n - 2].band)) blocked = a;
    }

    let bestKey = null, bestLen = -1;
    for (const [k, arr] of groups) {
      if (!arr.length || k === blocked) continue;
      if (arr.length > bestLen || (arr.length === bestLen && rnd() < 0.5)) { bestLen = arr.length; bestKey = k; }
    }
    // Only the blocked bucket is left: accept the run rather than dropping
    // problems the user is owed.
    if (bestKey === null) bestKey = blocked;
    if (bestKey === null || !groups.get(bestKey)?.length) break;
    out.push(groups.get(bestKey).pop());
  }
  return out;
}

/* ============================================================ helpers */
const round3 = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;

function medianOfBuckets(buckets) {
  const withData = buckets.filter(b => b.seen > 0 && Number.isFinite(Number(b.medianMs)));
  if (!withData.length) return null;
  // Weight each bucket's median by how many attempts it represents, so a
  // 200-attempt bucket isn't outvoted by an 8-attempt one.
  const total = withData.reduce((s, b) => s + b.seen, 0);
  return Math.round(withData.reduce((s, b) => s + Number(b.medianMs) * b.seen, 0) / total);
}
