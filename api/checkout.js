import { ok, json, methodGuard, readJson, unauthorized, badRequest, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest, touchProfile } from '../lib/auth.js';
import { guard } from '../lib/ratelimit.js';
import { createCheckout, planToVariant, buyLinkWithCustomData, isConfigured } from '../lib/lemonsqueezy.js';

const PLANS = new Set(['monthly', 'yearly', 'lifetime']);

/* POST /api/checkout  { plan } -> { url }
 *
 * The checkout URL is built server-side so custom_data.user_id is always
 * attached. That field is the only link between a payment and an account; a
 * checkout without it produces an orphaned payment and a support ticket you
 * answer by hand. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  try {
    const body = await readJson(req);
    const plan = body?.plan;
    if (!PLANS.has(plan)) return badRequest(res, 'bad_plan', { allowed: [...PLANS] });

    // Nobody buys before they have an account.
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);

    if (!(await guard(res, 'checkout', user.id, clientIp(req)))) return tooMany(res, 600);

    // Make sure profiles has this user before the webhook needs to find them.
    await touchProfile(user);

    const redirectUrl = successUrl();

    // A plain hosted buy link, if that is all that is configured.
    const staticLink = process.env[`CHECKOUT_LINK_${plan.toUpperCase()}`];
    if (!isConfigured()) {
      if (staticLink) return ok(res, { url: buyLinkWithCustomData(staticLink, user.id, user.email), mode: 'buy_link' });
      return json(res, 503, { error: 'checkout_unavailable' });
    }

    const variantId = planToVariant(plan);
    if (!variantId) {
      console.error(`[checkout] LS_VARIANT_${plan.toUpperCase()} is not set`);
      return json(res, 503, { error: 'plan_unavailable', plan });
    }

    const { url, checkoutId } = await createCheckout({
      variantId,
      userId: user.id,
      email: user.email || undefined,
      redirectUrl,
      testMode: process.env.VERCEL_ENV !== 'production' ? true : undefined
    });

    return ok(res, { url, plan, checkoutId });
  } catch (e) {
    const ref = errorRef();
    console.error(`[checkout:${ref}]`, e);
    if (String(e.message || '').startsWith('lemonsqueezy_checkout_failed')) {
      return json(res, 502, { error: 'checkout_failed', ref });
    }
    return serverError(res, ref);
  }
}

/* Where Lemon Squeezy sends the buyer afterwards. The ?checkout=success marker
   is what makes the client start polling /api/me: webhooks are fast but not
   instant, and a buyer staring at a free tier assumes the payment failed. */
function successUrl() {
  const base = process.env.APP_URL;
  if (!base) return undefined;
  try {
    const u = new URL(base);
    u.searchParams.set('checkout', 'success');
    return u.toString();
  } catch {
    return undefined;
  }
}
