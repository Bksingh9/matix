import http from 'node:http';

/* A minimal stand-in for Supabase's PostgREST endpoint.
 *
 * Enough of the wire protocol to drive the real supabase-js client through the
 * real webhook handler: the point is to exercise api/webhooks/lemonsqueezy.js
 * as written, not a re-implementation of it. */
export async function fakeSupabase(seed = {}) {
  const tables = {
    profiles: [],
    entitlements: [],
    webhook_events: [],
    runs: [],
    attempts: [],
    drills: [],
    ...seed
  };
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = await readBody(req);
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });

    // auth/v1/user — token verification
    if (url.pathname === '/auth/v1/user') {
      const auth = req.headers.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      const user = tables.__tokens?.[token];
      if (!user) return send(res, 401, { message: 'invalid token' });
      return send(res, 200, user);
    }

    const m = url.pathname.match(/^\/rest\/v1\/([\w.]+)$/);
    if (!m) return send(res, 404, { message: 'not found' });
    const name = m[1];
    const rows = tables[name] || (tables[name] = []);
    const prefer = String(req.headers.prefer || '');
    const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object+json');

    if (req.method === 'POST') {
      const incoming = Array.isArray(body) ? body : [body];
      const upsert = prefer.includes('merge-duplicates') || url.searchParams.has('on_conflict');
      const conflictKey = url.searchParams.get('on_conflict') || 'id';
      const out = [];
      for (const row of incoming) {
        const existing = rows.find(r => r[conflictKey] !== undefined && r[conflictKey] === row[conflictKey]);
        if (existing) {
          if (!upsert) {
            // PostgREST reports a unique violation as 409 with the SQLSTATE.
            return send(res, 409, { code: '23505', message: `duplicate key value violates unique constraint on ${name}`, details: null, hint: null });
          }
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const created = { id: rows.length + 1, ...row };
          rows.push(created);
          out.push(created);
        }
      }
      if (prefer.includes('return=minimal')) return send(res, 201, null);
      return send(res, 201, wantsObject ? (out[0] ?? null) : out);
    }

    let matched = rows.filter(r => matches(r, url.searchParams));

    if (req.method === 'GET') {
      if (url.searchParams.has('limit')) matched = matched.slice(0, Number(url.searchParams.get('limit')));
      if (String(req.headers.prefer || '').includes('count=exact')) {
        res.setHeader('Content-Range', `0-${Math.max(0, matched.length - 1)}/${matched.length}`);
      }
      if (wantsObject) {
        if (matched.length === 0) return send(res, 406, { code: 'PGRST116', message: 'no rows', details: 'Results contain 0 rows' });
        return send(res, 200, matched[0]);
      }
      return send(res, 200, matched);
    }

    if (req.method === 'PATCH') {
      for (const r of matched) Object.assign(r, body);
      return send(res, 200, wantsObject ? (matched[0] ?? null) : matched);
    }

    if (req.method === 'DELETE') {
      for (const r of matched) rows.splice(rows.indexOf(r), 1);
      return send(res, 200, matched);
    }

    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    return send(res, 405, { message: 'method not allowed' });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tables,
    requests,
    close: () => new Promise(r => server.close(r))
  };
}

/* Translate the subset of PostgREST filter syntax the app actually uses. */
function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (['select', 'limit', 'offset', 'order', 'on_conflict', 'columns'].includes(key)) continue;
    const [op, ...rest] = String(raw).split('.');
    const value = rest.join('.');
    const cell = row[key];
    if (op === 'eq' && String(cell) !== value) return false;
    if (op === 'neq' && String(cell) === value) return false;
    if (op === 'ilike' && String(cell ?? '').toLowerCase() !== value.replace(/%/g, '').toLowerCase()) return false;
    if (op === 'is' && !(value === 'null' ? cell == null : String(cell) === value)) return false;
    if (op === 'gte' && !(new Date(cell) >= new Date(value))) return false;
  }
  return true;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === null ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise(r => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return r(null);
      try { r(JSON.parse(s)); } catch { r(s); }
    });
  });
}

/* Node's http req/res are what Vercel hands a function, so the handlers can be
   driven directly with a tiny pair of fakes. */
export function mockReq({ method = 'POST', url = '/', headers = {}, body = null, raw = null } = {}) {
  const chunks = raw != null ? [Buffer.from(raw)] : (body != null ? [Buffer.from(JSON.stringify(body))] : []);
  const listeners = {};
  const req = {
    method, url,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    socket: { remoteAddress: '203.0.113.10' },
    on(evt, fn) { (listeners[evt] ||= []).push(fn); return req; },
    destroy() { },
    _flush() {
      queueMicrotask(() => {
        for (const c of chunks) (listeners.data || []).forEach(f => f(c));
        (listeners.end || []).forEach(f => f());
      });
    }
  };
  // readRaw attaches its listeners synchronously, so emit on the next tick.
  queueMicrotask(() => req._flush());
  return req;
}

export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    writeHead(status, hdrs) { res.statusCode = status; Object.assign(res.headers, hdrs || {}); return res; },
    end(payload) {
      res.body = payload;
      try { res.json = payload ? JSON.parse(payload) : null; } catch { res.json = null; }
      res._resolve?.(res);
    }
  };
  res.done = new Promise(r => { res._resolve = r; });
  return res;
}
