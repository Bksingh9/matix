import { ok, methodGuard, serverError, errorRef, clientIp } from '../lib/http.js';
import { userFromRequest, touchProfile } from '../lib/auth.js';
import { resolveEntitlement, limitsFor, freeRuns, FREE_ENTITLEMENT } from '../lib/entitlement.js';
import { isConfigured, supabaseAdmin } from '../lib/supabase.js';
import { guard } from '../lib/ratelimit.js';

/* Does this account already hold history? The client uses it to decide whether
   to back-fill anonymous local progress on first sign-in. */
async function hasRuns(userId) {
  try {
    const { count, error } = await supabaseAdmin()
      .from('runs').select('id', { count: 'exact', head: true }).eq('user_id', userId).limit(1);
    if (error) throw error;
    return (count || 0) > 0;
  } catch { return true; }   // on doubt, don't back-fill: a duplicate import is worse than none
}

/* GET /api/me — the single source of truth for Pro.
   The client asks; it never decides. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const anon = {
    authed: false,
    user: null,
    entitlement: { ...FREE_ENTITLEMENT },
    limits: { freeRuns: freeRuns(), runsUsedToday: 0, runsLeft: freeRuns() },
    serverTime: new Date().toISOString()
  };

  // No backend configured yet (a static preview deploy): answer as anonymous
  // free rather than erroring, so the game still plays.
  if (!isConfigured()) { ok(res, anon); return; }

  try {
    if (!(await guard(res, 'read', clientIp(req)))) { ok(res, anon); return; }

    const user = await userFromRequest(req);
    if (!user) { ok(res, anon); return; }

    const entitlement = await resolveEntitlement(user.id);
    const [limits, seen] = await Promise.all([
      limitsFor(user.id, entitlement.isPro),
      hasRuns(user.id)
    ]);

    // Fire-and-forget: keeps profiles.email fresh for the webhook's
    // email-matching fallback.
    touchProfile(user);

    ok(res, {
      authed: true,
      user: {
        id: user.id,
        email: user.email || null,
        displayName: user.user_metadata?.display_name || user.user_metadata?.name || null
      },
      entitlement,
      limits,
      hasRuns: seen,
      serverTime: new Date().toISOString()
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[me:${ref}]`, e);
    serverError(res, ref);
  }
}
