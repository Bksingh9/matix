import { S, saveMeter } from './state.js';
import { K, sset } from './store.js';
import { CONFIG } from './config.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { renderMenu, renderRuns } from './ui.js';

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

/* Checkout is wired to POST /api/checkout in Phase 2 so that
   custom_data.user_id is always attached server-side. */
export function startCheckout(plan) {
  track('plan_click', { plan, price: CONFIG.prices[plan] });
  const url = CONFIG.checkout[plan];
  if (!url) { pwNote('No checkout link yet. Paste your buy URL into <b>CONFIG.checkout.' + plan + '</b> and this button goes live.'); return; }
  track('checkout_open', { plan });
  window.open(url, '_blank', 'noopener');
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
   Phase 3 replaces this with a call to /api/licence/validate, which proxies
   the Lemon Squeezy licence check with the server-side API key and writes the
   entitlement row. Until then this is the demo-key path from the original
   single-file build. */
export async function grantPro(licence, source) {
  S.pro = true;
  S.licence = licence || null;
  await sset(K.ent, { pro: true, licence: S.licence, since: Date.now() });
  track('pro_active', { source: source || 'unknown' });
  closePaywall(); closeReward(); renderMenu();
}

export async function tryLicence() {
  const key = $('#lic-input').value.trim().toUpperCase();
  if (!key) { pwNote('Enter the key from your purchase email.', true); return; }
  if (CONFIG.licenceApi) {
    try {
      const r = await fetch(CONFIG.licenceApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const d = await r.json();
      if (d && d.valid) { track('licence_ok', {}); grantPro(key, 'licence'); return; }
      track('licence_fail', { reason: 'rejected' });
      pwNote("That key didn't validate. Check your purchase email, or contact support.", true);
    } catch (e) {
      track('licence_fail', { reason: 'network' });
      pwNote("Couldn't reach the licence server. Try again in a moment.", true);
    }
    return;
  }
  if (/^MS-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) { track('licence_ok', { mode: 'demo' }); grantPro(key, 'licence_demo'); }
  else { track('licence_fail', { mode: 'demo' }); pwNote('Demo mode accepts keys shaped like <b>MS-4KQ2-A19Z</b>. Set <b>CONFIG.licenceApi</b> for real validation.', true); }
}

/* Dev-only local Pro unlock. Gated behind CONFIG.devMode and stripped from
   production by `npm run check:prod`. Never grants server entitlement. */
export function devPreviewPro() {
  if (!CONFIG.devMode) return;
  grantPro(null, 'demo_preview');
}
