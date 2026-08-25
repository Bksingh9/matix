import { S, saveMeter } from './state.js';
import { CONFIG } from './config.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { renderMenu, renderRuns } from './ui.js';
import { isAuthed, openAuthSheet } from './auth.js';
import { validateLicence, pollForPro } from './entitlement.js';
import { post } from './api.js';

/* Paywall + run-limit sheets. Imports ui.js but never engine.js, so the
   module graph stays acyclic. */

export function openPaywall(reason, src) {
  $('#pw-reason').innerHTML = (reason || "Unlimited runs, every game, and a report on what's actually slowing you down.")
    .replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--ink)">$1</b>');
  $('#pw-msg').innerHTML = '';
  $('#paywall').classList.add('show');
  track('paywall_view', { source: src || 'menu' });
}
export const closePaywall = () => $('#paywall').classList.remove('show');

export function openReward(src) {
  $('#rw-msg').innerHTML = '';
  $('#rewardm').classList.add('show');
  track('paywall_view', { source: src || 'reward' });
}
export const closeReward = () => $('#rewardm').classList.remove('show');

export const pwNote = (html, err) => { $('#pw-msg').innerHTML = '<div class="notice' + (err ? ' err' : '') + '">' + html + '</div>'; };
export const rwNote = (html, err) => { $('#rw-msg').innerHTML = '<div class="notice' + (err ? ' err' : '') + '">' + html + '</div>'; };

/* Checkout goes through POST /api/checkout so custom_data.user_id is always
   attached server-side. Without it a payment arrives with nobody to give it
   to — which is a refund and a support ticket, not a sale. */
export async function startCheckout(plan) {
  track('plan_click', { plan, price: CONFIG.prices[plan] });

  if (!S.authed && !isAuthed()) {
    pwNote('Sign in first — a purchase has to attach to an account, or it can’t follow you to another device.');
    openAuthSheet('checkout', 'Sign in to buy. Your subscription lives on the account, not in this browser.');
    return;
  }

  const btn = document.querySelector(`#plans .plan[data-plan="${plan}"] .pp`);
  const original = btn ? btn.textContent : null;
  if (btn) btn.textContent = '…';

  try {
    const r = await post('/api/checkout', { plan });
    if (!r || !r.url) throw new Error('no_url');
    track('checkout_open', { plan });
    // Same tab. A popup gets blocked on iOS and the buyer never sees it.
    location.href = r.url;
  } catch (e) {
    const code = e && e.code;
    if (code === 'auth_required') {
      pwNote('Your session expired. Sign in again and the purchase will attach correctly.');
      openAuthSheet('checkout_expired');
    } else if (code === 'checkout_unavailable' || code === 'plan_unavailable') {
      pwNote('That plan isn’t on sale yet. Set <b>LS_VARIANT_' + plan.toUpperCase() + '</b> in the environment and it goes live.');
    } else if (code === 'rate_limited') {
      pwNote('Too many attempts in a row. Wait a minute and try again.', true);
    } else {
      pwNote('Couldn’t open checkout just now. Try again in a moment — nothing has been charged.', true);
    }
  } finally {
    if (btn && original !== null) btn.textContent = original;
  }
}

/* Returning from a successful checkout. Webhooks are fast but not instant, so
   poll /api/me rather than showing a buyer the free tier and letting them
   conclude the payment failed. */
export async function resumeAfterCheckout() {
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') !== 'success') return;

  history.replaceState(null, '', location.pathname);
  openPaywall('Thanks — confirming your purchase with the payment provider…', 'checkout_return');
  pwNote('This usually takes a few seconds.');

  const ent = await pollForPro({
    onTick: (i, left) => pwNote('Still confirming… (' + Math.ceil(left / 1000) + 's)')
  });

  if (ent.isPro) {
    pwNote('You’re Pro. Everything is unlocked — enjoy.');
    renderMenu();
    setTimeout(closePaywall, 1800);
  } else {
    pwNote('Your payment went through, but we haven’t had confirmation yet. It normally lands within a minute — reload then. '
      + 'If it still says free after that, email support with your receipt and we’ll fix it by hand.', true);
    renderMenu();
  }
}

/* Rewarded-ad hook. Replace the body with your network's call — for Google
   H5 Games Ads that's adBreak({type:'reward',beforeReward,adDismissed,adViewed}).
   Resolve ok:true only on a genuinely completed view. */
export function showRewarded() {
  return new Promise(res => {
    if (!CONFIG.ads.enabled) { res({ ok: false, reason: 'disabled' }); return; }
    setTimeout(() => res({ ok: true }), 1200);
  });
}

export async function watchReward() {
  if (S.meter.rewards >= CONFIG.ads.maxRewardsPerDay) {
    rwNote('That’s the ad limit for today. Pro removes the cap entirely.', true);
    return;
  }
  track('reward_watch', {});
  const b = $('#rw-watch');
  b.textContent = 'Loading ad…';
  const r = await showRewarded();
  b.textContent = 'Watch ad · +' + CONFIG.ads.rewardRuns + ' runs';
  if (!r.ok) {
    rwNote('Ads aren’t switched on in this build. Set <b>CONFIG.ads.enabled = true</b> once a gaming ad partner approves you, then implement <b>showRewarded()</b>.');
    return;
  }
  S.meter.runs = Math.max(0, S.meter.runs - CONFIG.ads.rewardRuns);
  S.meter.rewards++;
  saveMeter();
  renderRuns();
  closeReward();
}

/* ---- licence keys --------------------------------------------------------
   The key goes to /api/licence/validate, which checks it against Lemon Squeezy
   with the server-side API key and writes the entitlement row. The client then
   re-asks /api/me. Nothing here decides anything. */
export async function tryLicence() {
  const key = $('#lic-input').value.trim().toUpperCase();
  if (!key) { pwNote('Enter the key from your purchase email.', true); return; }

  // S.authed first: /api/me only reports authed:true for a request that
  // carried a valid token, so it is the server's answer rather than whether
  // the auth SDK happens to have loaded.
  if (!S.authed && !isAuthed()) {
    pwNote('Sign in first, then enter your key — that’s what binds the licence to an account instead of this browser.', true);
    openAuthSheet('licence', 'Sign in to attach your licence key to an account. Without one, the key can’t follow you to another device.');
    return;
  }

  const btn = $('#lic-btn');
  const original = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const r = await validateLicence(key);
    if (r && r.valid) {
      track('licence_ok', { plan: r.plan });
      closePaywall(); closeReward(); renderMenu();
      return;
    }
    track('licence_fail', { reason: 'rejected' });
    pwNote("That key didn't validate. Check your purchase email, or contact support.", true);
  } catch (e) {
    const code = e && e.code;
    if (code === 'key_in_use') {
      track('licence_fail', { reason: 'key_in_use' });
      pwNote('That key is already attached to a different account. If that account is yours, sign in with it; otherwise contact support.', true);
    } else if (code === 'rate_limited') {
      track('licence_fail', { reason: 'rate_limited' });
      pwNote('Too many attempts. Wait ten minutes and try again.', true);
    } else if (code === 'auth_required') {
      track('licence_fail', { reason: 'auth_required' });
      pwNote('Your session expired. Sign in again, then re-enter the key.', true);
    } else if (code === 'invalid_key') {
      track('licence_fail', { reason: 'rejected' });
      pwNote("That key didn't validate. Check your purchase email, or contact support.", true);
    } else {
      track('licence_fail', { reason: 'network' });
      pwNote("Couldn't reach the licence server. Try again in a moment.", true);
    }
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

/* Dev-only Pro preview.

   This does NOT set S.pro. It cannot: entitlement comes from the server. What
   it does is tell you how to grant yourself a real comp entitlement, which is
   the only way Pro turns on now. Gated behind CONFIG.devMode and blocked from
   production by `npm run check:prod`. */
export function devPreviewPro() {
  if (!CONFIG.devMode) return;
  pwNote('Pro is decided by the server now, so no button can switch it on. To unlock a dev account, run:'
    + '<br><br><code style="color:var(--ink);word-break:break-all;">update entitlements set plan=\'comp\', status=\'active\' where user_id=\'&lt;your uuid&gt;\';</code>'
    + '<br><br>or run <b>sql/004_seed_dev.sql</b>, which also seeds a lopsided answer history for testing drills.');
}
