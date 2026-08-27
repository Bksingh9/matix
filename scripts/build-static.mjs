#!/usr/bin/env node
/* Build a static, host-anywhere copy of public/.
 *
 * The app is written with absolute paths (/js/main.js, /css/app.css) because
 * that is what Vercel serves it as. A GitHub Pages *project* site lives under
 * /<repo>/, so every one of those paths 404s. This rewrites them.
 *
 * It also drops the two things only a server can do:
 *   - cleanUrls: Vercel serves /legal/terms from legal/terms.html. Pages does
 *     not, so links get the extension back.
 *   - /api/*: there is no backend on a static host. Left pointing at a path
 *     that 404s ON PURPOSE — the client already treats an unreachable API as
 *     "anonymous, free", which is exactly right for a demo. It never falls
 *     back to Pro. Pass --api=https://your-app.vercel.app to point a static
 *     build at a real backend instead.
 *
 * Usage:
 *   node scripts/build-static.mjs --base=/matix
 *   node scripts/build-static.mjs --base= --api=https://mindsharp.vercel.app
 */
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const OUT = join(ROOT, 'dist');

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
// Trailing slashes cause //double//slashes downstream; strip once here.
const BASE = (arg('base') || '').replace(/\/+$/, '');
const API = (arg('api') || '').replace(/\/+$/, '');

if (BASE && !BASE.startsWith('/')) {
  console.error(`✗ --base must start with a slash (got "${BASE}")`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

/* Rewrite a root-absolute path to sit under the base. Deliberately narrow:
   it only matches paths we actually ship, so it cannot mangle an unrelated
   string that happens to start with a slash. */
const DIRS = 'js|css|icons|legal|assets';
function rebase(text) {
  if (!BASE) return text;
  return text
    .replace(new RegExp(`(["'\`])/(${DIRS})/`, 'g'), `$1${BASE}/$2/`)
    .replace(/(["'`])\/(favicon\.svg|manifest\.webmanifest|index\.html|sw\.js)/g, `$1${BASE}/$2`)
    // A bare "/" is the site root: the service worker's shell entry and its
    // offline fallback, and the registration scope. Left alone it would cache
    // and serve the wrong origin root on a project site.
    .replace(/(["'`])\/\1/g, `$1${BASE}/$1`);
}

/* Vercel's cleanUrls serves /legal/terms; a static host needs the extension. */
const unclean = text => text.replace(/(\/legal\/(?:terms|privacy|refunds))(?!\.html)\b/g, '$1.html');

const walk = dir => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

let touched = 0;
for (const file of walk(OUT)) {
  const ext = extname(file);
  if (!['.html', '.js', '.webmanifest', '.json', '.css'].includes(ext)) continue;

  const before = readFileSync(file, 'utf8');
  let after = unclean(rebase(before));

  if (API && (ext === '.js')) {
    // Only the leading quote of a request path, so '/api/' inside a comment
    // or a cache rule is left alone.
    after = after.replace(/(["'`])\/api\//g, `$1${API}/api/`);
  }

  if (after !== before) { writeFileSync(file, after); touched++; }
}

/* The manifest's own keys are paths too, and Chrome refuses the install
   prompt if start_url falls outside scope. */
const mf = join(OUT, 'manifest.webmanifest');
if (existsSync(mf)) {
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  const root = BASE ? `${BASE}/` : '/';
  m.id = root;
  m.scope = root;
  m.start_url = `${root}?source=pwa`;
  for (const s of m.shortcuts || []) s.url = s.url.replace(/^\//, root);
  writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
}

/* A project site has no server-side rewrite, so a deep link like /matix/foo
   would 404. GitHub Pages serves 404.html for anything unmatched; making it
   the app means deep links still open the game. */
if (existsSync(join(OUT, 'index.html'))) {
  cpSync(join(OUT, 'index.html'), join(OUT, '404.html'));
}

// Jekyll would otherwise eat directories beginning with an underscore.
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`✓ dist/ built  (base="${BASE || '/'}", api="${API || 'none — anonymous demo'}", ${touched} files rewritten)`);
