import { supabaseAdmin } from './supabase.js';

/* Verify a bearer token and return the user, or null.
   `getUser(jwt)` on the service-role client asks Supabase Auth to validate the
   token — signature, expiry, and revocation. Decoding the JWT locally would
   skip revocation, which means a signed-out session would keep working until
   it expired. */
export async function userFromRequest(req) {
  const token = bearer(req);
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

export function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/* Keep profiles.email current. The webhook falls back to matching a purchase
   email against this column when custom_data.user_id is missing, so a stale
   value there costs someone their purchase. */
export async function touchProfile(user) {
  try {
    await supabaseAdmin().from('profiles').upsert({
      id: user.id,
      email: user.email || null,
      last_seen_at: new Date().toISOString()
    }, { onConflict: 'id' });
  } catch { /* never fail a request over a bookkeeping write */ }
}
