import { ok, json, methodGuard, unauthorized, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { guard } from '../lib/ratelimit.js';
import { getEntitlementRow } from '../lib/entitlement.js';
import { subscriptionPortalUrl } from '../lib/lemonsqueezy.js';

/* GET /api/portal — a link to the Lemon Squeezy customer portal.
 *
 * This is how a subscriber cancels, updates a card, or downloads an invoice
 * without emailing anyone. The portal URL is short-lived and specific to the
 * subscription, so it is fetched on demand rather than stored.
 *
 * "You can buy, use, cancel and get refunded without you touching a database"
 * is the Phase 6 acceptance criterion; this endpoint is the cancel half. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'read', user.id, clientIp(req)))) return tooMany(res, 600);

    const row = await getEntitlementRow(user.id);
    if (!row) return json(res, 404, { error: 'no_entitlement' });

    // Lifetime and comp plans have nothing to manage — say so plainly rather
    // than sending someone to a portal that will confuse them.
    if (!row.ls_subscription_id) {
      return ok(res, {
        url: null,
        plan: row.plan,
        manageable: false,
        reason: row.plan === 'lifetime' ? 'lifetime_no_renewal'
          : row.plan === 'comp' ? 'comp_no_billing'
            : 'no_subscription'
      });
    }

    const url = await subscriptionPortalUrl(row.ls_subscription_id);
    if (!url) return json(res, 502, { error: 'portal_unavailable' });

    return ok(res, { url, plan: row.plan, manageable: true });
  } catch (e) {
    const ref = errorRef();
    console.error(`[portal:${ref}]`, e);
    return serverError(res, ref);
  }
}
