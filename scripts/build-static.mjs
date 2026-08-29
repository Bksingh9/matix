#!/usr/bin/env node
/* Build a static, host-anywhere copy of public/.
 *
 * There is almost nothing to do, and that is the point: every asset path in
 * public/ is relative, so the app runs from any directory on any host without
 * being rebuilt for it. This adds only the things a *particular* host needs.
 *
 * What it does:
 *   - 404.html, a copy of index.html. A static host has no server-side
 *     rewrite, so without it a deep link 404s instead of opening the game.
 *   - .nojekyll, or GitHub Pages hides directories beginning with underscore.
 *   - restores the .html on legal links if --clean-urls is off... it isn't:
 *     the links already carry the extension, and Vercel redirects them to the
 *     clean form. One form, both hosts.
 *   - optionally repoints /api/* at a real backend.
 *
 * /api/* is left alone by default, pointing at a path that 404s on a static
 * host. That is deliberate: the client already treats an unreachable API as
 * "anonymous, free", which is the correct reading for a demo, and it never
 * falls back to Pro.
 *
 * Usage:
 *   node scripts/build-static.mjs
 *   node scripts/build-static.mjs --api=https://mindsharp.vercel.app
 */
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const OUT = join(ROOT, 'dist');

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const API = arg('api').replace(/\/+$/, '');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

/* Guard the property the whole approach rests on. A root-absolute asset path
   would work on Vercel and silently 404 everywhere else, which is exactly the
   bug this build is meant to make impossible. */
const walk = dir => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const offenders = [];
for (const file of walk(OUT)) {
  if (!['.html', '.js', '.webmanifest', '.css'].includes(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(OUT.length + 1);

  for (const m of text.matchAll(/(?:href|src)="(\/[^/][^"]*)"/g)) offenders.push(`${rel}: ${m[1]}`);
  // '/api/' is the one root-absolute path we keep on purpose.
  for (const m of text.matchAll(/["'`](\/(?!api\/)[a-z][\w./-]*)["'`]/g)) offenders.push(`${rel}: ${m[1]}`);

  if (API) {
    const out = text.replace(/(["'`])\/api\//g, `$1${API}/api/`);
    if (out !== text) writeFileSync(file, out);
  }
}

if (offenders.length) {
  console.error('✗ root-absolute paths found — these break on any host that is not a domain root:\n');
  for (const o of offenders.slice(0, 20)) console.error(`   ${o}`);
  process.exit(1);
}

// A static host has no rewrite rule, so an unmatched path must still land here.
cpSync(join(OUT, 'index.html'), join(OUT, '404.html'));
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`✓ dist/ built  (api="${API || 'none — anonymous demo'}")`);
