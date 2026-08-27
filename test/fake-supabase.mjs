import http from 'node:http';
import { Readable } from 'node:stream';

/* A minimal stand-in for Supabase's PostgREST endpoint.
 *
 * Enough of the wire protocol to drive the real supabase-js client through the
 * real webhook handler: the point is to exercise api/webhooks/lemonsqueezy.js
 * as written, not a re-implementation of it. */
/* Relative to now, never a literal: a seeded date that drifts into the past
   makes a passing test start failing on a calendar boundary. */
const isoDay = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

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
  const failing = new Set();

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

    /* auth/v1/admin/users/:id — account deletion.
     *
     * Emulates the `on delete cascade` in the schema, because that cascade is
     * the entire deletion: the handler deletes one auth user and trusts the
     * database to take the rest. A fake that dropped only the auth row would
     * let a missing cascade pass its test. */
    const del = url.pathname.match(/^\/auth\/v1\/admin\/users\/([\w-]+)$/);
    if (del && req.method === 'DELETE') {
      const uid = del[1];
      const users = (tables.__users ||= []);
      const i = users.findIndex(u => u.id === uid);
      if (i === -1) return send(res, 404, { message: 'User not found' });
      users.splice(i, 1);

      // Every table whose user_id references auth.users(id).
      for (const t of ['profiles', 'entitlements', 'runs', 'attempts', 'drills',
                       'daily_scores', 'player_progress', 'achievements',
                       'league_members', 'league_standing']) {
        const key = t === 'profiles' ? 'id' : 'user_id';
        tables[t] = (tables[t] || []).filter(r => r[key] !== uid);
      }
      return send(res, 200, {});
    }

    // RPC: the two SECURITY DEFINER helpers, emulated well enough that the
    // handlers exercise their real code paths.
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) {
      const fn = rpc[1];
      if (fn === 'bump_rate_limit') {
        const b = body || {};
        const row = (tables.rate_limits ||= []).find(r => r.bucket === b.p_bucket);
        if (!row) { tables.rate_limits.push({ bucket: b.p_bucket, count: 1, window_start: Date.now() }); return send(res, 200, true); }
        row.count += 1;
        return send(res, 200, row.count <= b.p_limit);
      }
      if (fn === 'insert_run_with_attempts') {
        const b = body || {};
        const runs = (tables.runs ||= []);
        const isDaily = b.p_run?.is_daily === true;
        if (isDaily && runs.some(r => r.user_id === b.p_user_id && r.daily_date === b.p_run.daily_date && r.is_daily)) {
          return send(res, 409, { code: '23505', message: 'duplicate key value violates runs_one_daily_per_user_per_day' });
        }
        const id = runs.length + 1;
        runs.push({ id, user_id: b.p_user_id, ...b.p_run });
        const attempts = (tables.attempts ||= []);
        for (const a of (b.p_attempts || [])) attempts.push({ id: attempts.length + 1, run_id: id, user_id: b.p_user_id, ...a });
        return send(res, 200, id);
      }
      if (fn === 'current_season') {
        const seasons = (tables.league_seasons ||= []);
        return send(res, 200, seasons.length ? seasons[0].id : null);
      }
      if (fn === 'join_league') {
        const b = body || {};
        const seasons = (tables.league_seasons ||= []);
        const groups = (tables.league_groups ||= []);
        const mem = (tables.league_members ||= []);
        const seasonId = seasons.length ? seasons[0].id : (seasons.push({ id: 1, starts_on: isoDay(-3), ends_on: isoDay(3) }), 1);
        const seasonGroupIds = new Set(groups.filter(g => g.season_id === seasonId).map(g => g.id));

        const existing = mem.find(m => m.user_id === b.p_user_id && seasonGroupIds.has(m.group_id));
        if (existing) return send(res, 200, existing.group_id);

        const tier = (tables.league_standing || []).find(s => s.user_id === b.p_user_id)?.tier ?? 1;
        const size = b.p_size ?? 30;
        // Fullest group with room, so groups complete rather than scattering.
        const candidates = groups
          .filter(g => g.season_id === seasonId && g.tier === tier)
          .map(g => ({ g, n: mem.filter(m => m.group_id === g.id).length }))
          .filter(x => x.n < size)
          .sort((a, z) => z.n - a.n);
        let groupId = candidates[0]?.g.id;
        if (groupId === undefined) {
          groupId = groups.length ? Math.max(...groups.map(g => g.id)) + 1 : 1;
          groups.push({ id: groupId, season_id: seasonId, tier });
        }
        mem.push({ group_id: groupId, user_id: b.p_user_id, xp: 0, joined_at: new Date().toISOString() });
        return send(res, 200, groupId);
      }
      if (fn === 'add_league_xp') {
        const b = body || {};
        const mem = (tables.league_members ||= []);
        const row = mem.find(m => m.user_id === b.p_user_id);
        if (row) row.xp += b.p_xp || 0;
        return send(res, 200, null);
      }
      if (fn === 'settle_season') {
        const b = body || {};
        const groups = (tables.league_groups || []).filter(g => g.season_id === b.p_season_id);
        const ids = new Set(groups.map(g => g.id));
        const rows = (tables.league_members || []).filter(m => ids.has(m.group_id));
        const standing = (tables.league_standing ||= []);
        for (const g of groups) {
          const inGroup = rows.filter(m => m.group_id === g.id).sort((a, z) => z.xp - a.xp);
          inGroup.forEach((m, i) => {
            const size = inGroup.length;
            const result = size >= 10 && i < 5 ? 'promoted'
              : size >= 10 && i >= size - 5 && m.xp === 0 ? 'relegated' : 'held';
            const tier = result === 'promoted' ? Math.min(5, g.tier + 1)
              : result === 'relegated' ? Math.max(1, g.tier - 1) : g.tier;
            const prev = standing.find(s => s.user_id === m.user_id);
            if (prev) Object.assign(prev, { tier, last_result: result });
            else standing.push({ user_id: m.user_id, tier, last_result: result });
          });
        }
        return send(res, 200, rows.length);
      }
      return send(res, 404, { message: `function ${fn} not found` });
    }

    const m = url.pathname.match(/^\/rest\/v1\/([\w.]+)$/);
    if (!m) return send(res, 404, { message: 'not found' });
    const name = m[1];
    // Injected failure, for testing what happens when one table is unreachable.
    // A thrown exception here would hang the request instead of answering it.
    if (failing.has(name)) return send(res, 500, { code: 'XX000', message: `${name} is unavailable` });
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

    // HEAD is how supabase-js asks for a count without the rows
    // ({ count: 'exact', head: true }), so it must go through the same
    // filtering and report the same Content-Range.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const total = matched.length;
      if (url.searchParams.has('limit')) matched = matched.slice(0, Number(url.searchParams.get('limit')));
      if (prefer.includes('count=exact') || url.searchParams.has('count')) {
        res.setHeader('Content-Range', total ? `0-${total - 1}/${total}` : `*/0`);
      }
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(); }
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

    return send(res, 405, { message: 'method not allowed' });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tables,
    requests,
    fail: name => failing.add(name),
    unfail: name => failing.delete(name),
    close: () => new Promise(r => server.close(r))
  };
}

/* Translate the subset of PostgREST filter syntax the app actually uses.
 *
 * An unrecognised operator is reported loudly rather than ignored. A filter
 * that silently becomes a no-op makes a wrong query pass its test — which is
 * how a "settle finished seasons" endpoint ends up settling the live one. */
const KNOWN_OPS = new Set(['eq', 'neq', 'ilike', 'like', 'is', 'gt', 'gte', 'lt', 'lte', 'in']);

function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (['select', 'limit', 'offset', 'order', 'on_conflict', 'columns'].includes(key)) continue;
    const [op, ...rest] = String(raw).split('.');
    const value = rest.join('.');
    const cell = row[key];

    if (!KNOWN_OPS.has(op)) {
      throw new Error(`fake-supabase: unsupported filter "${key}=${raw}". Add it to matches() rather than letting it pass silently.`);
    }

    if (op === 'eq' && String(cell) !== value) return false;
    if (op === 'neq' && String(cell) === value) return false;
    if (op === 'ilike' || op === 'like') {
      if (!likeMatch(String(cell ?? ''), value, op === 'ilike')) return false;
    }
    if (op === 'is' && !(value === 'null' ? cell == null : String(cell) === value)) return false;
    if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map(v => v.replace(/^"|"$/g, ''));
      if (!list.includes(String(cell))) return false;
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
      const a = cmpValue(cell), b = cmpValue(value);
      if (op === 'gt' && !(a > b)) return false;
      if (op === 'gte' && !(a >= b)) return false;
      if (op === 'lt' && !(a < b)) return false;
      if (op === 'lte' && !(a <= b)) return false;
    }
  }
  return true;
}

/* Real SQL LIKE, not "strip the wildcards and compare". The old version made
   `like('bucket', '%:<uuid>')` match nothing while looking like it worked —
   a delete that quietly removes no rows is exactly the kind of no-op this
   fake is supposed to catch. */
function likeMatch(cell, pattern, insensitive) {
  const rx = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')   // regex metacharacters
    .replace(/%/g, '.*')                      // SQL wildcards
    .replace(/_/g, '.');
  return new RegExp(`^${rx}$`, insensitive ? 'i' : '').test(cell);
}

/* Dates compare as dates, numbers as numbers, everything else as strings. */
function cmpValue(v) {
  if (v == null) return -Infinity;
  if (typeof v === 'number') return v;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s);
  const n = Number(s);
  return Number.isFinite(n) && s.trim() !== '' ? n : s;
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
   driven directly with a tiny pair of fakes.
 *
 * A real Readable, not a hand-rolled emitter: a handler that awaits something
 * else before reading its body (the licence route rate-limits first) would
 * otherwise miss the data events entirely and hang forever. */
export function mockReq({ method = 'POST', url = '/', headers = {}, body = null, raw = null } = {}) {
  const chunks = raw != null ? [Buffer.from(raw)] : (body != null ? [Buffer.from(JSON.stringify(body))] : []);
  const req = Readable.from(chunks, { objectMode: false });
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  req.socket = { remoteAddress: '203.0.113.10' };
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
