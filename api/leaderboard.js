import { ok, json, methodGuard, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { guard } from '../lib/ratelimit.js';
import { supabaseAdmin, isConfigured } from '../lib/supabase.js';

/* GET /api/leaderboard?date=YYYY-MM-DD — the daily challenge board.
 *
 * Public: you can look before you sign up, which is the point of a
 * leaderboard as a growth mechanic. Handles only, never emails.
 *
 * A board with four people on it looks broken, so the response says how many
 * players there are and lets the client decide whether to show it as a
 * leaderboard or as "you and two others played today". */

const MAX_ROWS = 50;

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  try {
    if (!isConfigured()) return ok(res, { available: false, entries: [], playerCount: 0 });

    const url = new URL(req.url, 'http://localhost');
    const raw = url.searchParams.get('date');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw || '') ? raw : new Date().toISOString().slice(0, 10);

    const user = await userFromRequest(req);
    if (!(await guard(res, 'read', user?.id || clientIp(req)))) return tooMany(res, 600);

    const db = supabaseAdmin();
    const { data, error } = await db
      .from('v_daily_leaderboard')
      .select('user_id, handle, score, rank')
      .eq('daily_date', date)
      .order('rank', { ascending: true })
      .limit(MAX_ROWS);
    if (error) throw error;

    const rows = data || [];
    const entries = rows.map(r => ({
      rank: Number(r.rank),
      handle: r.handle,
      score: r.score,
      isYou: !!user && r.user_id === user.id
    }));

    // Where the player sits, even if they are off the bottom of the top 50.
    let you = entries.find(e => e.isYou) || null;
    if (user && !you) {
      const { data: mine } = await db
        .from('v_daily_leaderboard')
        .select('handle, score, rank')
        .eq('daily_date', date).eq('user_id', user.id).maybeSingle();
      if (mine) you = { rank: Number(mine.rank), handle: mine.handle, score: mine.score, isYou: true };
    }

    const { count } = await db
      .from('daily_scores').select('user_id', { count: 'exact', head: true }).eq('daily_date', date);

    return ok(res, {
      available: true,
      date,
      entries,
      you,
      playerCount: count || rows.length,
      // Below this a "leaderboard" is a list of strangers' names and reads as
      // a dead product. The client says "N played today" instead.
      meaningful: (count || 0) >= 5
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[leaderboard:${ref}]`, e);
    return serverError(res, ref);
  }
}
