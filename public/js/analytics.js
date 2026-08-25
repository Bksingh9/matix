import { CONFIG } from './config.js';

/* ============================================================
   ANALYTICS BUS — one place to wire Plausible / GA4 / PostHog.
   Events: app_open, game_start, game_end, daily_start, daily_end,
   limit_hit, paywall_view, plan_click, checkout_open, licence_ok,
   licence_fail, reward_watch, share_click, pro_active
   ============================================================ */
const EVENTS = [];

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
