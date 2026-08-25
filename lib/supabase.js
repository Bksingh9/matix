import { createClient } from '@supabase/supabase-js';

/* SERVER ONLY. The service-role key bypasses row-level security, which means
   it can grant itself Pro. It exists so /api/webhooks and /api/runs can write
   rows the client is forbidden to write, and for nothing else. Never import
   this module from anything under public/. */

let admin = null;

export function supabaseAdmin() {
  if (admin) return admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'mindsharp-server' } }
  });
  return admin;
}

/* A client bound to a caller's access token. Every query through it is subject
   to RLS as that user — the right tool for reads we want the database to
   police for us. */
export function supabaseAsUser(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

export function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
