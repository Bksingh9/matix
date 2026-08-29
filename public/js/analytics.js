import { CONFIG } from './config.js';

/* ============================================================
   ANALYTICS BUS — one place to wire PostHog / Umami / Plausible / GA4.
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

/* Loads whichever provider is configured, once, or nothing at all.
 *
 * Injected here rather than hard-coded into index.html so the choice lives in
 * one place and a deployment with no analytics account ships no third-party
 * script whatsoever — which is the default.
 *
 * All three are cookieless and aggregate. That is not incidental: it is why
 * this app has no consent banner, and swapping in something that sets a
 * tracking cookie would quietly make that a lie. */
let loaded = false;

export function initAnalytics() {
  if (loaded) return;
  loaded = true;
  const a = CONFIG.analytics;
  if (!a?.enabled) return;

  const load = LOADERS[a.provider];
  if (load) load(a);
}

/* Each loader queues calls made before its script arrives, so an event fired
   during boot is not silently dropped. */
const LOADERS = {
  posthog(a) {
    const { key, host } = a.posthog || {};
    if (!key || window.posthog) return;
    // Minimal stub: queue until the real library replaces it.
    const q = [];
    window.posthog = {
      capture: (...args) => q.push(['capture', args]),
      __q: q,
      __stub: true
    };
    inject(`${String(host || '').replace(/\/+$/, '')}/static/array.js`, s => {
      s.addEventListener('load', () => {
        try {
          window.posthog.init(key, { api_host: host, capture_pageview: true, persistence: 'memory' });
          for (const [fn, args] of q) window.posthog[fn]?.(...args);
        } catch (e) { /* analytics must never break the game */ }
      });
    });
  },

  umami(a) {
    const { website, src } = a.umami || {};
    if (!website || !src) return;
    inject(src, s => {
      s.setAttribute('data-website-id', website);
      s.defer = true;
    });
  },

  plausible(a) {
    const { domain, src } = a.plausible || {};
    if (!domain || !src || window.plausible) return;
    window.plausible = function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
    inject(src, s => {
      s.defer = true;
      s.setAttribute('data-domain', domain);
    });
  }
};

function inject(src, configure) {
  const s = document.createElement('script');
  s.src = src;
  configure?.(s);
  s.addEventListener('error', () => console.warn('[analytics] blocked or unreachable:', src));
  document.head.appendChild(s);
}

export function track(name, props) {
  if (!CONFIG.analytics.enabled) return;
  const e = { name, ts: Date.now(), props: props || {} };
  EVENTS.push(e);
  try {
    if (window.plausible) window.plausible(name, { props: e.props });
    if (window.posthog?.capture) window.posthog.capture(name, e.props);
    if (window.umami?.track) window.umami.track(name, e.props);
    if (window.gtag) window.gtag('event', name, e.props);
    if (window.dataLayer) window.dataLayer.push(Object.assign({ event: name }, e.props));
  } catch (err) { /* analytics must never break the game */ }
}

export const events = EVENTS;
window.__mindsharp = { events: EVENTS };
