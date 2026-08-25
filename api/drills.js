import { ok, json, methodGuard, unauthorized, forbidden, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { resolveEntitlement } from '../lib/entitlement.js';
import { guard } from '../lib/ratelimit.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { loadBuckets, totalAttempts } from '../lib/buckets.js';
import { buildReport, chooseBuckets, interleave } from '../lib/weakness.js';
import { generateProblems, snapshotTargets } from '../lib/drillgen.js';

const MIN_ATTEMPTS = 40;
const DEFAULT_SIZE = 20;

/* GET /api/drills?size=20 — generate and persist a drill, return its problems.
 *
 * The client plays this exact set. No client-side generation in Drill mode, or
 * the before/after comparison would be measuring two different things. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'read', user.id, clientIp(req)))) return tooMany(res, 600);

    const ent = await resolveEntitlement(user.id);
    if (!ent.isPro) return forbidden(res);

    const url = new URL(req.url, 'http://localhost');
    const requested = parseInt(url.searchParams.get('size') || '', 10);
    const size = Number.isFinite(requested) ? Math.max(5, Math.min(50, requested)) : DEFAULT_SIZE;

    const total = await totalAttempts(user.id);
    if (total < MIN_ATTEMPTS) {
      // Do not fabricate a drill from nothing. A generic set labelled
      // "personalised" is exactly what gets a refund request.
      return json(res, 422, {
        error: 'insufficient_data',
        attemptsNeeded: MIN_ATTEMPTS - total,
        attemptsSoFar: total
      });
    }

    const buckets = await loadBuckets(user.id);
    const report = buildReport(buckets, { minAttempts: MIN_ATTEMPTS });
    const scored = report.buckets;

    if (!scored.length) {
      return json(res, 422, {
        error: 'insufficient_data',
        attemptsNeeded: MIN_ATTEMPTS,
        attemptsSoFar: total,
        detail: 'no bucket has enough attempts yet'
      });
    }

    const picked = chooseBuckets(scored, size);
    if (!picked.length) {
      // Everything eligible has graduated. That is a good outcome, not an
      // error — say so rather than serving a drill with nothing to fix.
      return json(res, 422, {
        error: 'all_mastered',
        detail: 'every bucket with enough data has graduated',
        buckets: scored.filter(b => b.mastered).map(b => ({ op: b.op, band: b.band, label: b.label }))
      });
    }

    const order = interleave(picked);
    const problems = generateProblems(order);
    const targeted = snapshotTargets(scored, order);

    const { data, error } = await supabaseAdmin().from('drills').insert({
      user_id: user.id,
      buckets: targeted,
      problems
    }).select('id').maybeSingle();
    if (error) throw error;

    return ok(res, {
      drillId: data?.id ?? null,
      size: problems.length,
      targeted,
      problems,
      // Handy for the results screen: what the whole report looked like going in.
      overall: report.overall
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[drills:${ref}]`, e);
    return serverError(res, ref);
  }
}
