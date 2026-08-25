#!/usr/bin/env node
/* Every funnel event must actually be fired from somewhere in the client.
 *
 * The monetisation plan's five numbers are built from these fourteen names. A
 * rename that nobody notices leaves a dashboard quietly reading zero, and you
 * only find out when you try to work out why the paywall isn't converting. */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const JS = join(ROOT, 'public', 'js');

const analytics = readFileSync(join(JS, 'analytics.js'), 'utf8');
const listed = [...analytics.matchAll(/'([a-z_]+)'/g)]
  .map(m => m[1])
  .filter(n => /^(app_open|game_start|game_end|daily_start|daily_end|limit_hit|paywall_view|plan_click|checkout_open|licence_ok|licence_fail|reward_watch|share_click|pro_active)$/.test(n));

const REQUIRED = [
  'app_open', 'game_start', 'game_end', 'daily_start', 'daily_end',
  'limit_hit', 'paywall_view', 'plan_click', 'checkout_open',
  'licence_ok', 'licence_fail', 'reward_watch', 'share_click', 'pro_active'
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (extname(p) === '.js') out.push(p);
  }
  return out;
}

const files = walk(JS).filter(f => !f.endsWith('analytics.js'));
const fired = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/track\(\s*'([a-z_]+)'/g)) {
    if (!fired.has(m[1])) fired.set(m[1], []);
    fired.get(m[1]).push(relative(ROOT, f));
  }
}

const problems = [];
for (const name of REQUIRED) {
  if (!fired.has(name)) problems.push(`"${name}" is never fired — a dashboard built on it will read zero`);
  if (!listed.includes(name)) problems.push(`"${name}" is missing from FUNNEL_EVENTS in analytics.js`);
}

if (problems.length) {
  for (const p of problems) console.error('✗ ' + p);
  process.exit(1);
}

const extra = [...fired.keys()].filter(n => !REQUIRED.includes(n));
console.log(`✓ all ${REQUIRED.length} funnel events are fired${extra.length ? ` (plus ${extra.length} product events: ${extra.sort().join(', ')})` : ''}`);
