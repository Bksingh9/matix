import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

/* Serves public/ and lets a test stub /api/* responses. */
export async function serve(apiHandler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (apiHandler) {
        const body = await readBody(req);
        const out = await apiHandler(url.pathname, req.method, body, url);
        if (out) {
          res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out.body ?? {}));
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not_found"}');
      return;
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(PUBLIC, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    try {
      await stat(file);
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function readBody(req) {
  return new Promise(r => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { r(s ? JSON.parse(s) : null); } catch { r(s); }
    });
  });
}

/* PW_CHROMIUM lets CI (and this sandbox) point at a Chromium that does not
   match the npm package's pinned build number. */
export async function launch() {
  const executablePath = process.env.PW_CHROMIUM || undefined;
  return chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

export const FREE_ME = {
  authed: false, user: null,
  entitlement: { isPro: false, plan: 'free', status: 'none', currentPeriodEnd: null, cancelAtPeriodEnd: false },
  limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: 5 },
  hasRuns: false, serverTime: new Date().toISOString()
};

export const proMe = (over = {}) => ({
  ...FREE_ME,
  authed: true,
  user: { id: 'u-test-0001', email: 'player@example.com', displayName: null },
  entitlement: { isPro: true, plan: 'yearly', status: 'active', currentPeriodEnd: '2099-01-01T00:00:00Z', cancelAtPeriodEnd: false },
  limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: null },
  hasRuns: true,
  ...over
});

/* Opens the app with a per-context /api/* stub, so entitlement can be driven
   from the server side exactly as it is in production. Fails loudly on any
   console error or unhandled rejection — an unbundled ES-module app fails
   silently otherwise.

   opts.api  map of pathname -> {status, body} | (request) => {status, body}
   opts.pro  sugar for a Pro /api/me
   opts.apiDown  every /api/* call fails at the network level */
export async function openApp(browser, origin, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });

  const routes = {
    '/api/config': { status: 200, body: { supabaseUrl: null, supabaseAnonKey: null, authEnabled: false, checkoutEnabled: false, appUrl: null } },
    '/api/me': { status: 200, body: opts.pro ? proMe() : FREE_ME },
    ...(opts.api || {})
  };

  const calls = [];
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let payload = null;
    try { payload = req.postData() ? JSON.parse(req.postData()) : null; } catch { payload = req.postData(); }
    calls.push({ path, method: req.method(), body: payload });

    if (opts.apiDown) return route.abort('connectionrefused');

    let entry = routes[path];
    if (typeof entry === 'function') entry = await entry({ path, method: req.method(), body: payload });
    if (!entry) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    return route.fulfill({
      status: entry.status || 200,
      contentType: 'application/json',
      body: JSON.stringify(entry.body ?? {})
    });
  });

  const page = await ctx.newPage();
  const errors = [];
  // Only application errors. Sub-resource load failures are ignored: this
  // sandbox has no outbound network, so the Google Fonts <link> always fails
  // and says nothing about the app.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__mindsharp && !!window.__mindsharp.S, null, { timeout: 8000 });
  // Wait for the entitlement round-trip to land, so tests never race it.
  await page.waitForFunction(() => window.__mindsharp.S.pro === true || window.__mindsharp.booted === true, null, { timeout: 8000 }).catch(() => {});
  return { page, ctx, errors, calls };
}

/* The settings block is a collapsed <details>; open it before clicking in. */
export async function openSettings(page) {
  await page.evaluate(() => { document.querySelector('details.settings').open = true; });
  await page.waitForSelector('#ops .op-chip', { state: 'visible' });
}

/* Answers whatever problem is on screen, correctly, until the run ends or we
   hit `max` problems. Returns how many it answered. */
export async function playCorrectly(page, max = 8) {
  let n = 0;
  for (; n < max; n++) {
    const st = await page.evaluate(() => {
      const p = window.__mindsharp.S && window.__mindsharp.S.problem;
      return { screen: window.__mindsharp.S.screen, kind: p && p.kind, answer: p && p.answer, pool: p && p.pool, locked: window.__mindsharp.S.locked, memorizing: window.__mindsharp.S.memorizing };
    });
    if (st.screen !== 'game') break;
    if (st.locked || st.memorizing || !st.kind) { await page.waitForTimeout(60); n--; continue; }

    if (st.kind === 'pad' || st.kind === 'recall') {
      for (const ch of String(st.answer)) await page.click(`#panel-pad .key[data-key="${ch}"]`);
      const still = await page.evaluate(() => !window.__mindsharp.S.locked);
      if (still) await page.click('#panel-pad .key.enter');
    } else if (st.kind === 'tf') {
      await page.click(`#panel-tf .bigkey[data-tf="${st.answer}"]`);
    } else if (st.kind === 'ops') {
      await page.click(`#panel-ops .opkey[data-op="${cssEsc(st.answer)}"]`);
    } else if (st.kind === 'chips') {
      const idxs = await page.evaluate(() => {
        const p = window.__mindsharp.S.problem;
        // greedy subset that hits the target exactly; the generator guarantees one exists
        const target = p.answer, pool = p.pool, out = [];
        const seen = new Set();
        const rec = (i, sum, acc) => {
          if (sum === target) { out.push(acc.slice()); return true; }
          if (i >= pool.length || sum > target) return false;
          acc.push(i); if (rec(i + 1, sum + pool[i], acc)) return true; acc.pop();
          return rec(i + 1, sum, acc);
        };
        rec(0, 0, []);
        return out[0] || [];
      });
      for (const i of idxs) await page.click(`#panel-chips .chipkey[data-i="${i}"]`);
    }
    await page.waitForTimeout(340);
  }
  return n;
}

const cssEsc = s => s === '*' ? '*' : s;

export async function snapshotState(page) {
  return page.evaluate(() => {
    const S = window.__mindsharp.S;
    return {
      screen: S.screen, game: S.game, score: S.score, solved: S.solved,
      correct: S.correct, wrong: S.wrong, pro: S.pro, isDaily: S.isDaily,
      statsSolved: S.stats.solved, ops: JSON.parse(JSON.stringify(S.stats.ops))
    };
  });
}
