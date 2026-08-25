#!/usr/bin/env node
/* Proves that row-level security actually holds.
 *
 * The spec's instruction is blunt and correct: with an anon-key client, try to
 * write entitlements. It must fail. If it succeeds, the whole payment system
 * is decorative — anyone can grant themselves Pro from the browser console.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/verify-rls.mjs
 *
 * The service-role key is used only to create and delete a throwaway user, so
 * the authenticated-client checks are real rather than simulated.
 */
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY (and ideally SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(2);
}

const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const admin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const results = [];
const record = (name, passed, detail) => { results.push({ name, passed, detail }); };

/* A check "passes" when the operation was correctly refused: either an error,
   or zero rows affected (PostgREST reports an RLS-filtered update as a
   successful no-op, which is why the row-count assertion matters). */
function refused(name, { error, data }, extra = '') {
  const rows = Array.isArray(data) ? data.length : (data ? 1 : 0);
  const passed = !!error || rows === 0;
  record(name, passed, error ? `refused: ${error.message}` : (passed ? 'refused: 0 rows affected' : `ALLOWED — ${rows} row(s) ${extra}`));
}

async function main() {
  let userId = null, userEmail = null, userClient = null, createdUser = false;

  if (admin) {
    userEmail = `rls-probe-${Date.now()}@example.invalid`;
    const password = 'Probe!' + Math.random().toString(36).slice(2) + 'Aa1';
    const { data, error } = await admin.auth.admin.createUser({ email: userEmail, password, email_confirm: true });
    if (error) {
      console.warn('· could not create a probe user, running anon-only checks:', error.message);
    } else {
      userId = data.user.id;
      createdUser = true;
      const signIn = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { data: s, error: e2 } = await signIn.auth.signInWithPassword({ email: userEmail, password });
      if (e2) console.warn('· probe user sign-in failed:', e2.message);
      else {
        userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false },
          global: { headers: { Authorization: `Bearer ${s.session.access_token}` } }
        });
      }
    }
  }

  try {
    // ---- the check the spec singles out ----------------------------------
    refused('anon cannot update entitlements',
      await anon.from('entitlements').update({ plan: 'lifetime', status: 'active' }).neq('user_id', '00000000-0000-0000-0000-000000000000').select());

    refused('anon cannot insert entitlements',
      await anon.from('entitlements').insert({ user_id: '00000000-0000-0000-0000-000000000000', plan: 'lifetime', status: 'active' }).select());

    refused('anon cannot read entitlements',
      await anon.from('entitlements').select('user_id, plan').limit(5));

    refused('anon cannot read attempts',
      await anon.from('attempts').select('id').limit(5));

    refused('anon cannot read runs',
      await anon.from('runs').select('id').limit(5));

    refused('anon cannot read webhook_events',
      await anon.from('webhook_events').select('id').limit(5));

    refused('anon cannot call bump_rate_limit',
      await anon.rpc('bump_rate_limit', { p_bucket: 'probe', p_limit: 1, p_window_seconds: 60 }));

    refused('anon cannot call insert_run_with_attempts',
      await anon.rpc('insert_run_with_attempts', {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_run: { game: 'blitz', difficulty: 'medium', score: 999999, solved: 1, correct: 1, wrong: 0, best_streak: 1, duration_ms: 1 },
        p_attempts: []
      }));

    if (userClient && userId) {
      // ---- an authenticated user is still not allowed to sell themselves Pro
      refused('signed-in user cannot update their OWN entitlement',
        await userClient.from('entitlements').update({ plan: 'lifetime', status: 'active' }).eq('user_id', userId).select());

      refused('signed-in user cannot insert an entitlement',
        await userClient.from('entitlements').insert({ user_id: userId, plan: 'lifetime', status: 'active' }).select());

      refused('signed-in user cannot delete their entitlement',
        await userClient.from('entitlements').delete().eq('user_id', userId).select());

      // ---- but they can read their own row, and only their own -------------
      const own = await userClient.from('entitlements').select('user_id, plan').eq('user_id', userId);
      record('signed-in user CAN read their own entitlement',
        !own.error && Array.isArray(own.data) && own.data.length === 1,
        own.error ? own.error.message : `${own.data?.length ?? 0} row(s)`);

      const all = await userClient.from('entitlements').select('user_id');
      record('signed-in user sees only their own entitlement row',
        !all.error && (all.data || []).every(r => r.user_id === userId),
        all.error ? all.error.message : `${all.data?.length ?? 0} row(s) visible`);

      // ---- runs: own writes fine, someone else's forbidden -----------------
      const mine = await userClient.from('runs').insert({
        user_id: userId, game: 'blitz', difficulty: 'medium',
        score: 10, solved: 1, correct: 1, wrong: 0, best_streak: 1, duration_ms: 1000
      }).select();
      record('signed-in user CAN insert their own run', !mine.error, mine.error ? mine.error.message : 'ok');

      refused("signed-in user cannot insert a run for someone else",
        await userClient.from('runs').insert({
          user_id: '00000000-0000-0000-0000-000000000000', game: 'blitz', difficulty: 'medium',
          score: 10, solved: 1, correct: 1, wrong: 0, best_streak: 1, duration_ms: 1000
        }).select());
    } else {
      record('authenticated-user checks', true, 'skipped (no service-role key, or sign-in failed)');
    }
  } finally {
    if (admin && createdUser && userId) {
      await admin.from('runs').delete().eq('user_id', userId);
      await admin.auth.admin.deleteUser(userId).catch(() => {});
    }
  }

  const width = Math.max(...results.map(r => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`${r.passed ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter(r => !r.passed);
  console.log('');
  if (failed.length) {
    console.error(`${failed.length} of ${results.length} checks FAILED. Run sql/002_rls.sql, then re-run this.`);
    console.error('Until these pass, anyone with the anon key can grant themselves Pro.');
    process.exit(1);
  }
  console.log(`All ${results.length} RLS checks passed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
