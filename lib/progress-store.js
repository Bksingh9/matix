import { supabaseAdmin } from './supabase.js';
import {
  xpForRun, levelFromXp, recordActivity,
  evaluateAchievements, milestoneXp
} from '../public/js/progression.js';

/* Reads and advances a player's progression. Called by /api/runs after a run
   is persisted, and by /api/progress for a read-only view.
 *
 * Only the server writes these numbers. A client that could set its own XP
 * could award itself a level 60 badge and every leaderboard would be fiction.
 */

const EMPTY = {
  xp: 0, level: 1, day_streak: 0, longest_streak: 0, streak_freezes: 0,
  days_played: 0, last_day: null, total_solved: 0, total_correct: 0,
  best_run_streak: 0, perfect_runs: 0, sub_two_sec_runs: 0, dailies_done: 0,
  perfect_dailies: 0, drills_done: 0, zen_solved: 0, best_survival: 0,
  best_recall_digits: 0, modes_played: []
};

export async function loadProgress(userId) {
  const { data, error } = await supabaseAdmin()
    .from('player_progress').select('*').eq('user_id', userId).maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return { ...EMPTY, ...(data || {}) };
}

export async function loadUnlocked(userId) {
  const { data, error } = await supabaseAdmin()
    .from('achievements').select('code').eq('user_id', userId);
  if (error) return [];
  return (data || []).map(r => r.code);
}

/* Turn a stored row into the shape the achievement predicates expect. */
export function snapshotOf(row, extra = {}) {
  return {
    solved: row.total_solved,
    longestStreak: row.longest_streak,
    perfectRuns: row.perfect_runs,
    bestStreak: row.best_run_streak,
    subTwoSecondRuns: row.sub_two_sec_runs,
    dailiesDone: row.dailies_done,
    perfectDailies: row.perfect_dailies,
    modesPlayed: (row.modes_played || []).length,
    zenSolved: row.zen_solved,
    bestSurvival: row.best_survival,
    bestRecallDigits: row.best_recall_digits,
    drillsDone: row.drills_done,
    level: levelFromXp(row.xp).level,
    bucketsMastered: extra.bucketsMastered ?? 0
  };
}

/* Advance everything for one finished run, and report what changed so the
   client can show it. The return value is what makes the results screen feel
   like progress rather than a number.

   `today` is passed in rather than read from the clock so a test can drive a
   week of play, and so the whole calculation is one consistent date. */
export async function applyRun(userId, run, { attempts = [], isPro = false, today = utcToday(), bucketsMastered = 0 } = {}) {
  const before = await loadProgress(userId);
  const unlocked = await loadUnlocked(userId);

  const isFirstOfDay = before.last_day !== today;
  const game = run.is_daily ? 'daily' : run.game;
  const solved = run.solved || 0;
  const correct = run.correct || 0;

  // /api/runs hands us rows already shaped for Postgres (snake_case), while
  // progression.js is shared with the client and speaks camelCase. Normalise
  // once here: reading a.isCorrect off a snake_case row silently returns
  // undefined, which zeroes the per-problem band-scaled XP and leaves only the
  // flat bonuses — the whole point of the reward curve, gone without an error.
  const norm = (attempts || []).map(a => ({
    kind: a.kind,
    band: a.band,
    answer: a.answer,
    isCorrect: a.isCorrect ?? a.is_correct ?? false
  }));

  // recordActivity resolves the gap itself. Pre-resolving here as well would
  // charge the same missed day twice and eat a freeze the player still had.
  const activity = recordActivity({
    lastDay: before.last_day, dayStreak: before.day_streak,
    freezes: before.streak_freezes, daysPlayed: before.days_played, today, isPro
  });

  const runXp = xpForRun({
    attempts: norm, game, isDaily: !!run.is_daily, solved, correct,
    isFirstOfDay, dayStreak: activity.dayStreak, completed: true
  });

  const lines = [...runXp.lines];
  let xpGain = runXp.xp;

  if (activity.milestone) {
    const bonus = milestoneXp(activity.milestone);
    xpGain += bonus;
    lines.push({ code: 'milestone', label: `${activity.milestone}-day milestone`, xp: bonus });
  }

  // Counters the achievement predicates read.
  const avgMs = solved ? (run.duration_ms || 0) / solved : Infinity;
  const perfect = solved >= 10 && correct === solved;
  const modes = new Set(before.modes_played || []);
  modes.add(game);

  const after = {
    total_solved: before.total_solved + solved,
    total_correct: before.total_correct + correct,
    best_run_streak: Math.max(before.best_run_streak, run.best_streak || 0),
    perfect_runs: before.perfect_runs + (perfect ? 1 : 0),
    sub_two_sec_runs: before.sub_two_sec_runs + (solved >= 15 && avgMs < 2000 ? 1 : 0),
    dailies_done: before.dailies_done + (run.is_daily ? 1 : 0),
    perfect_dailies: before.perfect_dailies + (run.is_daily && solved > 0 && correct === solved ? 1 : 0),
    drills_done: before.drills_done + (run.game === 'drill' ? 1 : 0),
    zen_solved: before.zen_solved + (run.game === 'zen' ? solved : 0),
    best_survival: Math.max(before.best_survival, run.game === 'survival' ? correct : 0),
    best_recall_digits: Math.max(before.best_recall_digits, maxRecallDigits(norm)),
    modes_played: [...modes],
    day_streak: activity.dayStreak,
    longest_streak: Math.max(before.longest_streak, activity.dayStreak),
    streak_freezes: activity.freezes,
    days_played: activity.daysPlayed,
    last_day: activity.lastDay
  };

  // Achievements are checked against the post-run state, including the level
  // this run's XP just bought — otherwise "reach level 5" lands a run late.
  const provisionalXp = before.xp + xpGain;
  const ach = evaluateAchievements(
    snapshotOf({ ...before, ...after, xp: provisionalXp }, { bucketsMastered }),
    unlocked
  );

  if (ach.xpAwarded) {
    xpGain += ach.xpAwarded;
    lines.push({ code: 'achievements', label: ach.newlyUnlocked.length === 1 ? 'Achievement' : `${ach.newlyUnlocked.length} achievements`, xp: ach.xpAwarded });
  }

  const finalXp = before.xp + xpGain;
  const beforeLevel = levelFromXp(before.xp);
  const afterLevel = levelFromXp(finalXp);

  const db = supabaseAdmin();
  const { error } = await db.from('player_progress').upsert({
    user_id: userId, ...after, xp: finalXp, level: afterLevel.level,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw error;

  if (ach.newlyUnlocked.length) {
    const { error: aErr } = await db.from('achievements').upsert(
      ach.newlyUnlocked.map(a => ({ user_id: userId, code: a.code })),
      { onConflict: 'user_id,code' }
    );
    if (aErr) console.error('[progress] achievement write failed:', aErr.message);
  }

  // League XP is best-effort: a leaderboard write must never fail a run.
  if (xpGain > 0) {
    try { await db.rpc('add_league_xp', { p_user_id: userId, p_xp: xpGain }); }
    catch (e) { console.error('[progress] league xp failed:', e.message); }
  }

  return {
    xpGained: xpGain,
    xpLines: lines,
    xp: finalXp,
    level: afterLevel,
    levelledUp: afterLevel.level > beforeLevel.level,
    levelsGained: afterLevel.level - beforeLevel.level,
    streak: {
      dayStreak: activity.dayStreak,
      longest: after.longest_streak,
      freezes: activity.freezes,
      freezeEarned: !!activity.freezeEarned,
      freezesUsed: activity.freezesUsed || 0,
      milestone: activity.milestone,
      extended: activity.extended,
      wasBroken: activity.broken
    },
    achievements: ach.newlyUnlocked,
    achievementsUnlocked: ach.unlockedCount,
    achievementsTotal: ach.total
  };
}

function maxRecallDigits(attempts) {
  let max = 0;
  for (const a of attempts) {
    if (a.kind !== 'recall' || !a.isCorrect) continue;
    const n = a.answer == null ? 0 : String(Math.abs(a.answer)).length;
    if (n > max) max = n;
  }
  return max;
}

export const utcToday = () => new Date().toISOString().slice(0, 10);
