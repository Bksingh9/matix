import { S, setPro, applyServerLimits } from './state.js';
import { K, sget, sset } from './store.js';
import { track } from './analytics.js';
import * as api from './api.js';

/* Server-authoritative Pro, with a short cache so we don't hammer /api/me.

   The failure mode is deliberate and asymmetric: when the server cannot be
   reached we fall back to FREE, never to Pro. A paying user briefly seeing the
   free tier is a bug report. A free user permanently seeing Pro is lost
   revenue — and a hole anyone can open by going offline. */

const FREE = Object.freeze({ isPro: false, plan: 'free', status: 'none', currentPeriodEnd: null, cancelAtPeriodEnd: false });
const TTL = 60_000;

let cached = null;
let fetchedAt = 0;

export async function getEntitlement({ force = false } = {}) {
  if (!force && cached && Date.now() - fetchedAt < TTL) return cached;
  try {
    const r = await api.get('/api/me');
    cached = r.entitlement || { ...FREE };
    fetchedAt = Date.now();
    lastMe = r;
    return cached;
  } catch (e) {
    return cached ?? { ...FREE };
  }
}

let lastMe = null;
export const lastMeResponse = () => lastMe;

/* Fetch, then push the result into state and re-render. Called on app open,
   sign-in, return from checkout, and successful licence validation. */
export async function refreshEntitlement(opts = {}) {
  const before = S.pro;
  const ent = await getEntitlement(opts);
  setPro(ent);
  if (lastMe) {
    S.authed = !!lastMe.authed;
    if (lastMe.user) S.user = lastMe.user;
    applyServerLimits(lastMe.limits);
  }
  if (!before && S.pro) track('pro_active', { source: 'server', plan: ent.plan });
  return ent;
}

/* Webhooks are not instant. After a checkout returns, poll until the
   entitlement flips or we give up — 30s at 2s intervals, per spec §6. */
export async function pollForPro({ intervalMs = 2000, timeoutMs = 30000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    const ent = await refreshEntitlement({ force: true });
    if (ent.isPro) return ent;
    if (onTick) { try { onTick(i, Math.max(0, deadline - Date.now())); } catch (e) { /* cosmetic */ } }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return refreshEntitlement({ force: true });
}

export function invalidate() { cached = null; fetchedAt = 0; }

/* ============================================================ MIGRATION
   An anonymous player with a 12-day streak signs in. Their history has to come
   with them, or they will never sign in again.

   On first successful auth, if there is local progress and the account has no
   runs yet, POST the local aggregate as one synthetic backfill run. The local
   copy is kept — this is a copy, not a move, for one release. */
export async function migrateLocalProgress() {
  // S.authed, not the SDK's session object: /api/me only reports authed:true
  // for a request that carried a valid token, so this is the server's answer
  // rather than the client's opinion.
  if (!S.authed) return { migrated: false, reason: 'not_authed' };
  if (await sget(K.migrated)) return { migrated: false, reason: 'already_done' };

  const stats = await sget(K.stats);
  if (!stats || !stats.solved) {
    await sset(K.migrated, { at: Date.now(), empty: true });
    return { migrated: false, reason: 'nothing_local' };
  }

  try {
    const me = lastMe || await api.get('/api/me');
    if (me && me.hasRuns) { await sset(K.migrated, { at: Date.now(), skipped: 'account_has_runs' }); return { migrated: false, reason: 'account_has_runs' }; }

    const days = Array.isArray(stats.days) ? stats.days.slice(-400) : [];
    const correct = Math.min(stats.correct || 0, stats.solved || 0);

    const r = await api.post('/api/runs', {
      game: 'import',
      difficulty: 'mixed',
      score: 0,
      solved: stats.solved || 0,
      correct,
      wrong: Math.max(0, (stats.solved || 0) - correct),
      bestStreak: stats.bestStreak || 0,
      durationMs: 0,
      isDaily: false,
      dailyDate: null,
      drillId: null,
      clientTs: new Date().toISOString(),
      // Days played locally, so the streak calculation survives the move.
      importDays: days,
      importBest: stats.best || {},
      attempts: []
    });

    await sset(K.migrated, { at: Date.now(), runId: r && r.runId });
    track('local_progress_migrated', { solved: stats.solved || 0, days: days.length });
    return { migrated: true, runId: r && r.runId };
  } catch (e) {
    // Leave the marker unset so the next sign-in tries again.
    console.warn('[migrate] deferred:', e && e.message);
    return { migrated: false, reason: 'error', error: e && e.message };
  }
}

/* ============================================================ LICENCE KEYS
   Phase 3 endpoint. The store API key lives on the server; this only ever
   sends the key the user typed. */
export async function validateLicence(key) {
  const r = await api.post('/api/licence/validate', { key });
  invalidate();
  await refreshEntitlement({ force: true });
  return r;
}
