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
if (/analytics\s*:\s*\{\s*enabled\s*:\s*false/.test(config)) {
  problems.push('public/js/config.js — analytics disabled; the funnel will record nothing.');
}

if (problems.length) {
  console.error('✗ Production guards FAILED:\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('✓ production guards pass');
