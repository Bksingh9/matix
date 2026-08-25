import { CONFIG } from './config.js';

/* ============================================================
   ANALYTICS BUS — one place to wire Plausible / GA4 / PostHog.
   Events: app_open, game_start, game_end, daily_start, daily_end,
   limit_hit, paywall_view, plan_click, checkout_open, licence_ok,
   licence_fail, reward_watch, share_click, pro_active
   ============================================================ */
const EVENTS = [];

/* The fourteen funnel events the monetisation plan's five numbers are built
   from. Exported so a smoke test can assert none has been renamed out from
   under a dashboard. */
export const FUNNEL_EVENTS = [
  'app_open', 'game_start', 'game_end', 'daily_start', 'daily_end',
  'limit_hit', 'paywall_view', 'plan_click', 'checkout_open',
  'licence_ok', 'licence_fail', 'reward_watch', 'share_click', 'pro_active'
];

/* Loads Plausible once, if a domain is configured. Cookieless and aggregate,
   which is why there is no consent banner anywhere in this app.

   Injected here rather than hard-coded into index.html so the domain lives in
   one place and a deployment with no analytics account ships no third-party
   script at all. */
let loaded = false;
export function initAnalytics() {
  if (loaded) return;
  loaded = true;
  const p = CONFIG.analytics?.plausible;
  if (!CONFIG.analytics.enabled || !p?.domain || !p?.src) return;
  if (window.plausible) return;
  // Queue events fired before the script finishes loading.
  window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
  const s = document.createElement('script');
  s.defer = true;
  s.src = p.src;
  s.setAttribute('data-domain', p.domain);
  s.addEventListener('error', () => console.warn('[analytics] Plausible blocked or unreachable'));
  document.head.appendChild(s);
}

export function track(name, props) {
  if (!CONFIG.analytics.enabled) return;
  const e = { name, ts: Date.now(), props: props || {} };
  EVENTS.push(e);
  try {
    if (window.plausible) window.plausible(name, { props: e.props });
    if (window.gtag) window.gtag('event', name, e.props);
    if (window.dataLayer) window.dataLayer.push(Object.assign({ event: name }, e.props));
  } catch (err) { /* analytics must never break the game */ }
}

export const events = EVENTS;
window.__mindsharp = { events: EVENTS };
