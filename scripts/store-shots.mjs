#!/usr/bin/env node
/* Capture store screenshots from the real app.
 *
 * Both stores reject screenshots that are not exactly the declared device
 * size, and both let you upload art that never appears in the product. These
 * are the actual game at the actual pixel sizes: the app is driven to each
 * screen and photographed, so a listing shot cannot drift from what installs.
 *
 * Your spec's §8 asks for "screenshots (per device size)". The sizes below are
 * the ones the consoles ask for; check the current requirements before upload,
 * since both stores revise them.
 *
 * Usage:  node scripts/store-shots.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(ROOT, 'store/screenshots');

const MIME = {
  '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json'
};

/* Device sizes the consoles ask for. Play wants 16:9 or 9:16 phone shots;
   Apple wants exact pixel sizes per device class and will reject anything else. */
const DEVICES = [
  { id: 'play-phone',   w: 1080, h: 1920, scale: 3, note: 'Play Store phone' },
  { id: 'ios-6.7',      w: 1290, h: 2796, scale: 3, note: 'iPhone 6.7"' },
  { id: 'ios-6.5',      w: 1242, h: 2688, scale: 3, note: 'iPhone 6.5"' },
  { id: 'ipad-12.9',    w: 2048, h: 2732, scale: 2, note: 'iPad Pro 12.9"' }
];

/* One shot per selling point, not five of the same screen. Each names the
   theme it is taken in, so the set shows the app is themeable without a
   screenshot that only says "we have themes". */
const SHOTS = [
  { id: '1-modes',  theme: 'clay',   what: 'menu' },
  { id: '2-matrix', theme: 'neon',   what: 'matrix' },
  { id: '3-play',   theme: 'ember',  what: 'blitz' },
  { id: '4-daily',  theme: 'aurora', what: 'menu' },
  { id: '5-bold',   theme: 'bold',   what: 'matrix' }
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (p.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
  try {
    const f = join(PUBLIC, p);
    await stat(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1']
});

let count = 0;
for (const dev of DEVICES) {
  for (const shot of SHOTS) {
    // Render at CSS pixels, then scale up — a phone is ~390 CSS px wide, and
    // screenshotting at 1080 wide would lay the page out as a tablet.
    const cssW = Math.round(dev.w / dev.scale);
    const cssH = Math.round(dev.h / dev.scale);
    const ctx = await browser.newContext({
      viewport: { width: cssW, height: cssH },
      deviceScaleFactor: dev.scale
    });
    const page = await ctx.newPage();
    await page.addInitScript(t => localStorage.setItem('mindsharp:theme', t), shot.theme);
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 20000 });

    if (shot.what !== 'menu') {
      await page.click(`.gcard[data-game="${shot.what}"]`);
      await page.waitForSelector('#screen-game.active', { timeout: 8000 });
      if (shot.what === 'matrix') {
        // Catch it mid-reveal: the lit pattern is the thing that makes someone
        // understand the game from a thumbnail.
        await page.waitForSelector('#panel-grid .tile.lit', { timeout: 5000 }).catch(() => {});
      } else {
        // Put a few points on the board so it is not a screenshot of zero.
        for (let i = 0; i < 3; i++) {
          const a = await page.evaluate(() => String(window.__mindsharp.S.problem?.answer ?? ''));
          for (const ch of a.replace('-', '')) await page.click(`#panel-pad .key[data-key="${ch}"]`).catch(() => {});
          await page.waitForTimeout(140);
        }
      }
      await page.waitForTimeout(200);
    }

    const file = join(OUT, `${dev.id}--${shot.id}.png`);
    await page.screenshot({ path: file });
    count++;
    await ctx.close();
  }
  console.log(`✓ ${dev.id}  ${dev.w}×${dev.h}  (${dev.note})`);
}

await browser.close();
server.close();
console.log(`\n✓ ${count} screenshots in store/screenshots/`);
