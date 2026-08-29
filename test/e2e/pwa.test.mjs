import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly } from './helpers.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/* Phase 9: installable, offline-capable, and prompting at a moment the player
   is actually receptive to. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const read = p => readFileSync(resolve(ROOT, p), 'utf8');

const runOnce = async (page, answers = 2) => {
  await page.click('.gcard[data-game="zen"]');
  await page.waitForSelector('#screen-game.active');
  await playCorrectly(page, answers);
  await page.click('#zen-end');
  await page.waitForSelector('#screen-results.active');
  // The XP panel animates in and shifts the layout, so a real click on a
  // button below it fails Playwright's stability check. Dispatch instead.
  await page.waitForSelector('#r-xp.show', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('#r-menu').click());
  await page.waitForSelector('#screen-menu.active');
};

describe('the manifest', () => {
  test('is served and parses', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    const r = await page.request.get(srv.origin + '/manifest.webmanifest');
    assert.equal(r.status(), 200);
    const m = JSON.parse(await r.text());
    assert.equal(m.name.startsWith('MindSharp'), true);
    assert.equal(m.display, 'standalone');
    // Relative, so the app can be hosted in a subdirectory. What matters is
    // that it stays same-origin and still marks PWA launches.
    assert.equal(/^https?:/.test(m.start_url), false, 'start_url must stay same-origin');
    assert.match(m.start_url, /source=pwa/);
    await ctx.close();
  });

  test('has the icon sizes the stores and launchers need', async () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    const sizes = m.icons.map(i => i.sizes);
    for (const need of ['192x192', '512x512']) {
      assert.ok(sizes.includes(need), `missing ${need}`);
    }
    // Without a maskable icon, Android crops the square one into a circle and
    // clips the mark.
    assert.ok(m.icons.some(i => i.purpose === 'maskable'), 'no maskable icon');
  });

  test('every declared icon actually exists and is a PNG', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    const m = JSON.parse(read('public/manifest.webmanifest'));
    for (const icon of m.icons) {
      const r = await page.request.get(new URL(icon.src, srv.origin + '/manifest.webmanifest').href);
      assert.equal(r.status(), 200, `${icon.src} is 404`);
      const buf = await r.body();
      assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${icon.src} is not a PNG`);
      assert.ok(buf.length > 500, `${icon.src} is suspiciously small`);
    }
    await ctx.close();
  });

  test('shortcuts point at real launch intents', async () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    assert.ok(m.shortcuts?.length >= 1);
    // './?go=blitz' or '/?go=blitz' — both launch correctly; the point is that
    // each one names a mode the app actually has.
    for (const s of m.shortcuts) assert.match(s.url, /^\.?\/\?go=\w+$/);
  });

  test('the page links the manifest and the iOS icon', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    assert.equal(await page.locator('link[rel="manifest"]').count(), 1);
    // iOS ignores the manifest entirely and uses apple-touch-icon.
    assert.equal(await page.locator('link[rel="apple-touch-icon"]').count(), 1);
    assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').count(), 1);
    assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit=cover/);
    await ctx.close();
  });
});

describe('the service worker', () => {
  test('is served with a JS content type', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    const r = await page.request.get(srv.origin + '/sw.js');
    assert.equal(r.status(), 200);
    assert.match(r.headers()['content-type'] || '', /javascript/);
    await ctx.close();
  });

  test('never caches the API — a stale entitlement is worse than none', () => {
    const sw = read('public/sw.js');
    assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
    // The guard must return before any caching path.
    const guardAt = sw.indexOf("startsWith('/api/')");
    const cacheAt = sw.indexOf('caches.open(RUNTIME)');
    assert.ok(guardAt > 0 && guardAt < cacheAt, 'the /api/ bail-out comes first');
  });

  test('precaches every client module, so nothing 404s offline', () => {
    const sw = read('public/sw.js');
    const listed = new Set([...sw.matchAll(/'\.?\/js\/([\w.-]+\.js)'/g)].map(m => m[1]));
    const actual = readdirSync(resolve(ROOT, 'public/js')).filter(f => f.endsWith('.js'));
    const missing = actual.filter(f => !listed.has(f));
    assert.deepEqual(missing, [], `service worker shell is missing: ${missing.join(', ')}`);
  });

  test('only precaches files that exist', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    const sw = read('public/sw.js');
    const urls = [...sw.matchAll(/^\s*'(\.?\/[^']*)',?$/gm)].map(m => m[1]);
    for (const u of urls) {
      // Shell entries resolve against the worker's scope, which is the root here.
      const r = await page.request.get(new URL(u, srv.origin + '/').href);
      assert.equal(r.status(), 200, `precache entry ${u} does not exist`);
    }
    await ctx.close();
  });

  test('bumps its cache name with the version', () => {
    const sw = read('public/sw.js');
    assert.match(sw, /const VERSION = 'v\d+'/);
    assert.match(sw, /mindsharp-shell-\$\{VERSION\}/);
  });
});

describe('the install prompt', () => {
  /* Chromium does not fire beforeinstallprompt under test, so the event is
     synthesised. What is being tested is our timing policy, not the browser's. */
  const fireInstallable = page => page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.__promptCalled = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });

  test('does not interrupt someone who has just arrived', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await fireInstallable(page);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#install-banner.show').count(), 0,
      'a prompt on arrival spends the one chance the browser gives us');
    await ctx.close();
  });

  test('appears once the player has played enough to want it', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await fireInstallable(page);
    for (let i = 0; i < 3; i++) await runOnce(page);
    await page.waitForSelector('#install-banner.show', { timeout: 6000 });
    assert.match(await page.locator('#install-banner').innerText(), /Install MindSharp/i);
    assert.match(await page.locator('#install-banner').innerText(), /offline/i);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('accepting calls the browser prompt', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await fireInstallable(page);
    for (let i = 0; i < 3; i++) await runOnce(page);
    await page.waitForSelector('#install-banner.show', { timeout: 6000 });
    await page.click('#install-go');
    await page.waitForFunction(() => window.__promptCalled === true, null, { timeout: 5000 });
    assert.equal(await page.locator('#install-banner.show').count(), 0, 'and the banner goes away');
    await ctx.close();
  });

  test('dismissing is remembered across reloads', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await fireInstallable(page);
    for (let i = 0; i < 3; i++) await runOnce(page);
    await page.waitForSelector('#install-banner.show', { timeout: 6000 });
    await page.click('#install-dismiss');
    assert.equal(await page.locator('#install-banner.show').count(), 0);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    await fireInstallable(page);
    await runOnce(page);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#install-banner.show').count(), 0, 'asked once, not every session');
    await ctx.close();
  });

  test('a standalone launch never shows it', async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    // Make the page believe it is already installed before any script runs.
    await ctx.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = q => q.includes('standalone') ? { matches: true, addEventListener() {}, removeEventListener() {} } : real(q);
    });
    await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authed: false, entitlement: { isPro: false, plan: 'free', status: 'none' }, limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: 5 } }) }));
    const page = await ctx.newPage();
    await page.goto(srv.origin + '/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    for (let i = 0; i < 3; i++) await runOnce(page);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#install-banner.show').count(), 0);
    await ctx.close();
  });
});

describe('launch shortcuts', () => {
  test('?go=daily opens the daily challenge directly', async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authed: false, entitlement: { isPro: false, plan: 'free', status: 'none' }, limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: 5 } }) }));
    const page = await ctx.newPage();
    await page.goto(srv.origin + '/?go=daily', { waitUntil: 'networkidle' });
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.__mindsharp.S.isDaily), true);
    // and the query string is cleaned up so a reload does not re-trigger
    assert.equal(await page.evaluate(() => location.search), '');
    await ctx.close();
  });

  test('?go=blitz opens blitz', async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authed: false, entitlement: { isPro: false, plan: 'free', status: 'none' }, limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: 5 } }) }));
    const page = await ctx.newPage();
    await page.goto(srv.origin + '/?go=blitz', { waitUntil: 'networkidle' });
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.__mindsharp.S.game), 'blitz');
    await ctx.close();
  });

  test('an unknown or hostile ?go is ignored', async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authed: false, entitlement: { isPro: false, plan: 'free', status: 'none' }, limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: 5 } }) }));
    const page = await ctx.newPage();
    await page.goto(srv.origin + '/?go=__proto__', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    assert.equal(await page.locator('#screen-menu.active').count(), 1, 'stays on the menu');
    await ctx.close();
  });
});
