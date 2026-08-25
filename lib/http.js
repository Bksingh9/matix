/* Shared request/response plumbing for the api/* functions. */

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export const ok = (res, body) => json(res, 200, body);
export const badRequest = (res, msg, extra) => json(res, 400, { error: msg || 'bad_request', ...extra });
export const unauthorized = res => json(res, 401, { error: 'auth_required' });
export const forbidden = res => json(res, 403, { error: 'pro_required' });
export const tooMany = (res, retryAfter) => {
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  json(res, 429, { error: 'rate_limited', retryAfter: retryAfter || null });
};
export const serverError = (res, id) => json(res, 500, { error: 'server_error', ref: id || null });

export function methodGuard(req, res, allowed) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (list.includes(req.method)) return true;
  res.setHeader('Allow', list.join(', '));
  json(res, 405, { error: 'method_not_allowed' });
  return false;
}

/* Vercel parses JSON bodies for us, but `vercel dev` and direct Node hosting
   do not always, so accept either. Never use this on the webhook route — that
   one needs the raw bytes for the HMAC. */
export async function readJson(req, limitBytes = 512 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  const raw = await readRaw(req, limitBytes);
  if (!raw.length) return null;
  try { return JSON.parse(raw.toString('utf8')); } catch { return null; }
}

export function readRaw(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Client IP behind Vercel's proxy. x-forwarded-for is attacker-controllable in
   general, but on Vercel the platform overwrites it, so the leftmost entry is
   the real peer. Used only for rate limiting. */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/* Correlation id for a failure the client should not see the detail of. */
export const errorRef = () => Math.random().toString(36).slice(2, 10);
