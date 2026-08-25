import { ok, json, methodGuard, readJson, unauthorized, badRequest, serverError, errorRef, clientIp, tooMany } from '../../lib/http.js';
import { userFromRequest, touchProfile } from '../../lib/auth.js';
import { guard } from '../../lib/ratelimit.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { validateLicenseKey, activateLicenseKey, variantToPlan } from '../../lib/lemonsqueezy.js';

/* POST /api/licence/validate  { key } -> { valid, plan }
 *
 * Lifetime buyers arrive with a key from their purchase email. This proxies
 * the check and, on success, writes the entitlement row.
 *
 * The Lemon Squeezy License API needs no API key of its own — the licence key
 * is the credential. The proxy exists because the server is what writes the
 * entitlement, enforces the rate limit, and refuses a key already bound to
 * someone else. See docs/LEMONSQUEEZY.md §3.
 */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const ip = clientIp(req);

  try {
    // 1. Rate-limit hard. This endpoint is a brute-force target: a guessed
    //    key is a free paid product. IP first, before any other work.
    if (!(await guard(res, 'licence', ip))) return tooMany(res, 600);

    const body = await readJson(req, 8 * 1024);
    const key = typeof body?.key === 'string' ? body.key.trim().toUpperCase() : '';
    if (!key || key.length < 8 || key.length > 128) return badRequest(res, 'invalid_key');

    // 2. A licence must attach to an account, or it cannot follow the buyer to
    //    another device — which is the whole reason they are typing it.
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'licence', `user:${user.id}`))) return tooMany(res, 600);

    const db = supabaseAdmin();

    // 3. Refuse a key already bound to a different account. Do not silently
    //    transfer: that is how one shared key becomes ten free accounts, and
    //    how a real buyer loses access to a key they paid for.
    const { data: existing, error: lookupErr } = await db
      .from('entitlements').select('user_id').eq('licence_key', key).maybeSingle();
    if (lookupErr && lookupErr.code !== 'PGRST116') throw lookupErr;
    if (existing && existing.user_id !== user.id) {
      return json(res, 409, { error: 'key_in_use' });
    }

    // 4. Ask Lemon Squeezy.
    const result = await validateLicenseKey(key);
    if (!result || result.valid !== true) {
      console.warn(`[licence] rejected for ${user.id} from ${ip}: ${result?.error || 'invalid'}`);
      return json(res, 400, { error: 'invalid_key', valid: false });
    }

    const lk = result.license_key || {};
    // A key can be valid-but-unusable: revoked, expired, or fully activated.
    if (lk.status && !['active', 'inactive'].includes(lk.status)) {
      return json(res, 400, { error: 'key_' + lk.status, valid: false });
    }

    // 5. Bind an instance so reuse is countable and the activation limit is
    //    enforced by Lemon Squeezy rather than by us. Already at the limit is
    //    a refusal, not a warning — otherwise the limit means nothing.
    let instanceId = null;
    const needsActivation = lk.activation_limit != null && (lk.activation_usage ?? 0) < lk.activation_limit;
    if (needsActivation || lk.status === 'inactive') {
      const act = await activateLicenseKey(key, `mindsharp:${user.id}`);
      if (act?.activated === true) instanceId = act?.instance?.id || null;
      else if (act?.error && /activation limit/i.test(act.error)) {
        console.warn(`[licence] activation limit reached for ${user.id}`);
        return json(res, 409, { error: 'activation_limit_reached', valid: false });
      }
    }

    // 6. Grant. The variant tells us the plan; a licence-key product that is
    //    not the lifetime variant still resolves to lifetime, because a key is
    //    a one-time entitlement by construction.
    const meta = result.meta || {};
    const plan = variantToPlan(meta.variant_id) || 'lifetime';

    const patch = {
      user_id: user.id,
      plan,
      status: 'active',
      source: 'licence',
      licence_key: key,
      current_period_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString()
    };
    if (meta.customer_id != null) patch.ls_customer_id = String(meta.customer_id);
    if (meta.order_id != null) patch.ls_order_id = String(meta.order_id);
    if (meta.variant_id != null) patch.ls_variant_id = String(meta.variant_id);

    const { error: upErr } = await db.from('entitlements').upsert(patch, { onConflict: 'user_id' });
    if (upErr) {
      // The unique index on licence_key is the last line of defence against a
      // race between two accounts redeeming the same key at the same moment.
      if (upErr.code === '23505') return json(res, 409, { error: 'key_in_use' });
      throw upErr;
    }

    await touchProfile(user);
    console.log(`[licence] ${user.id} redeemed a ${plan} key${instanceId ? ` (instance ${instanceId})` : ''}`);
    return ok(res, { valid: true, plan });
  } catch (e) {
    const ref = errorRef();
    console.error(`[licence:${ref}]`, e);
    if (String(e.message || '').includes('lemonsqueezy_license')) {
      return json(res, 502, { error: 'licence_service_unavailable', ref });
    }
    return serverError(res, ref);
  }
}
