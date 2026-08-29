#!/usr/bin/env node
/* Apply sql/001-006 to a throwaway Postgres and prove row-level security.
 *
 * This is the check `npm run verify:rls` could never be: that one needs a live
 * Supabase project and credentials, so in practice it goes unrun. This one
 * needs only a local Postgres, so it can run in CI on every commit.
 *
 * What it proves that nothing else does:
 *   - the migrations apply, in order, to a real Postgres
 *   - the triggers, views, and SECURITY DEFINER functions actually compile
 *   - an anon or signed-in client cannot write `entitlements`
 *
 * Everything else in the suite talks to a fake PostgREST with no database
 * under it, and therefore cannot tell "the policy stopped them" apart from
 * "there is no policy".
 *
 * Usage:  npm run verify:sql
 *         PSQL="docker exec -i pg psql" npm run verify:sql
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.VERIFY_DB || 'mindsharp_verify';

/* Debian and Ubuntu ship Postgres with peer authentication, so root cannot be
   `postgres` without switching user first. Detect rather than document: a
   verification step people have to read instructions to run is one they skip. */
function psqlCommand() {
  if (process.env.PSQL) return process.env.PSQL.split(' ');
  const direct = spawnSync('psql', ['-U', 'postgres', '-tAc', 'select 1'], { encoding: 'utf8' });
  if (direct.status === 0) return ['psql', '-U', 'postgres'];
  const viaSu = spawnSync('su', ['postgres', '-c', 'psql -tAc "select 1"'], { encoding: 'utf8' });
  if (viaSu.status === 0) return ['su', 'postgres', '-c', 'psql'];
  return null;
}

const CMD = psqlCommand();
if (!CMD) {
  console.error('✗ no reachable Postgres.\n');
  console.error('  Start one, then re-run. On Debian/Ubuntu:');
  console.error('      pg_ctlcluster 16 main start');
  console.error('  Or point at your own:');
  console.error('      PSQL="psql -U me -h localhost" npm run verify:sql');
  process.exit(1);
}

/* Always pipe SQL through stdin rather than -f. The server may run as another
   OS user who cannot read this checkout. */
function run(sql, { db = DB, allowFail = false, label = '' } = {}) {
  const isSu = CMD[0] === 'su';
  const args = isSu
    ? ['postgres', '-c', `psql -v ON_ERROR_STOP=1 -q -d ${db} -f -`]
    : [...CMD.slice(1), '-v', 'ON_ERROR_STOP=1', '-q', '-d', db, '-f', '-'];
  const bin = isSu ? 'su' : CMD[0];

  const r = spawnSync(bin, args, { input: sql, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !allowFail) {
    console.error(`\n✗ ${label || 'SQL'} failed:\n`);
    console.error(out.split('\n').filter(l => !/^NOTICE:/.test(l)).join('\n'));
    process.exit(1);
  }
  return out;
}

const MIGRATIONS = [
  '001_schema.sql', '002_rls.sql', '003_views.sql',
  '005_progression.sql', '006_store_purchases.sql', '007_fix_profiles_rls.sql'
];

console.log(`Postgres reachable via: ${CMD.join(' ')}`);

// A scratch database every time, so a stale one cannot mask a migration that
// only works against an already-migrated database.
run(`drop database if exists ${DB};`, { db: 'postgres', label: 'drop scratch db' });
run(`create database ${DB};`, { db: 'postgres', label: 'create scratch db' });

try {
  run(readFileSync(join(ROOT, 'test/sql/supabase-shim.sql'), 'utf8'), { label: 'supabase shim' });
  console.log('✓ Supabase shim applied (auth.users, auth.uid, the three API roles)');

  for (const m of MIGRATIONS) {
    const p = join(ROOT, 'sql', m);
    if (!existsSync(p)) { console.error(`✗ missing ${m}`); process.exit(1); }
    run(readFileSync(p, 'utf8'), { label: m });
    console.log(`✓ sql/${m}`);
  }

  // 004 is dev-only seed data; applying it here would grant a comp entitlement
  // and make the "nobody can grant themselves Pro" checks meaningless.
  console.log('· sql/004_seed_dev.sql skipped (dev seed, grants a comp entitlement)');

  const out = run(readFileSync(join(ROOT, 'test/sql/rls-proof.sql'), 'utf8'), { label: 'RLS proof' });

  const checks = [...out.matchAll(/NOTICE:\s+ok\s+(.+)/g)].map(m => m[1].trim());
  const holes = [...out.matchAll(/(SECURITY HOLE|WRONG VISIBILITY|BROKEN)[^\n]*/g)].map(m => m[0]);

  for (const c of checks) console.log(`  ✓ ${c}`);

  if (holes.length) {
    console.error('\n✗ ROW-LEVEL SECURITY IS NOT HOLDING:\n');
    for (const h of holes) console.error(`   ${h}`);
    process.exit(1);
  }
  if (!/ALL RLS CHECKS PASSED/.test(out)) {
    console.error('\n✗ the RLS proof did not run to completion');
    process.exit(1);
  }
  if (checks.length < 20) {
    // A proof that stopped early would otherwise look like a pass.
    console.error(`\n✗ only ${checks.length} checks ran; expected at least 20`);
    process.exit(1);
  }

  console.log(`\n✓ schema applies to a real Postgres and RLS holds (${checks.length} checks)`);
} finally {
  run(`drop database if exists ${DB};`, { db: 'postgres', allowFail: true });
}
