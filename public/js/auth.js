import { S } from './state.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { runtimeConfig } from './api.js';

/* Supabase magic-link auth.

   The SDK is loaded from a CDN on demand: there is no bundler, and a signed-out
   player must never pay the download cost for a library they are not using.
   If the import fails (offline, blocked CDN), the game stays fully playable —
   it just cannot sign in. */

const SUPABASE_ESM = 'https://esm.sh/@supabase/supabase-js@2.45.4';

let client = null;
let clientPromise = null;
let session = null;
const listeners = new Set();

export const onAuthChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => { try { fn(session); } catch (e) { /* isolate */ } });

async function getClient() {
  if (client) return client;
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const cfg = await runtimeConfig();
    if (!cfg.authEnabled || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
    const { createClient } = await import(SUPABASE_ESM);
    client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    });
    return client;
  })().catch(err => {
    console.warn('[auth] unavailable:', err && err.message);
    return null;
  });
  return clientPromise;
}

export async function initAuth() {
  const c = await getClient();
  if (!c) { S.authed = false; S.user = null; return null; }

  const { data } = await c.auth.getSession();
  applySession(data?.session || null);

  c.auth.onAuthStateChange((_evt, s) => {
    const wasAnon = !session;
    applySession(s || null);
    emit();
    if (wasAnon && s) track('sign_in', { method: 'magic_link' });
  });

  // A magic link lands with tokens in the URL hash. detectSessionInUrl
  // consumes them; strip the remains so a shared or bookmarked URL never
  // carries a session token.
  if (location.hash.includes('access_token') || location.search.includes('code=')) {
    history.replaceState(null, '', location.pathname);
  }
  return session;
}

function applySession(s) {
  session = s;
  S.authed = !!s;
  S.user = s?.user ? { id: s.user.id, email: s.user.email || null } : null;
}

export async function getAccessToken() {
  if (session?.access_token) {
    // Refresh a token that is about to expire, or /api/* rejects the call.
    const expMs = (session.expires_at || 0) * 1000;
    if (!expMs || expMs - Date.now() > 30_000) return session.access_token;
  }
  const c = await getClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  applySession(data?.session || null);
  return session?.access_token || null;
}

export const isAuthed = () => !!session;

/* ---- sign in / out --------------------------------------------------- */

export async function sendMagicLink(email) {
  const c = await getClient();
  if (!c) throw new Error('auth_unavailable');
  const { error } = await c.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname }
  });
  if (error) throw error;
  track('magic_link_sent', {});
}

export async function signOut() {
  const c = await getClient();
  if (c) { try { await c.auth.signOut(); } catch (e) { /* clear locally anyway */ } }
  applySession(null);
  emit();
  track('sign_out', {});
}

/* ---- sign-in sheet --------------------------------------------------- */

export function openAuthSheet(src, reason) {
  const m = $('#authm');
  if (!m) return;
  $('#auth-msg').innerHTML = '';
  $('#auth-reason').textContent = reason
    || 'Sign in to keep your streak, sync across devices, and hold your Pro subscription to an account instead of a browser.';
  $('#auth-email').value = S.user?.email || '';
  m.classList.add('show');
  setTimeout(() => $('#auth-email').focus(), 60);
  track('auth_view', { source: src || 'menu' });
}

export const closeAuthSheet = () => { const m = $('#authm'); if (m) m.classList.remove('show'); };

const authNote = (html, err) => { $('#auth-msg').innerHTML = '<div class="notice' + (err ? ' err' : '') + '">' + html + '</div>'; };

export async function submitAuthSheet() {
  const email = ($('#auth-email').value || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { authNote('That doesn’t look like an email address.', true); return; }

  const btn = $('#auth-send');
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  btn.disabled = true;
  try {
    await sendMagicLink(email);
    authNote('Check <b>' + escapeHtml(email) + '</b> for a sign-in link. It works once and expires in an hour.');
  } catch (e) {
    if (e && e.message === 'auth_unavailable') {
      authNote('Accounts aren’t configured on this deployment yet. The game works fine without one — your progress stays in this browser.', true);
    } else {
      authNote('Couldn’t send the link: ' + escapeHtml((e && e.message) || 'unknown error') + '. Try again in a moment.', true);
    }
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
