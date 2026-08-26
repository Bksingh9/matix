/* XP, levels, streaks and achievements.
 *
 * Pure functions, no I/O, shared verbatim between the server (which owns the
 * numbers for a signed-in player) and the client (which needs to predict them
 * for the animation, and owns them entirely for an anonymous player).
 *
 * Retention is the whole point of this file. A game people play once is a
 * demo; the loop that brings them back on day 7 is a streak they don't want to
 * break, a level they're two runs from, and a leaderboard that resets weekly.
 */

/* ============================================================ XP

   XP is earned per correct answer, scaled by how hard the problem was. Paying
   by problem rather than by score matters: score rewards speed streaks, which
   means a good player earns 10x a beginner and the beginner never levels up.
   Band scaling keeps the ceiling within reach while still rewarding harder
   work. */
export const XP_PER_BAND = { 1: 2, 2: 3, 3: 5, 4: 8 };
export const XP_NO_BAND = 2;              // recall, target — no arithmetic band

export const XP_BONUS = {
  runComplete: 5,          // finishing rather than quitting
  dailyComplete: 30,       // the growth loop, paid accordingly
  dailyPerfect: 20,        // on top of dailyComplete
  drillComplete: 25,       // the Pro loop
  perfectRun: 15,          // 100% accuracy, min 10 problems
  firstRunOfDay: 10,       // the "come back tomorrow" nudge
  streakDay: 5             // x current streak, capped below
};
export const STREAK_XP_CAP = 100;

export function xpForRun({ attempts = [], game, isDaily, solved = 0, correct = 0, isFirstOfDay = false, dayStreak = 0, completed = true }) {
  let xp = 0;
  const lines = [];

  let answerXp = 0;
  for (const a of attempts) {
    if (!a.isCorrect) continue;
    answerXp += a.band ? (XP_PER_BAND[a.band] ?? XP_NO_BAND) : XP_NO_BAND;
  }
  if (answerXp) { xp += answerXp; lines.push({ code: 'answers', label: `${correct} correct`, xp: answerXp }); }

  if (completed) { xp += XP_BONUS.runComplete; lines.push({ code: 'complete', label: 'Run finished', xp: XP_BONUS.runComplete }); }

  if (isDaily) {
    xp += XP_BONUS.dailyComplete;
    lines.push({ code: 'daily', label: 'Daily challenge', xp: XP_BONUS.dailyComplete });
    if (solved > 0 && correct === solved) {
      xp += XP_BONUS.dailyPerfect;
      lines.push({ code: 'daily_perfect', label: 'Perfect daily', xp: XP_BONUS.dailyPerfect });
    }
  }

  if (game === 'drill') { xp += XP_BONUS.drillComplete; lines.push({ code: 'drill', label: 'Drill finished', xp: XP_BONUS.drillComplete }); }

  if (!isDaily && solved >= 10 && correct === solved) {
    xp += XP_BONUS.perfectRun;
    lines.push({ code: 'perfect', label: 'Flawless run', xp: XP_BONUS.perfectRun });
  }

  if (isFirstOfDay) {
    xp += XP_BONUS.firstRunOfDay;
    lines.push({ code: 'first_today', label: 'First run today', xp: XP_BONUS.firstRunOfDay });
    if (dayStreak > 1) {
      const bonus = Math.min(STREAK_XP_CAP, XP_BONUS.streakDay * dayStreak);
      xp += bonus;
      lines.push({ code: 'streak', label: `${dayStreak}-day streak`, xp: bonus });
    }
  }

  return { xp, lines };
}

/* ============================================================ LEVELS

   Thresholds grow quadratically, which keeps early levels quick (a new player
   should see level 2 in their first session) and later ones a genuine arc,
   without ever needing a lookup table that runs out. */
export function xpForLevel(level) {
  if (level <= 1) return 0;
  const n = level - 1;
  return 60 * n + 20 * n * (n - 1);
}

export function levelFromXp(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 1;
  while (level < 200 && xpForLevel(level + 1) <= total) level++;
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const span = Math.max(1, ceil - floor);
  return {
    level,
    xp: total,
    intoLevel: total - floor,
    levelSpan: span,
    toNext: Math.max(0, ceil - total),
    progress: Math.max(0, Math.min(1, (total - floor) / span)),
    title: levelTitle(level)
  };
}

/* Named tiers, because "Level 14" alone is a number and "Sharp" is an
   identity. Ten names across the arc so a title change is a real event. */
const TITLES = [
  [1, 'Warming up'], [3, 'Getting quick'], [6, 'Sharp'], [10, 'Fast hands'],
  [15, 'Mental athlete'], [22, 'Calculator'], [30, 'Lightning'],
  [42, 'Prodigy'], [60, 'Machine'], [85, 'Untouchable']
];
export function levelTitle(level) {
  let t = TITLES[0][1];
  for (const [min, name] of TITLES) if (level >= min) t = name;
  return t;
}

/* ============================================================ STREAKS

   A streak is the strongest reason to open the app on a day you don't feel
   like it. Freezes exist because one missed day destroying a 40-day streak
   makes people quit outright rather than start again — the punishment has to
   be survivable or it stops being motivating. */
export const STREAK_FREEZE_MAX = 2;
export const STREAK_FREEZE_MAX_PRO = 3;
export const STREAK_FREEZE_EARN_EVERY = 5;      // days played

export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];

export function milestoneReached(before, after) {
  return STREAK_MILESTONES.find(m => before < m && after >= m) ?? null;
}

export const milestoneXp = m => Math.min(500, 25 * Math.round(Math.sqrt(m) * 2));

/* Resolve a streak against today's date. Called on app open and after a run.

   `lastDay` is the last date the player recorded activity. Gaps are closed by
   spending freezes, one per missed day, oldest first. */
export function resolveStreak({ lastDay, dayStreak = 0, freezes = 0, today, isPro = false }) {
  const max = isPro ? STREAK_FREEZE_MAX_PRO : STREAK_FREEZE_MAX;
  freezes = Math.max(0, Math.min(max, freezes));

  if (!lastDay) return { dayStreak, freezes, used: 0, broken: false, lastDay };

  const gap = daysBetween(lastDay, today);
  if (gap <= 0) return { dayStreak, freezes, used: 0, broken: false, lastDay };
  if (gap === 1) return { dayStreak, freezes, used: 0, broken: false, lastDay };

  const missed = gap - 1;                  // days with no activity at all
  if (missed <= freezes) {
    return { dayStreak, freezes: freezes - missed, used: missed, broken: false, lastDay };
  }
  return { dayStreak: 0, freezes: 0, used: freezes, broken: true, lastDay };
}

/* Extend the streak for activity today. Idempotent: playing twice in a day
   does not double-count.

   This resolves any gap itself, so callers must NOT pre-resolve and pass the
   result in — doing that charges the same missed day twice and silently eats a
   freeze the player still had. `broken` is reported here for that reason. */
export function recordActivity({ lastDay, dayStreak = 0, freezes = 0, daysPlayed = 0, today, isPro = false }) {
  const max = isPro ? STREAK_FREEZE_MAX_PRO : STREAK_FREEZE_MAX;
  if (lastDay === today) {
    return { dayStreak, freezes, lastDay, daysPlayed, extended: false, milestone: null, broken: false, freezesUsed: 0 };
  }

  const resolved = resolveStreak({ lastDay, dayStreak, freezes, today, isPro });
  const before = resolved.dayStreak;
  const after = before + 1;
  const played = daysPlayed + 1;

  // A freeze is earned every N days played, not every N days of streak, so a
  // player who breaks a streak isn't also locked out of ever holding a buffer.
  let freezesNow = resolved.freezes;
  if (played % STREAK_FREEZE_EARN_EVERY === 0) freezesNow = Math.min(max, freezesNow + 1);

  return {
    dayStreak: after,
    freezes: freezesNow,
    lastDay: today,
    daysPlayed: played,
    extended: true,
    freezeEarned: freezesNow > resolved.freezes,
    freezesUsed: resolved.used,
    broken: resolved.broken,
    milestone: milestoneReached(before, after)
  };
}

/* How much trouble the streak is in, for the UI. "You'll lose it" beats
   "keep it up" every time. */
export function streakState({ lastDay, dayStreak = 0, freezes = 0, today, hoursLeftInDay = 24 }) {
  if (!dayStreak) return { status: 'none', dayStreak, freezes };
  if (lastDay === today) return { status: 'safe', dayStreak, freezes };
  const gap = lastDay ? daysBetween(lastDay, today) : 99;
  if (gap === 1) {
    return { status: hoursLeftInDay <= 6 ? 'urgent' : 'at_risk', dayStreak, freezes, hoursLeftInDay };
  }
  if (freezes > 0) return { status: 'frozen', dayStreak, freezes };
  return { status: 'broken', dayStreak: 0, freezes };
}

export function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO + 'T00:00:00Z');
  const b = Date.parse(toISO + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/* ============================================================ ACHIEVEMENTS

   Each is a pure predicate over a stats snapshot, so the same definitions
   drive the unlock check, the progress bars, and the tests. `goal` makes a
   partially-completed achievement legible — "740 / 1000 solved" is a reason to
   play, "locked" is not. */
export const ACHIEVEMENTS = [
  // volume — the long arc
  { code: 'solved_100', name: 'Getting started', desc: 'Answer 100 problems', tier: 'bronze', goal: 100, of: s => s.solved },
  { code: 'solved_1k', name: 'Four figures', desc: 'Answer 1,000 problems', tier: 'silver', goal: 1000, of: s => s.solved },
  { code: 'solved_10k', name: 'Five figures', desc: 'Answer 10,000 problems', tier: 'gold', goal: 10000, of: s => s.solved },
  { code: 'solved_50k', name: 'Obsessive', desc: 'Answer 50,000 problems', tier: 'platinum', goal: 50000, of: s => s.solved },

  // streaks — the retention core
  { code: 'streak_3', name: 'Three in a row', desc: 'Play 3 days running', tier: 'bronze', goal: 3, of: s => s.longestStreak },
  { code: 'streak_7', name: 'One week', desc: 'Play 7 days running', tier: 'bronze', goal: 7, of: s => s.longestStreak },
  { code: 'streak_30', name: 'One month', desc: 'Play 30 days running', tier: 'silver', goal: 30, of: s => s.longestStreak },
  { code: 'streak_100', name: 'Hundred days', desc: 'Play 100 days running', tier: 'gold', goal: 100, of: s => s.longestStreak },
  { code: 'streak_365', name: 'A whole year', desc: 'Play 365 days running', tier: 'platinum', goal: 365, of: s => s.longestStreak },

  // accuracy and speed — skill, not time served
  { code: 'perfect_run', name: 'Flawless', desc: 'Finish a run at 100% with 10+ problems', tier: 'bronze', goal: 1, of: s => s.perfectRuns },
  { code: 'perfect_10', name: 'Reliably flawless', desc: 'Ten flawless runs', tier: 'silver', goal: 10, of: s => s.perfectRuns },
  { code: 'streak_20_in_run', name: 'On a tear', desc: 'Hit a 20-answer streak in one run', tier: 'silver', goal: 20, of: s => s.bestStreak },
  { code: 'streak_50_in_run', name: 'Unstoppable', desc: 'Hit a 50-answer streak in one run', tier: 'gold', goal: 50, of: s => s.bestStreak },
  { code: 'speed_demon', name: 'Under two seconds', desc: 'Average under 2s across a 15+ problem run', tier: 'gold', goal: 1, of: s => s.subTwoSecondRuns },

  // daily challenge — the growth loop
  { code: 'daily_1', name: 'Showed up', desc: 'Complete a daily challenge', tier: 'bronze', goal: 1, of: s => s.dailiesDone },
  { code: 'daily_10', name: 'Regular', desc: 'Complete 10 daily challenges', tier: 'silver', goal: 10, of: s => s.dailiesDone },
  { code: 'daily_100', name: 'Fixture', desc: 'Complete 100 daily challenges', tier: 'gold', goal: 100, of: s => s.dailiesDone },
  { code: 'daily_perfect', name: 'Twelve from twelve', desc: 'Get a perfect daily challenge', tier: 'silver', goal: 1, of: s => s.perfectDailies },

  // modes — breadth
  { code: 'all_modes', name: 'Tried everything', desc: 'Play every game mode', tier: 'silver', goal: 8, of: s => s.modesPlayed },
  { code: 'zen_500', name: 'Meditative', desc: 'Answer 500 problems in Zen', tier: 'silver', goal: 500, of: s => s.zenSolved },
  { code: 'survival_25', name: 'Survivor', desc: 'Reach 25 correct in one Survival run', tier: 'gold', goal: 25, of: s => s.bestSurvival },
  { code: 'recall_9', name: 'Nine digits', desc: 'Recall a 9-digit number', tier: 'gold', goal: 9, of: s => s.bestRecallDigits },

  // mastery — the Pro arc
  { code: 'drill_1', name: 'Facing the weak spot', desc: 'Finish a drill', tier: 'bronze', goal: 1, of: s => s.drillsDone },
  { code: 'drill_25', name: 'Doing the work', desc: 'Finish 25 drills', tier: 'silver', goal: 25, of: s => s.drillsDone },
  { code: 'mastered_1', name: 'One down', desc: 'Master a bucket', tier: 'silver', goal: 1, of: s => s.bucketsMastered },
  { code: 'mastered_8', name: 'Half the board', desc: 'Master 8 buckets', tier: 'gold', goal: 8, of: s => s.bucketsMastered },
  { code: 'mastered_16', name: 'Complete', desc: 'Master every bucket', tier: 'platinum', goal: 16, of: s => s.bucketsMastered },

  // levels
  { code: 'level_5', name: 'Sharp', desc: 'Reach level 5', tier: 'bronze', goal: 5, of: s => s.level },
  { code: 'level_15', name: 'Mental athlete', desc: 'Reach level 15', tier: 'silver', goal: 15, of: s => s.level },
  { code: 'level_30', name: 'Lightning', desc: 'Reach level 30', tier: 'gold', goal: 30, of: s => s.level },
  { code: 'level_60', name: 'Machine', desc: 'Reach level 60', tier: 'platinum', goal: 60, of: s => s.level }
];

export const ACHIEVEMENT_BY_CODE = new Map(ACHIEVEMENTS.map(a => [a.code, a]));
export const TIER_XP = { bronze: 25, silver: 60, gold: 150, platinum: 400 };

export const EMPTY_SNAPSHOT = Object.freeze({
  solved: 0, longestStreak: 0, perfectRuns: 0, bestStreak: 0, subTwoSecondRuns: 0,
  dailiesDone: 0, perfectDailies: 0, modesPlayed: 0, zenSolved: 0, bestSurvival: 0,
  bestRecallDigits: 0, drillsDone: 0, bucketsMastered: 0, level: 1
});

/* Everything the player has now, with progress toward what they don't.
   `unlocked` is the set of codes already recorded, so a re-check never
   re-fires a notification for something earned last week. */
export function evaluateAchievements(snapshot, unlocked = []) {
  const have = new Set(unlocked);
  const s = { ...EMPTY_SNAPSHOT, ...snapshot };
  const all = [];
  const newlyUnlocked = [];

  for (const a of ACHIEVEMENTS) {
    const value = Math.max(0, Number(a.of(s)) || 0);
    const done = value >= a.goal;
    const row = {
      code: a.code, name: a.name, desc: a.desc, tier: a.tier,
      goal: a.goal, value: Math.min(value, a.goal),
      progress: Math.max(0, Math.min(1, value / a.goal)),
      unlocked: done || have.has(a.code),
      xp: TIER_XP[a.tier]
    };
    all.push(row);
    if (done && !have.has(a.code)) newlyUnlocked.push(row);
  }

  return {
    achievements: all,
    newlyUnlocked,
    unlockedCount: all.filter(a => a.unlocked).length,
    total: ACHIEVEMENTS.length,
    xpAwarded: newlyUnlocked.reduce((n, a) => n + a.xp, 0)
  };
}
