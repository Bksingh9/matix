#!/usr/bin/env node
/* Fails the build if anything that must stay on the server appears in a file
   that ships to the browser.

   The Lemon Squeezy API key in client code would let anyone issue refunds and
   read every customer record. The Supabase service-role key bypasses RLS
   entirely, which means it can grant itself Pro. Neither ever goes near
   public/. */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCAN = ['public'];
const TEXT = new Set(['.js', '.mjs', '.html', '.css', '.json', '.svg', '.txt', '.map', '.webmanifest']);

/* Each rule is [label, pattern]. Patterns match the *name* as well as a
   plausible literal value, because both are fatal. */
const RULES = [
  ['Supabase service-role key name', /SUPABASE_SERVICE_ROLE|SERVICE_ROLE_KEY|service_role/i],
  ['Lemon Squeezy API key name', /LEMONSQUEEZY_API_KEY|LEMON_SQUEEZY_API_KEY/i],
  ['Lemon Squeezy webhook secret', /LEMONSQUEEZY_WEBHOOK_SECRET/i],
  ['a JWT with the service_role claim', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/],
  ['a Lemon Squeezy API token literal', /\beyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9\.[A-Za-z0-9_-]{200,}/],
  ['a process.env read (public/ has no server env)', /process\s*\.\s*env\b/],
  ['a Supabase secret key literal', /\bsb_secret_[A-Za-z0-9_-]{10,}/]
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.has(extname(p))) out.push(p);
  }
  return out;
}

const findings = [];
for (const dir of SCAN) {
  for (const f of walk(join(ROOT, dir))) {
    const src = readFileSync(f, 'utf8');
    for (const [label, re] of RULES) {
      const m = src.match(re);
      if (!m) continue;
      const line = src.slice(0, m.index).split('\n').length;
      findings.push(`${relative(ROOT, f)}:${line} — ${label}`);
    }
  }
}

if (findings.length) {
  console.error('✗ Secrets check FAILED. These must never ship to the browser:\n');
  for (const f of findings) console.error('  ' + f);
  console.error('\nMove the value behind an /api/* function and read it there.');
  process.exit(1);
}
console.log('✓ no server-only secrets found under public/');
