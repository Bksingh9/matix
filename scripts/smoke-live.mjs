#!/usr/bin/env node
/* Play the deployed site in a real browser.
 *
 * The e2e suite proves the code works against a local server. This proves the
 * thing people actually visit works — which is a different claim, and the one
 * that catches a broken deploy: a missing asset, a wrong base path, a service
 * worker serving a stale shell, a host that 404s on a clean URL.
 *
 * Run by the Pages workflow immediately after deploying, so a bad deploy is a
 * red run rather than a bug report.
 *
 * Usage:  node scripts/smoke-live.mjs https://example.github.io/matix/
 */
import { chromium } from 'playwright';

const url = process.argv[2] || process.env.SMOKE_URL;
if (!url) {
  console.error('✗ usage: node scripts/smoke-live.mjs <url>');
  process.exit(1);
}
const base = url.endsWith('/') ? url : url + '/';

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/* Chromium does not read HTTPS_PROXY the way curl does, so on a network that
   only reaches the internet through a proxy it fails with CONNECTION_RESET
   while every other tool works. Pass it through explicitly when one is set. */
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(proxyUrl ? { proxy: { server: proxyUrl } } : {})
});
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();

const jsErrors = [];
const broken = [];
page.on('pageerror', e => jsErrors.push(String(e)));
page.on('console', m => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) jsErrors.push(m.text());
});
page.on('response', r => {
  // /api/* 404s by design on a static host — the client reads that as
  // "anonymous, free". Anything else 4xx/5xx is a broken deploy.
  const p = new URL(r.url()).pathname;
  if (r.status() >= 400 && !p.includes('/api/') && r.request().resourceType() !== 'font') {
    broken.push(`${r.status()} ${p}`);
  }
});

try {
  const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check(resp?.status() === 200, 'the page is served', `HTTP ${resp?.status()}`);

  await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 20000 });
  check(true, 'the app boots');

  // Entitlement must resolve to free with no backend. A static deploy that
  // somehow reported Pro would be the worst possible failure, so assert it.
  const pro = await page.evaluate(() => window.__mindsharp.S.pro);
  check(pro === false, 'entitlement falls back to free, never Pro');

  // Play for real. Rendering the menu proves very little.
  await page.click('.gcard[data-game="blitz"]');
  await page.waitForSelector('#screen-game.active', { timeout: 10000 });
  for (let i = 0; i < 5; i++) {
    const answer = await page.evaluate(() => String(window.__mindsharp.S.problem?.answer ?? ''));
    if (!answer) break;
    for (const ch of answer.replace('-', '')) {
      await page.click(`#panel-pad .key[data-key="${ch}"]`).catch(() => {});
    }
    await page.waitForTimeout(150);
  }
  const played = await page.evaluate(() => ({ solved: window.__mindsharp.S.solved, correct: window.__mindsharp.S.correct }));
  check(played.solved > 0, 'a real round plays', `${played.correct}/${played.solved} correct`);

  const swScopes = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map(r => r.scope));
  check(swScopes.length > 0, 'the service worker registers', swScopes[0]);
  check(swScopes[0]?.startsWith(base), 'its scope covers the deploy path');

  for (const [label, path] of [
    ['the manifest', 'manifest.webmanifest'],
    ['the terms page', 'legal/terms.html'],
    ['the privacy page', 'legal/privacy.html']
  ]) {
    const r = await page.request.get(base + path);
    check(r.status() === 200, `${label} is served`, `HTTP ${r.status()}`);
  }

  const manifest = await (await page.request.get(base + 'manifest.webmanifest')).json();
  check(!!manifest.icons?.length && manifest.display === 'standalone',
    'the manifest is installable', `${manifest.icons?.length} icons`);

  check(broken.length === 0, 'no broken requests', broken.slice(0, 5).join(', ') || 'none');
  check(jsErrors.length === 0, 'no console errors', jsErrors.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  check(false, 'smoke run completed', e.message);
} finally {
  await ctx.close();
  await browser.close();
}

console.log('');
if (failures.length) {
  console.error(`✗ the deployed site is broken: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`✓ ${base} is live and playable`);
