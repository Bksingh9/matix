#!/usr/bin/env node
/* Prove a deployed URL is serving THIS commit, file for file.
 *
 * `npm run smoke` plays the deployed site and answers "does it work". This
 * answers a different question that the smoke test cannot: "is it serving
 * what I think it is". Those come apart on any CDN, and the failure is nasty
 * because it is partial — a fresh index.html against a stale module is a
 * version mix that boots fine and misbehaves somewhere you are not looking.
 *
 * Found in practice: raw.githack.com on a BRANCH url served a current
 * index.html alongside a theme.js three commits old, converging one file at a
 * time over several minutes. The same host on a COMMIT url (rawcdn.githack.com,
 * sha in the path) was byte-exact immediately, because it is immutable.
 * That is the difference between a demo link and a deploy.
 *
 * Usage:  npm run verify:deploy -- <base-url>
 *         npm run verify:deploy            (derives the pinned githack url)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');

/* The last commit that touched public/, NOT HEAD. A commit that only edits the
   README or a script does not change what is deployed, and bumping the pinned
   url for it would invalidate a link that is still perfectly correct — and
   point at a sha that may not be pushed yet. */
export const publicSha = () =>
  execSync('git log -1 --format=%H -- public', { cwd: ROOT }).toString().trim();

export const pinnedUrl = sha => `https://rawcdn.githack.com/Bksingh9/matix/${sha}/public/`;

const sha = publicSha();
const base = (process.argv.find(a => a.startsWith('http')) || pinnedUrl(sha)).replace(/\/*$/, '/');

/* --check-link only compares the README's pinned sha with the one above. It
   needs no network, so it can run in `npm run check` alongside the other
   guards; the full fetch stays opt-in. */
if (process.argv.includes('--check-link')) {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/rawcdn\.githack\.com\/Bksingh9\/matix\/([0-9a-f]{7,40})\/public\//);
  if (!m) { console.error('✗ README has no pinned play url'); process.exit(1); }
  if (!sha.startsWith(m[1])) {
    console.error(`✗ the README's play url points at ${m[1].slice(0, 8)}, but public/ last changed in ${sha.slice(0, 8)}`);
    console.error(`  players would get a stale build. Update it to:\n    ${pinnedUrl(sha)}index.html`);
    process.exit(1);
  }
  console.log(`✓ the README's play url points at the current public/ (${sha.slice(0, 8)})`);
  process.exit(0);
}

const walk = d => readdirSync(d).flatMap(f => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const md5 = b => createHash('md5').update(b).digest('hex');

/* An ES-module app is one wrong Content-Type away from a blank page: a module
   served as text/plain is refused outright. Checked for the types that matter,
   ignored for the rest. */
const REQUIRED_TYPE = { '.js': /javascript|ecmascript/, '.css': /text\/css/, '.html': /text\/html/ };

const files = walk(PUB).map(p => relative(PUB, p).split('\\').join('/')).sort();
console.log(`commit ${sha.slice(0, 8)}  →  ${base}`);
console.log(`${files.length} files to check\n`);

let missing = 0, stale = 0, wrongType = 0;

for (const f of files) {
  const want = readFileSync(join(PUB, f));
  let res;
  try {
    res = await fetch(new URL(f, base), { redirect: 'follow' });
  } catch (e) {
    console.log(`  ✗ ${f} — unreachable (${e.message})`);
    missing++; continue;
  }
  if (!res.ok) { console.log(`  ✗ ${f} — HTTP ${res.status}`); missing++; continue; }

  const got = Buffer.from(await res.arrayBuffer());
  if (md5(got) !== md5(want)) {
    console.log(`  ✗ ${f} — serving different bytes (${got.length}B live vs ${want.length}B local)`);
    stale++; continue;
  }

  const ext = f.slice(f.lastIndexOf('.'));
  const need = REQUIRED_TYPE[ext];
  if (need && !need.test(res.headers.get('content-type') || '')) {
    console.log(`  ✗ ${f} — Content-Type "${res.headers.get('content-type')}" will not load as ${ext}`);
    wrongType++;
  }
}

const bad = missing + stale + wrongType;
if (bad) {
  console.error(`\n✗ ${bad} problem(s): ${missing} missing, ${stale} stale, ${wrongType} wrong type`);
  if (stale) console.error('  Stale files usually mean a mutable (branch or tag) URL. Pin to a commit sha.');
  process.exit(1);
}
console.log(`✓ all ${files.length} files match this commit, and every module type will load`);
