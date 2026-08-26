import { S } from './state.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { post } from './api.js';
import { isNative, platform } from './native.js';
import { refreshEntitlement } from './entitlement.js';

/* Native in-app purchase.
 *
 * Apple and Google require their own billing for digital goods in a game —
 * the reader-app exemption covers magazines and video, not this. So the app
 * has two payment rails and the server accepts either: web goes to Lemon
 * Squeezy at 5%, the stores take 15–30%.
 *
 * The client never decides anything. It hands the receipt to
 * /api/purchases/verify, which asks the store and writes the entitlement.
 * Then it re-reads /api/me like any other path to Pro.
 *
 * Built on cordova-plugin-purchase, which Capacitor loads into the WebView.
 * On the web `window.CdvPurchase` is absent and every function here reports
 * "not available" rather than throwing.
 */

const PRODUCT = {
  monthly: 'mindsharp.pro.monthly',
  yearly: 'mindsharp.pro.yearly',
  lifetime: 'mindsharp.pro.lifetime'
};

const store = () => window.CdvPurchase?.store || null;
export const billingAvailable = () => isNative() && !!store();

let ready = false;
let offers = new Map();

export async function initBilling() {
  if (!billingAvailable()) return false;
  const CdvPurchase = window.CdvPurchase;
  const st = store();

  try {
    st.verbosity = CdvPurchase.LogLevel.WARNING;

    const pf = platform() === 'ios' ? CdvPurchase.Platform.APPLE_APPSTORE : CdvPurchase.Platform.GOOGLE_PLAY;
    st.register([
      { id: PRODUCT.monthly, type: CdvPurchase.ProductType.PAID_SUBSCRIPTION, platform: pf },
      { id: PRODUCT.yearly, type: CdvPurchase.ProductType.PAID_SUBSCRIPTION, platform: pf },
      { id: PRODUCT.lifetime, type: CdvPurchase.ProductType.NON_CONSUMABLE, platform: pf }
    ]);

    // Every approved transaction goes to our server before it is finished.
    // Finishing first would mean a purchase the store considers delivered and
    // our database has never heard of.
    st.when()
      .productUpdated(p => { if (p.getOffer()) offers.set(p.id, p.getOffer()); })
      .approved(tx => verifyAndFinish(tx))
      .verified(receipt => receipt.finish?.())
      .receiptUpdated(() => { /* handled on approval */ });

    await st.initialize([pf]);
    await st.update();
    ready = true;
    track('billing_ready', { platform: platform() });
    return true;
  } catch (e) {
    console.warn('[billing] init failed:', e && e.message);
    return false;
  }
}

/* Localised prices from the store, so an Indian buyer sees rupees rather than
   a dollar figure they then get charged a converted amount for. */
export function localPrice(plan) {
  const offer = offers.get(PRODUCT[plan]);
  return offer?.pricingPhases?.[0]?.price || null;
}

export function applyLocalPrices() {
  if (!ready) return;
  for (const [plan, el] of [['monthly', '#pp-m'], ['yearly', '#pp-y'], ['lifetime', '#pp-l']]) {
    const price = localPrice(plan);
    const node = $(el);
    if (price && node) node.textContent = price;
  }
}

export async function buy(plan) {
  if (!billingAvailable()) return { ok: false, reason: 'unavailable' };
  const id = PRODUCT[plan];
  const st = store();
  const product = st.get(id);
  const offer = product?.getOffer();
  if (!offer) return { ok: false, reason: 'no_offer' };

  track('iap_purchase_started', { plan, platform: platform() });
  try {
    const err = await offer.order();
    if (err) {
      const cancelled = err.code === window.CdvPurchase?.ErrorCode?.PAYMENT_CANCELLED;
      track('iap_purchase_failed', { plan, reason: cancelled ? 'cancelled' : String(err.code) });
      return { ok: false, reason: cancelled ? 'cancelled' : 'store_error', message: err.message };
    }
    // Entitlement arrives asynchronously through the approved handler.
    return { ok: true, pending: true };
  } catch (e) {
    track('iap_purchase_failed', { plan, reason: 'exception' });
    return { ok: false, reason: 'exception', message: e && e.message };
  }
}

/* The approved transaction: verify server-side, then finish.
 *
 * Order matters. Finishing before verification tells the store the goods were
 * delivered — and if our server never recorded it, the buyer has paid for
 * nothing and there is no receipt left to retry with. */
async function verifyAndFinish(tx) {
  try {
    const productId = tx.products?.[0]?.id || tx.productId;
    const plan = Object.keys(PRODUCT).find(k => PRODUCT[k] === productId);
    if (!plan) { console.warn('[billing] unknown product', productId); return; }

    const payload = platform() === 'ios'
      ? { platform: 'ios', productId, transactionId: tx.transactionId }
      : { platform: 'android', productId, purchaseToken: tx.purchaseToken || tx.transactionId };

    const r = await post('/api/purchases/verify', payload);
    if (r?.valid) {
      track('iap_verified', { plan, status: r.status });
      await refreshEntitlement({ force: true });
      window.dispatchEvent(new CustomEvent('ms:purchase-verified', { detail: { plan } }));
      tx.finish?.();
      return;
    }
    console.warn('[billing] server rejected the purchase');
  } catch (e) {
    // Do NOT finish. The store will re-deliver the transaction on the next
    // launch, and the retry is the only thing standing between a paying
    // customer and a support email.
    track('iap_verify_failed', { reason: e?.code || 'network' });
    console.error('[billing] verification failed, leaving the transaction open to retry:', e && e.message);
  }
}

/* Restore Purchases.
 *
 * Not optional on iOS — App Review rejects any app selling non-consumables
 * without it. It is also what a real user needs after reinstalling. */
export async function restore() {
  if (!billingAvailable()) return { ok: false, reason: 'unavailable' };
  track('iap_restore', {});
  try {
    await store().restorePurchases();
    await refreshEntitlement({ force: true });
    return { ok: true, isPro: S.pro };
  } catch (e) {
    return { ok: false, reason: 'error', message: e && e.message };
  }
}

/* Where a store subscription is actually managed. Deep-linking to the OS
   screen is the only place a cancellation can happen; our own portal has no
   authority over a store subscription. */
export function manageUrl() {
  if (platform() === 'ios') return 'https://apps.apple.com/account/subscriptions';
  if (platform() === 'android') return 'https://play.google.com/store/account/subscriptions';
  return null;
}
