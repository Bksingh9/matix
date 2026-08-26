import { ok, json, methodGuard } from '../../lib/http.js';
import { supabaseAdmin, isConfigured } from '../../lib/supabase.js';
import crypto from 'node:crypto';

/* POST /api/league/settle — close out finished seasons.
 *
 * Run weekly by a scheduler (vercel.json has the cron). Promotes the top 5 and
 * relegates the bottom 5 of every group that is big enough for those to mean
 * anything, then leaves next week's groups to form on demand.
 *
 * Not authenticated as a user: authorised by a shared secret, compared in
 * constant time. An unprotected settle endpoint would let anyone end the
 * season early and freeze the standings wherever they happened to be. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST', 'GET'])) return;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[settle] CRON_SECRET is not set — refusing to run');
    return json(res, 500, { error: 'not_configured' });
  }
  if (!authorised(req, secret)) return json(res, 401, { error: 'unauthorized' });
  if (!isConfigured()) return json(res, 503, { error: 'no_database' });

  try {
    const db = supabaseAdmin();
    const today = new Date().toISOString().slice(0, 10);

    // Every season whose last day has passed and which still has members.
    const { data: seasons, error } = await db
      .from('league_seasons').select('id, starts_on, ends_on').lt('ends_on', today)
      .order('ends_on', { ascending: true }).limit(10);
    if (error) throw error;

    const settled = [];
    for (const s of seasons || []) {
      const { data: n, error: sErr } = await db.rpc('settle_season', { p_season_id: s.id });
      if (sErr) { console.error(`[settle] season ${s.id} failed:`, sErr.message); continue; }
      // Members are dropped after settling so the same season is not settled
      // twice — settle_season is idempotent on standings, but re-running it
      // would keep finding the same rows forever.
      await db.from('league_members').delete().in('group_id',
        (await db.from('league_groups').select('id').eq('season_id', s.id)).data?.map(g => g.id) || []);
      settled.push({ seasonId: s.id, endsOn: s.ends_on, players: n });
    }

    console.log(`[settle] closed ${settled.length} season(s)`);
    return ok(res, { settled, count: settled.length });
  } catch (e) {
    console.error('[settle]', e);
    return json(res, 500, { error: 'server_error' });
  }
}

function authorised(req, secret) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; allow a header
  // for manual runs too.
  const header = req.headers.authorization || '';
  const given = header.replace(/^Bearer\s+/i, '') || req.headers['x-cron-secret'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
