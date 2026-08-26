import { ok, json, methodGuard, unauthorized, serverError, errorRef, clientIp, tooMany, readJson } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { guard } from '../lib/ratelimit.js';
import { supabaseAdmin, isConfigured } from '../lib/supabase.js';

/* GET  /api/league  — this week's group, ranked
 * POST /api/league  { handle } — set the name shown on the board
 *
 * Weekly leagues are the strongest retention mechanic in this category: a
 * scoreboard that resets on Monday means last week's result never locks you
 * out, and a promotion is a reason to play on a day you otherwise wouldn't.
 *
 * The hard part at low traffic is that an empty league looks like a broken
 * product. join_league fills one group to capacity before opening another, and
 * this endpoint reports `meaningful` so the client can show a quieter thing
 * instead of five names and a lot of whitespace. */

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const MIN_MEANINGFUL = 5;
const PROMOTE = 5;
const RELEGATE = 5;

export default async function handler(req, res) {
  if (req.method === 'POST') return setHandle(req, res);
  if (!methodGuard(req, res, ['GET', 'POST'])) return;

  try {
    if (!isConfigured()) return ok(res, { available: false });

    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'read', user.id, clientIp(req)))) return tooMany(res, 600);

    const db = supabaseAdmin();

    // Joining is idempotent, and doing it on read means a player who has not
    // finished a run yet still sees the board they are about to compete in.
    const { data: groupId, error: joinErr } = await db.rpc('join_league', { p_user_id: user.id, p_size: 30 });
    if (joinErr) throw joinErr;

    const [{ data: members, error: mErr }, { data: group }, { data: standing }] = await Promise.all([
      db.from('league_members').select('user_id, xp, joined_at').eq('group_id', groupId).order('xp', { ascending: false }).order('joined_at', { ascending: true }),
      db.from('league_groups').select('id, tier, season_id').eq('id', groupId).maybeSingle(),
      db.from('league_standing').select('tier, last_result').eq('user_id', user.id).maybeSingle()
    ]);
    if (mErr) throw mErr;

    const rows = members || [];
    const ids = rows.map(r => r.user_id);
    const handles = new Map();
    if (ids.length) {
      const { data: profs } = await db.from('profiles').select('id, handle').in('id', ids);
      for (const p of profs || []) handles.set(p.id, p.handle);
    }

    const size = rows.length;
    const entries = rows.map((r, i) => ({
      rank: i + 1,
      handle: handles.get(r.user_id) || 'Player ' + String(r.user_id).slice(-4),
      xp: r.xp,
      isYou: r.user_id === user.id,
      // Only mark zones once the group is big enough for them to mean
      // anything. Finishing last in a group of four is not a result.
      zone: size >= 10
        ? (i < PROMOTE ? 'promote' : (i >= size - RELEGATE && r.xp === 0 ? 'relegate' : 'hold'))
        : 'hold'
    }));

    const { data: season } = await db.from('league_seasons').select('starts_on, ends_on').eq('id', group?.season_id).maybeSingle();

    return ok(res, {
      available: true,
      groupId,
      tier: group?.tier ?? 1,
      tierName: TIERS[(group?.tier ?? 1) - 1] || 'Bronze',
      entries,
      you: entries.find(e => e.isYou) || null,
      size,
      meaningful: size >= MIN_MEANINGFUL,
      promoteCount: size >= 10 ? PROMOTE : 0,
      relegateCount: size >= 10 ? RELEGATE : 0,
      season: season ? { startsOn: season.starts_on, endsOn: season.ends_on, endsAt: endOfDayUtc(season.ends_on) } : null,
      lastResult: standing?.last_result || null,
      handleSet: !!handles.get(user.id)
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[league:${ref}]`, e);
    return serverError(res, ref);
  }
}

/* A leaderboard needs a name, and it must not be an email address. */
async function setHandle(req, res) {
  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'checkout', user.id, clientIp(req)))) return tooMany(res, 600);

    const body = await readJson(req, 4 * 1024);
    const handle = typeof body?.handle === 'string' ? body.handle.trim() : '';

    if (!/^[A-Za-z0-9_][A-Za-z0-9_ -]{1,15}$/.test(handle)) {
      return json(res, 400, { error: 'bad_handle', detail: '2–16 characters: letters, numbers, spaces, _ or -' });
    }
    // An email address as a handle would publish it on a public board.
    if (handle.includes('@')) return json(res, 400, { error: 'bad_handle' });

    const { error } = await supabaseAdmin().from('profiles')
      .update({ handle }).eq('id', user.id);
    if (error) {
      if (error.code === '23505') return json(res, 409, { error: 'handle_taken' });
      throw error;
    }
    return ok(res, { handle });
  } catch (e) {
    const ref = errorRef();
    console.error(`[league:handle:${ref}]`, e);
    return serverError(res, ref);
  }
}

const endOfDayUtc = d => d ? new Date(Date.parse(d + 'T00:00:00Z') + 86400000 - 1).toISOString() : null;
