import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import http from 'node:http';
import { blockWebfonts } from './helpers.mjs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

/* The Content-Security-Policy, enforced.
 *
 * CSP lives in vercel.json, so it is absent from every other test: they serve
 * public/ with no headers at all. That makes it the classic "works locally,
 * dead in production" defect — a policy that blocks the app's own scripts
 * looks perfect until deploy.
 *
 * These tests serve the real files with the real policy attached. */

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp'
};

const csp = (() => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  for (const b of cfg.headers || []) {
    for (const h of b.headers || []) if (h.key === 'Content-Security-Policy') return h.value;
  }
  return null;
})();

let srv, origin, browser;
before(async () => {
  srv = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    try {
      const f = join(PUBLIC, p === '/' ? '/index.html' : p);
      await stat(f);
      res.writeHead(200, {
        'Content-Type': MIME[extname(f)] || 'application/octet-stream',
        'Content-Security-Policy': csp        // the whole point of this file
      });
      res.end(await readFile(f));
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${srv.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
});
after(async () => { await browser?.close(); srv?.close(); });

describe('content security policy', () => {
  test('is actually configured', () => {
    assert.ok(csp, 'no CSP header in vercel.json');
    // The directives whose absence is the difference between a policy and a
    // decoration.
    for (const d of ['default-src', 'script-src', 'object-src', 'frame-ancestors', 'base-uri']) {
      assert.match(csp, new RegExp(d), `missing ${d}`);
    }
    assert.equal(/script-src[^;]*'unsafe-eval'/.test(csp), false, "script-src must not allow 'unsafe-eval'");
    assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false,
      "script-src must not allow 'unsafe-inline' — that is most of what CSP is for");
  });

  test('the inline theme script is allowed by hash, and the hash is current', () => {
    /* The boot snippet must run before the stylesheet or every launch shows a
       frame of the wrong theme. It is allowed by hash rather than by
       'unsafe-inline', which means editing it invalidates the hash — and the
       failure would appear only in production. This is the guard. */
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    // Exact text content, newlines included — that is what the browser
    // hashes, and trimming produces a hash it will reject.
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(inline, 'the inline theme boot script is gone');
    const hash = createHash('sha256').update(inline[1]).digest('base64');
    assert.ok(csp.includes(`'sha256-${hash}'`),
      `the CSP hash is stale — re-run scripts/check-csp.mjs. Expected sha256-${hash}`);
  });

  test('the app boots under the policy with no violations', async () => {
    const ctx = await blockWebfonts(await browser.newContext({ viewport: { width: 420, height: 900 } }));
    const page = await ctx.newPage();
    const violations = [];
    page.on('console', m => {
      const t = m.text();
      if (/Content Security Policy|Refused to/i.test(t)) violations.push(t);
    });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 20000 });

    assert.deepEqual(violations, [], 'the policy blocks the app itself');
    assert.ok(await page.evaluate(() => !!document.documentElement.dataset.theme),
      'the inline theme script ran');
    await ctx.close();
  });

  test('a game is playable under the policy', async () => {
    const ctx = await blockWebfonts(await browser.newContext({ viewport: { width: 420, height: 900 } }));
    const page = await ctx.newPage();
    const violations = [];
    page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 20000 });
    await page.click('.gcard[data-game="matrix"]');
    await page.waitForSelector('#panel-grid.show', { timeout: 8000 });
    assert.deepEqual(violations, []);
    await ctx.close();
  });
});
