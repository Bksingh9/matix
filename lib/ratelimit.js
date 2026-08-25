import { supabaseAdmin } from './supabase.js';

/* Rate limiting backed by a Postgres counter.

   Serverless functions share no memory, and a cold start resets an in-process
   limiter — which is exactly the moment a brute-forcer benefits. The counter
   lives in the database so the window survives restarts and applies across
   every instance.

   `bump_rate_limit` returns true when the call is within budget. */
export async function allow(bucket, limit, windowSeconds) {
  try {
    const { data, error } = await supabaseAdmin().rpc('bump_rate_limit', {
      p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds
    });
    if (error) throw error;
    return data === true;
  } catch (e) {
    // Fail open. A limiter outage must not take the product down; the
    // endpoints it protects all have a second line of defence (auth, HMAC
    // signatures, or Lemon Squeezy's own throttling).
    console.error('[ratelimit] backend unavailable, allowing:', e.message);
    return true;
  }
}

/* Standard budgets. The licence endpoint is the strict one: it is the only
   route where guessing a value gets you a paid product. */
export const LIMITS = {
  licence: { limit: 5, window: 600 },      // 5 per 10 min — spec §5
  checkout: { limit: 20, window: 600 },
  runs: { limit: 120, window: 600 },
  read: { limit: 240, window: 600 }
};

export async function guard(res, kind, ...keys) {
  const { limit, window } = LIMITS[kind] || LIMITS.read;
  for (const key of keys.filter(Boolean)) {
    if (!(await allow(`${kind}:${key}`, limit, window))) return false;
  }
  return true;
}
