/* ============================================================
   MONETISATION CONFIG — public values only.

   Nothing secret goes in this file. It ships to the browser.
   Checkout URLs are now built server-side by POST /api/checkout so that
   custom_data.user_id is always attached; CONFIG.checkout survives only as
   a fallback for a static build with no backend.

   freeRuns  The conversion lever. Lower = more paywall views and more
             churn. Tune against the funnel, not instinct. For signed-in
             users the server's limits.freeRuns wins over this value.
   ads.enabled Leave false until you have real traffic. Turn on after a
             gaming ad partner approves you, then implement showRewarded().
   devMode   Enables the "Preview Pro in this browser" button. MUST be false
             in production — it is a free Pro button. `npm run check:prod`
             fails the build if it is true.
   ============================================================ */
export const CONFIG = {
  checkout: { monthly: '', yearly: '', lifetime: '' },
  // Phase 3 points this at '/api/licence/validate'. Empty = demo-key mode.
  licenceApi: '',
  prices: { monthly: '$4.99', yearly: '$29.99', lifetime: '$69' },
  ads: { enabled: false, rewardRuns: 2, maxRewardsPerDay: 2 },
  freeRuns: 5,
  analytics: {
    enabled: true,
    /* Which analytics to load, or 'none' to load nothing at all.
       Every option here is cookieless and aggregate, which is why this app
       has no consent banner: there is nothing to consent to.

       'posthog'  — free tier covers 1M events/month and does funnels and
                    retention, which is what MONETISATION_PLAN.md §8 actually
                    needs. The default recommendation.
       'umami'    — free cloud tier or self-hosted. Lighter, simpler.
       'plausible'— the nicest of the three and the only paid one (~$9/mo).
       'none'     — ships no third-party script whatsoever. */
    provider: 'none',

    // PostHog: `key` is the project API key (safe in client code — it is
    // write-only by design). Use the EU host if your users are in the EU.
    posthog: { key: '', host: 'https://eu.i.posthog.com' },

    // Umami: `website` is the site id from your dashboard.
    umami: { website: '', src: 'https://cloud.umami.is/script.js' },

    // Plausible: `domain` is the site registered in your account.
    plausible: { domain: '', src: 'https://plausible.io/js/script.js' }
  },
  // The dev Pro preview is a free Pro button. `npm run check:prod` fails a
  // production build if this is ever true again.
  devMode: false
};
