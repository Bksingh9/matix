import { ok, methodGuard, unauthorized, forbidden, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { resolveEntitlement } from '../lib/entitlement.js';
import { guard } from '../lib/ratelimit.js';
import { loadBuckets, totalAttempts } from '../lib/buckets.js';
import { buildReport } from '../lib/weakness.js';

/* GET /api/weakspots — the report the paywall promises. Pro-gated. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'read', user.id, clientIp(req)))) return tooMany(res, 600);

    const ent = await resolveEntitlement(user.id);
    if (!ent.isPro) return forbidden(res);

    const [buckets, total] = await Promise.all([loadBuckets(user.id), totalAttempts(user.id)]);
    const report = buildReport(buckets);

    // Report the true attempt count, including recall rounds, which the
    // bucket views exclude because they carry no operation.
    report.overall.attemptsAnalysed = Math.min(400, total);
    report.sampleTooSmall = total < 40;
    report.attemptsNeeded = Math.max(0, 40 - total);

    return ok(res, report);
  } catch (e) {
    const ref = errorRef();
    console.error(`[weakspots:${ref}]`, e);
    return serverError(res, ref);
  }
}
