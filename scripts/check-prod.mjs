#!/usr/bin/env node
/* Production-only guards.

   Runs on production deploys (VERCEL_ENV=production) or when forced with
   FORCE_PROD_CHECK=1. Preview and local builds skip it so the dev Pro
   preview stays usable while you are still building. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const isProd = process.env.VERCEL_ENV === 'production' || process.env.FORCE_PROD_CHECK === '1';

if (!isProd) {
  console.log('· production guards skipped (VERCEL_ENV=' + (process.env.VERCEL_ENV || 'unset') + ')');
  process.exit(0);
}

const problems = [];
const read = p => readFileSync(join(ROOT, p), 'utf8');

// 1. The dev Pro preview is a free Pro button. It must be off in production.
const config = read('public/js/config.js');
if (/devMode\s*:\s*true/.test(config)) {
  problems.push('public/js/config.js — devMode is true. That ships a free "Preview Pro" button.');
}

// 2. Anything that flips S.pro outside setPro() re-opens the client-side
//    entitlement hole the whole payment system exists to close.
for (const f of ['public/js/paywall.js', 'public/js/main.js', 'public/js/engine.js', 'public/js/ui.js', 'public/js/drills.js']) {
  let src;
  try { src = read(f); } catch { continue; }
  const re = /S\.pro\s*=(?!=)/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${f}:${line} — direct write to S.pro. Entitlement comes from the server via setPro().`);
  }
}

// 3. Analytics must actually be on, or the funnel is blind.
if (/analytics\s*:\s*\{[\s\S]{0,80}enabled\s*:\s*false/.test(config)) {
  problems.push('public/js/config.js — analytics disabled; the funnel will record nothing.');
}

// 4. The merchant of record requires these, and so does anyone deciding
//    whether to type a card number into your site.
for (const page of ['public/legal/terms.html', 'public/legal/privacy.html', 'public/legal/refunds.html']) {
  try { read(page); } catch { problems.push(`${page} is missing — the merchant of record requires it before you can sell.`); }
}

// 5. The paywall must not promise a feature that isn't wired up. Selling
//    something that doesn't exist is the fastest route to a refund.
try {
  const html = read('public/index.html');
  if (/Drills built from your own misses/i.test(html)) {
    const drillsWired = read('public/js/drills.js').includes('/api/drills');
    if (!drillsWired) problems.push('public/index.html — the paywall promises drills, but drills.js does not call /api/drills.');
  }
} catch { /* checked elsewhere */ }

if (problems.length) {
  console.error('✗ Production guards FAILED:\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('✓ production guards pass');
