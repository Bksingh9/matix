import { getAccessToken } from './auth.js';

/* Thin fetch wrapper for /api/*. Attaches the Supabase access token when there
   is one, and turns non-2xx into a typed error the callers can branch on. */

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `http_${status}`);
    this.status = status;
    this.body = body || {};
    this.code = (body && body.error) || `http_${status}`;
  }
}

async function request(method, path, body, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (opts.auth !== false) {
    const token = await getAccessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 12000);
  try {
    const r = await fetch(path, {
      method, headers, signal: ctl.signal,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const get = (path, opts) => request('GET', path, undefined, opts);
export const post = (path, body, opts) => request('POST', path, body ?? {}, opts);

/* Public runtime config, fetched once. See api/config.js for why it exists. */
let cfgPromise = null;
export function runtimeConfig() {
  if (!cfgPromise) {
    cfgPromise = request('GET', '/api/config', undefined, { auth: false, timeoutMs: 6000 })
      .catch(() => ({ authEnabled: false, checkoutEnabled: false, supabaseUrl: null, supabaseAnonKey: null }));
  }
  return cfgPromise;
}
