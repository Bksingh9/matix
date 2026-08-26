import { ok, methodGuard, unauthorized, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { resolveEntitlement } from '../lib/entitlement.js';
import { guard } from '../lib/ratelimit.js';
import { loadProgress, loadUnlocked, snapshotOf } from '../lib/progress-store.js';
import { levelFromXp, evaluateAchievements, resolveStreak, streakState } from '../public/js/progression.js';
import { isConfigured } from '../lib/supabase.js';

/* GET /api/progress — level, streak and achievements for the profile screen.
 *
 * Read-only. Nothing here advances anything: /api/runs owns every write, so a
 * player cannot farm XP by refreshing. */
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  try {
    if (!isConfigured()) return ok(res, { authed: false });

    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'read', user.id, clientIp(req)))) return tooMany(res, 600);

    const ent = await resolveEntitlement(user.id);
    const [row, unlocked] = await Promise.all([loadProgress(user.id), loadUnlocked(user.id)]);

    const today = new Date().toISOString().slice(0, 10);
    // Report the streak the player still has after any gap is settled against
    // their freezes, not the stale stored number.
    const resolved = resolveStreak({
      lastDay: row.last_day, dayStreak: row.day_streak,
      freezes: row.streak_freezes, today, isPro: ent.isPro
    });

    const hoursLeftInDay = 24 - new Date().getUTCHours();
    const ach = evaluateAchievements(snapshotOf({ ...row, day_streak: resolved.dayStreak }), unlocked);

    return ok(res, {
      authed: true,
      level: levelFromXp(row.xp),
      streak: {
        ...streakState({ lastDay: row.last_day, dayStreak: resolved.dayStreak, freezes: resolved.freezes, today, hoursLeftInDay }),
        longest: row.longest_streak,
        daysPlayed: row.days_played,
        lastDay: row.last_day
      },
      totals: {
        solved: row.total_solved,
        correct: row.total_correct,
        accuracy: row.total_solved ? Math.round(1000 * row.total_correct / row.total_solved) / 1000 : null,
        dailiesDone: row.dailies_done,
        drillsDone: row.drills_done,
        bestRunStreak: row.best_run_streak,
        modesPlayed: (row.modes_played || []).length
      },
      achievements: ach.achievements,
      achievementsUnlocked: ach.unlockedCount,
      achievementsTotal: ach.total,
      serverTime: new Date().toISOString()
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[progress:${ref}]`, e);
    return serverError(res, ref);
  }
}
