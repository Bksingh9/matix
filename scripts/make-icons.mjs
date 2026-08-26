#!/usr/bin/env node
/* Generates the PWA and store icon set from one SVG source.
 *
 * Rendered with the Chromium that already ships for the e2e tests rather than
 * adding an image library: one dependency fewer, and the output is exactly
 * what a browser would draw.
 *
 *   node scripts/make-icons.mjs            # PWA icons into public/icons
 *   PW_CHROMIUM=/path/to/chromium node scripts/make-icons.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'public', 'icons');
const STORE = join(ROOT, 'store', 'assets');

/* The mark: MindSharp's amber on the app's own background. A lightning glyph
   over a division sign — speed and arithmetic, which is the whole product. */
const icon = ({ padding = 0.14, radius = 0.22, bg = true } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffc75c"/>
      <stop offset="100%" stop-color="#e08a1e"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="18%" r="70%">
      <stop offset="0%" stop-color="#2b1f13"/>
      <stop offset="100%" stop-color="#16120c"/>
    </radialGradient>
  </defs>
  ${bg ? `<rect width="512" height="512" rx="${512 * radius}" fill="url(#glow)"/>` : ''}
  <g transform="translate(256 256) scale(${1 - padding * 2}) translate(-256 -256)">
    <circle cx="256" cy="120" r="26" fill="url(#g)"/>
    <rect x="120" y="234" width="272" height="44" rx="22" fill="url(#g)"/>
    <circle cx="256" cy="392" r="26" fill="url(#g)"/>
  </g>
</svg>`;

/* A maskable icon has to survive being cropped to a circle, so everything sits
   well inside the 80% safe zone and the background bleeds to the edges. */
const maskable = () => icon({ padding: 0.28, radius: 0 });

const SIZES = [
  { name: 'icon-192.png', size: 192, svg: icon() },
  { name: 'icon-256.png', size: 256, svg: icon() },
  { name: 'icon-384.png', size: 384, svg: icon() },
  { name: 'icon-512.png', size: 512, svg: icon() },
  { name: 'maskable-192.png', size: 192, svg: maskable() },
  { name: 'maskable-512.png', size: 512, svg: maskable() },
  // iOS ignores the manifest and uses this one; it must not be transparent.
  { name: 'apple-touch-icon.png', size: 180, svg: icon({ radius: 0 }) }
];

const STORE_SIZES = [
  // Play Store listing icon, and the App Store marketing icon.
  { name: 'play-store-512.png', size: 512, svg: icon({ radius: 0 }) },
  { name: 'app-store-1024.png', size: 1024, svg: icon({ radius: 0 }) }
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(STORE, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    for (const [dir, list] of [[OUT, SIZES], [STORE, STORE_SIZES]]) {
      for (const { name, size, svg } of list) {
        const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
        await page.setContent(
          `<html><body style="margin:0;background:transparent">
             <div style="width:${size}px;height:${size}px">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</div>
           </body></html>`,
          { waitUntil: 'load' });
        const buf = await page.screenshot({ omitBackground: true });
        writeFileSync(join(dir, name), buf);
        await page.close();
        console.log(`  ${name.padEnd(24)} ${size}x${size}`);
      }
    }

    // The favicon stays SVG: it scales, and every browser that matters supports it.
    writeFileSync(join(ROOT, 'public', 'favicon.svg'), icon({ radius: 0.22 }).trim() + '\n');
    console.log('  favicon.svg              vector');
  } finally {
    await browser.close();
  }
  console.log('\n✓ icons written to public/icons and store/assets');
}

main().catch(e => { console.error(e); process.exit(1); });
