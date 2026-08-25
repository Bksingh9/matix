import { supabaseAdmin } from './supabase.js';
import { OPS } from './weakness.js';

/* Reads a user's bucket statistics out of the views in sql/003_views.sql and
   shapes them for lib/weakness.js.
 *
 * The heavy lifting is SQL — percentiles over a windowed set are what Postgres
 * is for, and pulling 400 attempt rows into a serverless function to sort them
 * in JavaScript would be slower and no clearer. */

export async function loadBuckets(userId) {
  const db = supabaseAdmin();

  const [stats, trend, recent10] = await Promise.all([
    db.from('v_bucket_stats').select('op, band, seen, correct, avg_ms, median_ms').eq('user_id', userId),
    db.from('v_bucket_trend').select('op, band, window, seen, correct, median_ms').eq('user_id', userId),
    db.from('v_bucket_recent10').select('op, band, seen, correct, median_ms').eq('user_id', userId)
  ]);

  if (stats.error) throw stats.error;

  const byKey = new Map();
  for (const r of stats.data || []) {
    if (!OPS.includes(r.op)) continue;
    byKey.set(`${r.op}:${r.band}`, {
      op: r.op,
      band: Number(r.band),
      seen: Number(r.seen) || 0,
      correct: Number(r.correct) || 0,
      medianMs: Number(r.median_ms) || Number(r.avg_ms) || 0
    });
  }

  for (const r of (trend.error ? [] : trend.data || [])) {
    const b = byKey.get(`${r.op}:${r.band}`);
    if (!b) continue;
    const w = { seen: Number(r.seen) || 0, correct: Number(r.correct) || 0, medianMs: Number(r.median_ms) || 0 };
    if (r.window === 'recent') b.recent = w; else b.prior = w;
  }

  for (const r of (recent10.error ? [] : recent10.data || [])) {
    const b = byKey.get(`${r.op}:${r.band}`);
    if (!b) continue;
    b.recent10 = { seen: Number(r.seen) || 0, correct: Number(r.correct) || 0, medianMs: Number(r.median_ms) || 0 };
  }

  return [...byKey.values()];
}

/* Total attempts on record — the cold-start gate. Counting rows is cheaper
   than summing the bucket view, and it includes attempts with no operation
   (recall), which the views deliberately exclude. */
export async function totalAttempts(userId) {
  const { count, error } = await supabaseAdmin()
    .from('attempts').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (error) throw error;
  return count || 0;
}
