import { ok, json, methodGuard, readJson, unauthorized, badRequest, serverError, errorRef, clientIp, tooMany } from '../../lib/http.js';
import { userFromRequest, touchProfile } from '../../lib/auth.js';
import { guard } from '../../lib/ratelimit.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createHash } from 'node:crypto';
import * as play from '../../lib/playstore.js';
import * as apple from '../../lib/appstore.js';

/* POST /api/purchases/verify
 *   { platform: 'android'|'ios', productId, purchaseToken?, transactionId? }
 *
 * A store purchase becomes the same entitlement row a Lemon Squeezy purchase
 * writes. One definition of Pro, three ways in.
 *
 * The client is not believed about anything: not the product, not the price,
 * not whether the purchase succeeded. It hands over a token, and we ask the
 * store. A client that could assert its own purchase would be exactly the
 * hole the whole server-side entitlement design exists to close.
 */

/* Store product ids → plans. Set these to whatever you create in App Store
   Connect and Play Console; they do not have to match, but both must be here
   or the purchase is refused rather than guessed at. */
function planFor(productId) {
  const map = {
    [process.env.IAP_PRODUCT_MONTHLY || 'mindsharp.pro.monthly']: 'monthly',
    [process.env.IAP_PRODUCT_YEARLY || 'mindsharp.pro.yearly']: 'yearly',
    [process.env.IAP_PRODUCT_LIFETIME || 'mindsharp.pro.lifetime']: 'lifetime'
  };
  return map[productId] || null;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'checkout', user.id, clientIp(req)))) return tooMany(res, 600);

    const body = await readJson(req, 32 * 1024);
    const platform = body?.platform;
    const productId = typeof body?.productId === 'string' ? body.productId.trim() : '';
    if (!['android', 'ios'].includes(platform)) return badRequest(res, 'bad_platform');
    if (!productId || productId.length > 128) return badRequest(res, 'bad_product');

    const plan = planFor(productId);
    if (!plan) {
      console.error(`[iap] unmapped product "${productId}" — add it to IAP_PRODUCT_*`);
      return badRequest(res, 'unknown_product', { productId });
    }

    const verified = platform === 'android'
      ? await verifyAndroid({ productId, plan, token: body.purchaseToken })
      : await verifyApple({ productId, plan, transactionId: body.transactionId });

    if (verified.error) return json(res, verified.status || 400, { error: verified.error });

    // Refuse a purchase already attached to someone else. Same rule as licence
    // keys: one purchase, one account, and never a silent transfer.
    const db = supabaseAdmin();
    const { data: existing } = await db
      .from('entitlements').select('user_id').eq('store_txn_id', verified.txnId).maybeSingle();
    if (existing && existing.user_id !== user.id) {
      console.warn(`[iap] transaction ${verified.txnId} already belongs to ${existing.user_id}`);
      return json(res, 409, { error: 'purchase_in_use' });
    }

    const patch = {
      user_id: user.id,
      plan: verified.plan,
      status: verified.status,
      source: platform === 'android' ? 'play' : 'appstore',
      store_txn_id: verified.txnId,
      store_product_id: productId,
      current_period_end: verified.expiresAt,
      cancel_at_period_end: verified.status === 'cancelled',
      updated_at: new Date().toISOString()
    };

    const { error } = await db.from('entitlements').upsert(patch, { onConflict: 'user_id' });
    if (error) {
      if (error.code === '23505') return json(res, 409, { error: 'purchase_in_use' });
      throw error;
    }

    await touchProfile(user);
    console.log(`[iap] ${platform} ${verified.plan} (${verified.status}) → ${user.id}`);

    return ok(res, {
      valid: true,
      plan: verified.plan,
      status: verified.status,
      expiresAt: verified.expiresAt,
      environment: verified.environment || 'production'
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[iap:${ref}]`, e);
    if (/is not set|must all be set/.test(e.message || '')) {
      return json(res, 503, { error: 'billing_not_configured', ref });
    }
    return json(res, 502, { error: 'verification_failed', ref });
  }
}

async function verifyAndroid({ productId, plan, token }) {
  if (typeof token !== 'string' || token.length < 10) return { error: 'bad_token', status: 400 };
  if (!play.isConfigured()) return { error: 'billing_not_configured', status: 503 };

  const isSub = plan !== 'lifetime';
  let result;
  try {
    result = isSub ? await play.getSubscription(token) : await play.getProduct(productId, token);
  } catch (e) {
    if (e.notFound) return { error: 'purchase_not_found', status: 404 };
    throw e;
  }

  if (!result.status || result.status === 'none' || result.status === 'pending') {
    return { error: 'purchase_not_active', status: 400 };
  }

  /* Check the product Google returned is the product being claimed — the same
     check verifyApple already does. Without it a monthly buyer can claim the
     yearly plan and have it written to their entitlement. Access still ends on
     Google's real expiry, so this is a mislabelling rather than free Pro, but
     the label is what the account sheet and the receipts show. */
  if (result.productId && result.productId !== productId) {
    console.warn(`[iap] play product mismatch: ${result.productId} vs claimed ${productId}`);
    return { error: 'product_mismatch', status: 400 };
  }

  // Google auto-refunds anything unacknowledged after three days. Failing to
  // acknowledge is the difference between a sale and a refund the customer
  // never asked for, so it happens before we report success.
  if (!result.acknowledged) {
    try { await play.acknowledge({ productId, purchaseToken: token, isSubscription: isSub }); }
    catch (e) { console.error('[iap] acknowledge failed — Google will auto-refund in 3 days:', e.message); }
  }

  return {
    plan,
    status: result.status,
    expiresAt: result.expiresAt,
    /* Hashed rather than truncated. A Play token is long and its prefix is
       not guaranteed unique, so slicing it risks two different purchases
       colliding in entitlements_store_txn_unique — which would refuse the
       second buyer their product. */
    txnId: `play:${createHash('sha256').update(token).digest('hex')}`
  };
}

async function verifyApple({ productId, plan, transactionId }) {
  if (typeof transactionId !== 'string' || !/^\d{5,25}$/.test(transactionId)) {
    return { error: 'bad_transaction_id', status: 400 };
  }
  if (!apple.isConfigured()) return { error: 'billing_not_configured', status: 503 };

  let result;
  try {
    result = plan === 'lifetime'
      ? await apple.getOneTimePurchase(transactionId)
      : await apple.getTransaction(transactionId);
  } catch (e) {
    if (e.notFound) return { error: 'purchase_not_found', status: 404 };
    throw e;
  }

  // The transaction must be for the app it claims to be for.
  const expectedBundle = process.env.APPLE_BUNDLE_ID;
  if (result.bundleId && expectedBundle && result.bundleId !== expectedBundle) {
    console.warn(`[iap] bundle mismatch: ${result.bundleId} vs ${expectedBundle}`);
    return { error: 'bundle_mismatch', status: 400 };
  }
  // And for the product it claims to be for.
  if (result.productId && result.productId !== productId) {
    console.warn(`[iap] product mismatch: ${result.productId} vs ${productId}`);
    return { error: 'product_mismatch', status: 400 };
  }
  if (!result.status || result.status === 'none') return { error: 'purchase_not_active', status: 400 };
  if (result.status === 'refunded') return { error: 'purchase_refunded', status: 400 };

  return {
    plan,
    status: result.status,
    expiresAt: result.expiresAt,
    environment: result.environment,
    txnId: `apple:${result.originalTransactionId}`
  };
}
