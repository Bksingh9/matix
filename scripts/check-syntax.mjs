#!/usr/bin/env node
/* Parse-check every JS file, then verify that every named import actually
   exists in the module it comes from.

   The second check is the useful one: the client is unbundled ES modules with
   no type system, so a rename in ui.js silently breaking engine.js would
   otherwise only surface as a blank page in a browser. */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SKIP = new Set(['node_modules', '.git', '.vercel', 'reference', 'coverage']);
const ID = '[A-Za-z_$][A-Za-z0-9_$]*';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (extname(p) === '.js' || extname(p) === '.mjs') out.push(p);
  }
  return out;
}

/* Every name a module makes importable. */
function exportsOf(src) {
  const names = new Set();
  let m;
  const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var)\\s+(${ID})`, 'g');
  while ((m = decl.exec(src))) names.add(m[1]);
  const list = /export\s*\{([^}]*)\}/g;
  while ((m = list.exec(src))) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  if (/export\s+\*\s+from/.test(src)) names.add('*');
  return names;
}

const files = walk(ROOT);
const problems = [];

// 1. syntax
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { problems.push(`syntax  ${relative(ROOT, f)}\n    ${String(e.stderr || e.message).split('\n').slice(0, 3).join('\n    ')}`); }
}

// 2. linkage
const cache = new Map();
const srcOf = f => { if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8')); return cache.get(f); };
const known = new Set(files);

for (const f of files) {
  const src = srcOf(f);
  const rel = relative(ROOT, f);
  const importRe = new RegExp(`import\\s+((?:${ID}\\s*,\\s*)?\\{[^}]*\\}|\\*\\s+as\\s+${ID}|${ID})?\\s*(?:from\\s*)?['"](\\.[^'"]+)['"]`, 'g');
  let m;
  while ((m = importRe.exec(src))) {
    const target = resolve(dirname(f), m[2]);
    if (!known.has(target)) { problems.push(`import  ${rel} → "${m[2]}" does not resolve to a file in this repo`); continue; }
    const braces = (m[1] || '').match(/\{([^}]*)\}/);
    if (!braces) continue;
    const avail = exportsOf(srcOf(target));
    if (avail.has('*')) continue; // re-export star: can't verify statically
    for (const part of braces[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (!n) continue;
      if (!avail.has(n)) problems.push(`import  ${rel} imports { ${n} } from "${m[2]}" — not exported there`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error('✗ ' + p);
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log(`✓ ${files.length} JS files parse; all named imports resolve`);
