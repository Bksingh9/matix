import { ok, methodGuard } from '../lib/http.js';

/* Public runtime config for the browser.

   The client is unbundled ES modules with no build step, so there is nowhere
   to inject the Supabase URL and anon key at compile time. This endpoint hands
   them over instead. Both are safe in a browser by design: the anon key is
   the public key, and row-level security is what actually protects the data.

   The service-role key is never read here. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  ok(res, {
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    authEnabled: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    checkoutEnabled: !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID),
    appUrl: process.env.APP_URL || null
  });
}
