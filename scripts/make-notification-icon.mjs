/* Android notification small icon: white silhouette on transparent.
   A full-colour icon renders as a grey square in the status bar. */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <circle cx="256" cy="120" r="34" fill="#fff"/>
  <rect x="104" y="228" width="304" height="56" rx="28" fill="#fff"/>
  <circle cx="256" cy="392" r="34" fill="#fff"/>
</svg>`;
const DENSITIES = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ['--no-sandbox'] });
for (const [d, size] of Object.entries(DENSITIES)) {
  const dir = `android/app/src/main/res/drawable-${d}`;
  mkdirSync(dir, { recursive: true });
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body></html>`);
  writeFileSync(`${dir}/ic_stat_mindsharp.png`, await p.screenshot({ omitBackground: true }));
  await p.close();
  console.log(`  drawable-${d}/ic_stat_mindsharp.png  ${size}x${size}`);
}
await b.close();
