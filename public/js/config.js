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
  analytics: { enabled: true },
  // Phase 6 flips this to false and `npm run check:prod` enforces it.
  devMode: true
};
