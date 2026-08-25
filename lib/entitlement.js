import { supabaseAdmin } from './supabase.js';

export const FREE_ENTITLEMENT = Object.freeze({
  isPro: false, plan: 'free', status: 'none',
  currentPeriodEnd: null, cancelAtPeriodEnd: false
});

/* The one definition of Pro in the system.

   `cancelled` still counts: someone who cancels keeps access to the end of the
   period they already paid for. Revoking early is how you earn a chargeback,
   which costs more than the subscription was worth.

   `past_due` also counts: the card failed and Lemon Squeezy is retrying. Cut
   access during the dunning window and you lose a customer who was about to
   pay you anyway. `expired` and `refunded` end access immediately. */
export function isPro(row, nowMs = Date.now()) {
  if (!row) return false;
  if (!['active', 'cancelled', 'past_due'].includes(row.status)) return false;
  if (row.plan === 'lifetime' || row.plan === 'comp') return true;
  if (!row.current_period_end) return false;
  return new Date(row.current_period_end).getTime() > nowMs;
}

export function shape(row) {
  if (!row) return { ...FREE_ENTITLEMENT };
  return {
    isPro: isPro(row),
    plan: row.plan || 'free',
    status: row.status || 'none',
    currentPeriodEnd: row.current_period_end || null,
    cancelAtPeriodEnd: !!row.cancel_at_period_end
  };
}

export async function getEntitlementRow(userId) {
  const { data, error } = await supabaseAdmin()
    .from('entitlements').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function resolveEntitlement(userId) {
  const row = await getEntitlementRow(userId);
  return shape(row);
}

/* Server-only write path. Nothing that reaches the browser may call this. */
export async function upsertEntitlement(userId, patch) {
  const payload = { user_id: userId, ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin()
    .from('entitlements').upsert(payload, { onConflict: 'user_id' }).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* How many runs today's free budget has already spent. Excludes the daily
   challenge and drills — see sql/003_views.sql for why. */
export async function runsUsedToday(userId) {
  const { data, error } = await supabaseAdmin()
    .from('v_runs_today').select('runs_used').eq('user_id', userId).maybeSingle();
  if (error) return 0;
  return data?.runs_used ?? 0;
}

export function freeRuns() {
  const n = parseInt(process.env.FREE_RUNS || '5', 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

export async function limitsFor(userId, pro) {
  const cap = freeRuns();
  if (!userId) return { freeRuns: cap, runsUsedToday: 0, runsLeft: cap };
  if (pro) return { freeRuns: cap, runsUsedToday: 0, runsLeft: null };  // null = unlimited
  const used = await runsUsedToday(userId);
  return { freeRuns: cap, runsUsedToday: used, runsLeft: Math.max(0, cap - used) };
}
