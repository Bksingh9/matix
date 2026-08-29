#!/usr/bin/env node
/* Render Play's 1024x500 feature graphic.
 *
 * Built from the app's own theme tokens rather than drawn separately, so the
 * banner cannot drift from what the app looks like — the usual failure mode
 * for store art is a graphic made once and never updated.
 *
 * Play crops this differently across surfaces and may overlay a play button in
 * the centre, so nothing load-bearing goes dead-centre or near an edge.
 */
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store/assets');
const themes = await readFile(join(ROOT, 'public/css/themes.css'), 'utf8');

const html = `<!DOCTYPE html><html data-theme="ember"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
${themes}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1024px;height:500px;overflow:hidden;display:flex;align-items:center;gap:60px;padding:0 72px;
  font-family:'Bricolage Grotesque',system-ui,sans-serif;color:var(--ink);
  background:radial-gradient(120% 90% at 78% -20%,var(--bg-glow),transparent 60%),var(--bg);}
.copy{flex:1;min-width:0}
.wm{font-weight:800;font-size:60px;letter-spacing:-.03em;line-height:1}
.wm span{color:var(--amber)}
.tag{font-family:'Space Mono',monospace;font-size:19px;line-height:1.5;color:var(--ink-dim);margin-top:18px;max-width:26ch}
.modes{font-family:'Space Mono',monospace;font-size:12.5px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--ink-faint);margin-top:26px}
.grid{display:grid;grid-template-columns:repeat(3,86px);grid-template-rows:repeat(3,86px);gap:14px;flex:none}
.t{border-radius:20px;background:var(--surface);box-shadow:var(--lift)}
.t.on{background:var(--amber);box-shadow:0 0 0 3px var(--amber),0 14px 40px -10px rgba(255,180,58,.6)}
</style></head><body>
<div class="copy">
  <div class="wm">MIND<span>SHARP</span></div>
  <div class="tag">Find the arithmetic that is costing you time. Then drill it.</div>
  <div class="modes">8 modes · daily challenge · offline</div>
</div>
<div class="grid">
  <div class="t on"></div><div class="t"></div><div class="t on"></div>
  <div class="t"></div><div class="t on"></div><div class="t"></div>
  <div class="t on"></div><div class="t"></div><div class="t"></div>
</div>
</body></html>`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'domcontentloaded' });
// The webfont may not resolve on an offline box; the layout holds either way.
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'play-feature-1024x500.png') });
await browser.close();
console.log('✓ store/assets/play-feature-1024x500.png (1024×500)');
