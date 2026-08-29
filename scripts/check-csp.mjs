#!/usr/bin/env node
/* Keep the CSP's inline-script hash in step with the script it allows.
 *
 * index.html carries one inline script: the theme boot, which must run before
 * the stylesheet or every launch shows a frame of the wrong theme. CSP allows
 * it by hash rather than by 'unsafe-inline' — allowing all inline script would
 * give up most of what the policy is for.
 *
 * The cost of a hash is that editing the script invalidates it, and the
 * failure appears ONLY in production, where the header is actually served.
 * This recomputes it and either checks or fixes.
 *
 * The hash is over the element's exact text content — every byte between the
 * tags, including the newlines. Trimming produces a hash the browser will
 * reject, which is the mistake this script exists to stop anyone repeating.
 *
 * Usage:  node scripts/check-csp.mjs        # verify (exits 1 if stale)
 *         node scripts/check-csp.mjs --fix  # rewrite vercel.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fix = process.argv.includes('--fix');

const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

if (inline.length === 0) {
  console.log('✓ no inline scripts — nothing to hash');
  process.exit(0);
}

const hashes = inline.map(src => 'sha256-' + createHash('sha256').update(src).digest('base64'));

const cfgPath = join(ROOT, 'vercel.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
let header = null;
for (const block of cfg.headers || []) {
  for (const h of block.headers || []) if (h.key === 'Content-Security-Policy') header = h;
}
if (!header) { console.error('✗ no Content-Security-Policy in vercel.json'); process.exit(1); }

const missing = hashes.filter(h => !header.value.includes(`'${h}'`));
if (missing.length === 0) {
  console.log(`✓ CSP allows all ${hashes.length} inline script(s) by hash`);
  process.exit(0);
}

if (!fix) {
  console.error('✗ the CSP hash is stale — the inline script changed.\n');
  for (const h of missing) console.error(`   needs '${h}'`);
  console.error('\n  Run: node scripts/check-csp.mjs --fix');
  process.exit(1);
}

// Replace any existing sha256- entries in script-src with the current set.
header.value = header.value.replace(/(script-src[^;]*?)(\s*'sha256-[^']+')*/,
  (_, head) => `${head} ${hashes.map(h => `'${h}'`).join(' ')}`);
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`✓ vercel.json updated with ${hashes.length} hash(es)`);
