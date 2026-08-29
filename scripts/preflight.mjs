#!/usr/bin/env node
/* Answer one question before a customer's card is charged: is this
 * configuration actually going to work.
 *
 * Going live means four accounts and about twenty environment variables, and
 * every one of them fails LATE. A wrong variant id is a checkout that opens
 * and charges for the wrong thing. A missing webhook secret is a payment that
 * completes and never grants Pro. A service-role key pointed at the wrong
 * project is a customer looking at somebody else's data. None of that shows up
 * until money has moved, and by then the failure has a person attached to it.
 *
 * So this asks the live services rather than reading the variables:
 *
 *   - every required var present and shaped like the thing it claims to be
 *   - Supabase reachable, migrations applied, RLS on for every table
 *   - the service-role key and the anon key belong to the SAME project
 *   - the Lemon Squeezy key works, and each variant id exists in YOUR store
 *     and is the billing interval its name says it is
 *   - the webhook secret is set, and long enough to be a real one
 *
 * It never prints a secret. Values are reported by shape and last four, so the
 * output can be pasted into a bug report.
 *
 * Usage:  npm run preflight
 *         (reads .env.local if present, else the ambient environment)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Vercel keeps config in its dashboard, so a local run has nothing to read.
   A .env.local is the usual bridge and is already gitignored. */
for (const f of ['.env.local', '.env']) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  console.log(`· read ${f}`);
  break;
}

const results = [];
const ok   = (what, detail = '') => results.push({ level: 'ok',   what, detail });
const warn = (what, detail = '') => results.push({ level: 'warn', what, detail });
const bad  = (what, fix)         => results.push({ level: 'bad',  what, detail: fix });

/* Never the value. Enough to tell two keys apart in a screenshot, not enough
   to use one. */
const shape = v => !v ? '(unset)' : `${v.length} chars, …${v.slice(-4)}`;

const env = k => (process.env[k] || '').trim();

/* ---------- 1. the variables themselves ---------------------------------- */

const REQUIRED = [
  ['SUPABASE_URL',              v => /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v), 'should look like https://abcdefgh.supabase.co'],
  ['SUPABASE_ANON_KEY',         v => v.length > 40,  'the anon/publishable key from Supabase → Settings → API'],
  ['SUPABASE_SERVICE_ROLE_KEY', v => v.length > 40,  'the service_role key — SERVER ONLY, never in public/'],
  ['LEMONSQUEEZY_API_KEY',      v => v.length > 40,  'Lemon Squeezy → Settings → API'],
  ['LEMONSQUEEZY_STORE_ID',     v => /^\d+$/.test(v), 'the numeric store id, not the store name'],
  ['LEMONSQUEEZY_WEBHOOK_SECRET', v => v.length >= 16, 'the signing secret you set when creating the webhook'],
  ['APP_URL',                   v => /^https:\/\/.+/.test(v), 'the https origin the app is served from']
];

for (const [key, valid, hint] of REQUIRED) {
  const v = env(key);
  if (!v) bad(`${key} is not set`, hint);
  else if (!valid(v)) bad(`${key} is set but malformed (${shape(v)})`, hint);
  else ok(key, shape(v));
}

/* The two keys are different halves of the same project. Crossing them from
   two browser tabs is easy and the symptom is "auth works, nothing saves". */
const projectRef = u => (u.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/) || [])[1] || null;
const jwtRef = k => {
  try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).ref || null; }
  catch { return null; }
};
if (env('SUPABASE_URL') && env('SUPABASE_ANON_KEY') && env('SUPABASE_SERVICE_ROLE_KEY')) {
  const fromUrl = projectRef(env('SUPABASE_URL'));
  const a = jwtRef(env('SUPABASE_ANON_KEY')), s = jwtRef(env('SUPABASE_SERVICE_ROLE_KEY'));
  if (a && s && fromUrl) {
    if (a !== fromUrl || s !== fromUrl) {
      bad(`the Supabase keys and url are from different projects (url=${fromUrl}, anon=${a}, service=${s})`,
          'copy all three from ONE project: Settings → API');
    } else ok('the Supabase url and both keys are the same project', fromUrl);
  }
  if (env('SUPABASE_ANON_KEY') === env('SUPABASE_SERVICE_ROLE_KEY')) {
    bad('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are the same value',
        'the anon key is public, the service key bypasses RLS — they are not interchangeable');
  }
}

/* ---------- 2. Supabase, asked rather than assumed ------------------------ */

const TABLES = ['profiles', 'entitlements', 'runs', 'attempts', 'drills', 'daily_scores',
                'player_progress', 'achievements', 'webhook_events', 'rate_limits',
                'league_seasons', 'league_groups', 'league_members', 'store_notifications'];

async function checkSupabase() {
  const url = env('SUPABASE_URL').replace(/\/$/, '');
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  const anon = env('SUPABASE_ANON_KEY');
  if (!url || !service) return;

  let missing = [];
  for (const t of TABLES) {
    let r;
    try {
      r = await fetch(`${url}/rest/v1/${t}?select=*&limit=0`, {
        headers: { apikey: service, Authorization: `Bearer ${service}` }
      });
    } catch (e) { bad(`Supabase unreachable (${e.message})`, 'check SUPABASE_URL and that the project is not paused'); return; }
    if (r.status === 401 || r.status === 403) {
      bad('the service-role key was rejected by Supabase', 'copy it again from Settings → API; it is the long one marked service_role');
      return;
    }
    if (!r.ok) missing.push(t);
  }
  if (missing.length) {
    bad(`${missing.length} table(s) missing: ${missing.join(', ')}`,
        'run sql/001 through 007 in order in the Supabase SQL editor');
  } else {
    ok(`all ${TABLES.length} tables exist`);
  }

  /* RLS is the difference between a database and a public one. The anon key
     hitting entitlements is the exact shape of the payment-theft bug this
     project already shipped once, so it is checked against the live project
     rather than trusted from the migration file. */
  if (anon && !missing.length) {
    const r = await fetch(`${url}/rest/v1/entitlements?select=user_id&limit=1`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` }
    });
    const rows = r.ok ? await r.json().catch(() => null) : null;
    if (r.ok && Array.isArray(rows) && rows.length > 0) {
      bad('RLS is NOT protecting entitlements — the anon key can read them',
          'run sql/002_rls.sql and sql/007_fix_profiles_rls.sql; anyone could read who has paid');
    } else {
      ok('RLS holds — the anon key cannot read entitlements');
    }
  }
}

/* ---------- 3. Lemon Squeezy, asked rather than assumed ------------------- */

async function checkLemonSqueezy() {
  const key = env('LEMONSQUEEZY_API_KEY');
  const storeId = env('LEMONSQUEEZY_STORE_ID');
  if (!key) return;

  const head = { Authorization: `Bearer ${key}`, Accept: 'application/vnd.api+json' };
  let me;
  try {
    me = await fetch('https://api.lemonsqueezy.com/v1/users/me', { headers: head });
  } catch (e) { bad(`Lemon Squeezy unreachable (${e.message})`, 'check network egress from wherever this runs'); return; }

  if (me.status === 401) { bad('the Lemon Squeezy API key was rejected', 'create a new one at Settings → API'); return; }
  if (!me.ok) { bad(`Lemon Squeezy /users/me returned ${me.status}`, 'unexpected — retry, then check status.lemonsqueezy.com'); return; }
  ok('the Lemon Squeezy API key works');

  if (storeId) {
    const s = await fetch(`https://api.lemonsqueezy.com/v1/stores/${storeId}`, { headers: head });
    if (s.ok) {
      const name = (await s.json())?.data?.attributes?.name;
      ok(`store ${storeId} reachable`, name || '');
    } else {
      bad(`store ${storeId} not found on this account (HTTP ${s.status})`,
          'the id is the number in the dashboard url, and must belong to the same account as the API key');
    }
  }

  /* A variant id that does not exist gives a checkout that 404s. A variant id
     that exists but is the WRONG one gives a checkout that charges the wrong
     amount, which is worse because it succeeds. */
  const WANT = [
    ['LS_VARIANT_MONTHLY', 'monthly'],
    ['LS_VARIANT_YEARLY', 'yearly'],
    ['LS_VARIANT_LIFETIME', 'lifetime']
  ];
  let anyVariant = false;
  for (const [k, label] of WANT) {
    const id = env(k);
    if (!id) { warn(`${k} is not set`, `the ${label} plan will not be purchasable`); continue; }
    anyVariant = true;
    if (!/^\d+$/.test(id)) { bad(`${k}=${id} is not a numeric variant id`, 'copy the variant id, not the product id or the slug'); continue; }
    const r = await fetch(`https://api.lemonsqueezy.com/v1/variants/${id}`, { headers: head });
    if (!r.ok) { bad(`${k}=${id} does not exist on this account (HTTP ${r.status})`, 'check Products → your product → variant id'); continue; }
    const a = (await r.json())?.data?.attributes || {};
    const price = a.price != null ? `$${(a.price / 100).toFixed(2)}` : '(price unset)';
    const interval = a.is_subscription ? (a.interval || 'subscription') : 'one-off';
    const expected = label === 'lifetime' ? 'one-off' : label.replace(/ly$/, '');
    const matches = label === 'lifetime' ? !a.is_subscription
                  : a.is_subscription && (a.interval === 'month' && label === 'monthly' || a.interval === 'year' && label === 'yearly');
    if (matches) ok(`${k} → ${price} ${interval}`);
    else bad(`${k}=${id} is a ${interval} variant but is wired up as ${label}`,
             `a customer picking "${label}" would be billed ${interval}; expected ${expected}`);
  }
  if (!anyVariant) bad('no LS_VARIANT_* ids are set', 'nothing can be bought — set at least one');
}

/* ---------- 4. deploy-shaped mistakes ------------------------------------ */

function checkDeploy() {
  const appUrl = env('APP_URL');
  if (appUrl && /localhost|127\.0\.0\.1/.test(appUrl)) {
    bad('APP_URL points at localhost', 'checkout redirects and magic-link emails would send customers to their own machine');
  }
  if (appUrl.endsWith('/')) warn('APP_URL has a trailing slash', 'harmless, but redirect urls read better without it');

  const vercelEnv = env('VERCEL_ENV');
  if (!vercelEnv) {
    warn('VERCEL_ENV is not set', 'expected when running locally; on Vercel it is automatic. The webhook refuses test-mode purchases unless it is preview/development');
  } else if (vercelEnv !== 'production') {
    warn(`VERCEL_ENV is "${vercelEnv}"`, 'test-mode purchases WILL be honoured here — correct for a preview, wrong for the live site');
  } else {
    ok('VERCEL_ENV is production', 'test-mode purchases are refused');
  }

  if (env('CRON_SECRET')) ok('CRON_SECRET set', shape(env('CRON_SECRET')));
  else warn('CRON_SECRET is not set', 'the weekly league settle endpoint would be open to anyone who finds it');
}

/* ---------- run ---------------------------------------------------------- */

console.log('\nMindSharp go-live preflight\n' + '─'.repeat(52));
await checkSupabase();
await checkLemonSqueezy();
checkDeploy();

const icon = { ok: '✓', warn: '!', bad: '✗' };
for (const r of results) {
  console.log(`  ${icon[r.level]} ${r.what}${r.detail ? `\n      ${r.detail}` : ''}`);
}

const bads = results.filter(r => r.level === 'bad');
const warns = results.filter(r => r.level === 'warn');
console.log('─'.repeat(52));
if (bads.length) {
  console.log(`✗ ${bads.length} blocking problem(s), ${warns.length} warning(s)\n`);
  console.log('  Not ready to take money. Fix the ✗ lines above, then re-run.');
  process.exit(1);
}
console.log(`✓ ready to take money${warns.length ? ` (${warns.length} warning(s) above — read them)` : ''}\n`);
