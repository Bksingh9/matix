import { ok, json, methodGuard, readJson, unauthorized, badRequest, serverError, errorRef, clientIp, tooMany } from '../../lib/http.js';
import { userFromRequest } from '../../lib/auth.js';
import { guard } from '../../lib/ratelimit.js';
import { supabaseAdmin, isConfigured } from '../../lib/supabase.js';
import { getEntitlementRow } from '../../lib/entitlement.js';
import { cancelSubscription, isConfigured as lsConfigured } from '../../lib/lemonsqueezy.js';

/* POST /api/account/delete  { confirm: 'DELETE' }
 *
 * Required, not optional. App Store guideline 5.1.1(v) says any app offering
 * account creation must let you delete the account from inside the app, and
 * Play has an equivalent rule that also wants a web-reachable route. We have
 * magic-link sign-in, so both apply. A build without this gets rejected.
 *
 * It is also the honest thing to ship: an account you cannot close is not
 * really yours.
 *
 * Deleting the auth user cascades to every table that references it — see the
 * `on delete cascade` in sql/001_schema.sql and 005_progression.sql. That is
 * the whole deletion; the explicit sweep below exists only for the rows keyed
 * by something other than the user id.
 */

/* What deletion does NOT do, and what we therefore have to say out loud. */
const STORE_RAILS = ['play', 'appstore'];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const ref = errorRef();
  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!isConfigured()) return json(res, 503, { error: 'no_database' });

    // Same budget as checkout. Deletion is not something to hammer, and a
    // loop of these would be an expensive way to fill the auth audit log.
    if (!(await guard(res, 'checkout', user.id, clientIp(req)))) return tooMany(res, 600);

    // A typed confirmation, because the client is a game and misclicks happen.
    // The server insists on it so a stray fetch cannot close someone's account.
    const body = await readJson(req, 4 * 1024);
    if (body?.confirm !== 'DELETE') return badRequest(res, 'confirm_required');

    const db = supabaseAdmin();

    /* Read the entitlement, or refuse. Swallowing the error would make an
       unreachable table look identical to "no subscription", and this endpoint
       must never guess about billing. */
    let ent;
    try {
      ent = await getEntitlementRow(user.id);
    } catch (e) {
      console.error(`[delete ${ref}] could not read entitlement:`, e?.message);
      return json(res, 503, { error: 'entitlement_unreadable' });
    }

    /* Refuse while a store subscription is live. Deleting the account would not
       cancel it — only Apple or Google can — so the card keeps being charged
       for a product with no account to attach to. That is a chargeback and a
       one-star review; the fix is to say so and name the right store. */
    if (ent && STORE_RAILS.includes(ent.source) && ['active', 'past_due'].includes(ent.status)) {
      return json(res, 409, { error: 'store_subscription_active', source: ent.source });
    }

    /* Cancel a live Lemon Squeezy subscription first. Here we do have the
       authority the stores deny us, and a subscription that outlives its
       account bills a card for nothing. If the API is unreachable, stop:
       better to leave the account open and let them retry than to delete it
       and keep charging them. */
    if (ent?.ls_subscription_id && ['active', 'past_due'].includes(ent.status) && lsConfigured()) {
      const cancelled = await cancelSubscription(ent.ls_subscription_id).catch(e => {
        console.error(`[delete ${ref}] cancel failed:`, e?.message);
        return false;
      });
      if (!cancelled) return json(res, 503, { error: 'cancel_failed' });
    }

    /* Rate-limit buckets are keyed `<kind>:<user-id>`, so no foreign key
       reaches them and the id would sit there after the account is gone.
       Nothing depends on them surviving — the window is ten minutes and the
       id can never recur.

       Deliberately left alone: webhook_events and store_notifications. Both
       are the payment audit trail, keyed by the provider's event id rather
       than by us, and a refund request can arrive after the account is gone.
       Neither carries a user_id column; the attribution lives inside the raw
       payload the provider sent, which is the thing that makes the record
       worth keeping. */
    await db.from('rate_limits').delete().like('bucket', `%:${user.id}`)
      .then(null, e => console.error(`[delete ${ref}] rate_limits:`, e?.message));

    /* Release the entitlement's store/licence identifiers before the row
       cascades away. Without this a lifetime licence key stays bound to a
       deleted user id and can never be redeemed again — including by the
       person who paid for it, on their new account. */
    await db.from('entitlements')
      .update({ ls_customer_id: null, ls_subscription_id: null, licence_key: null, store_txn_id: null })
      .eq('user_id', user.id)
      .then(null, e => console.error(`[delete ${ref}] entitlements scrub:`, e?.message));

    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) {
      console.error(`[delete ${ref}] deleteUser failed:`, error.message);
      return serverError(res, ref);
    }

    console.log(`[delete ${ref}] account ${user.id} deleted`);
    return ok(res, { deleted: true });
  } catch (e) {
    console.error(`[delete ${ref}]`, e);
    return serverError(res, ref);
  }
}
