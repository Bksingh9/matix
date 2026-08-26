import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  xpForRun, xpForLevel, levelFromXp, levelTitle,
  resolveStreak, recordActivity, streakState, milestoneReached, daysBetween,
  evaluateAchievements, ACHIEVEMENTS, TIER_XP, STREAK_FREEZE_MAX, STREAK_FREEZE_MAX_PRO
} from '../public/js/progression.js';

const att = (n, band = 2, correct = true) => Array.from({ length: n }, () => ({ isCorrect: correct, band }));

describe('XP', () => {
  test('pays per correct answer, scaled by band', () => {
    const easy = xpForRun({ attempts: att(10, 1), correct: 10, solved: 10 }).xp;
    const hard = xpForRun({ attempts: att(10, 4), correct: 10, solved: 10 }).xp;
    assert.ok(hard > easy, 'harder problems are worth more');
  });

  test('pays nothing for wrong answers', () => {
    const a = xpForRun({ attempts: att(10, 2, true), correct: 10, solved: 10 }).xp;
    const b = xpForRun({ attempts: att(10, 2, false), correct: 0, solved: 10 }).xp;
    assert.ok(a > b);
  });

  test('a beginner is not out-earned into irrelevance', () => {
    // Score rewards speed streaks, so a strong player can out-score a beginner
    // 10:1. XP is per problem, which keeps levelling reachable.
    const beginner = xpForRun({ attempts: att(12, 1), correct: 12, solved: 12, completed: true }).xp;
    const expert = xpForRun({ attempts: att(40, 2), correct: 40, solved: 40, completed: true }).xp;
    assert.ok(expert / beginner < 5, `ratio ${(expert / beginner).toFixed(1)}x should stay humane`);
  });

  test('the daily challenge pays a real premium', () => {
    const normal = xpForRun({ attempts: att(12, 2), correct: 12, solved: 12 }).xp;
    const daily = xpForRun({ attempts: att(12, 2), correct: 12, solved: 12, isDaily: true }).xp;
    // +30 daily, +20 perfect-daily, less the generic +15 flawless bonus that a
    // daily does not also collect.
    assert.ok(daily >= normal + 30, `daily ${daily} vs normal ${normal}`);
  });

  test('a perfect daily is worth more than a scrappy one', () => {
    const perfect = xpForRun({ attempts: att(12, 2), correct: 12, solved: 12, isDaily: true }).xp;
    const scrappy = xpForRun({ attempts: att(9, 2), correct: 9, solved: 12, isDaily: true }).xp;
    assert.ok(perfect > scrappy);
  });

  test('drills pay, because they are the Pro loop', () => {
    const drill = xpForRun({ attempts: att(20, 2), correct: 20, solved: 20, game: 'drill' }).xp;
    const blitz = xpForRun({ attempts: att(20, 2), correct: 20, solved: 20, game: 'blitz' }).xp;
    assert.ok(drill > blitz);
  });

  test('the first run of the day carries the streak bonus', () => {
    const first = xpForRun({ attempts: att(10, 2), correct: 10, solved: 10, isFirstOfDay: true, dayStreak: 10 });
    const later = xpForRun({ attempts: att(10, 2), correct: 10, solved: 10, isFirstOfDay: false, dayStreak: 10 });
    assert.ok(first.xp > later.xp);
    assert.ok(first.lines.some(l => l.code === 'streak'), 'and it is itemised so the player sees why');
  });

  test('the streak bonus is capped so a long streak is not a free pass', () => {
    const at20 = xpForRun({ attempts: [], isFirstOfDay: true, dayStreak: 20 }).xp;
    const at500 = xpForRun({ attempts: [], isFirstOfDay: true, dayStreak: 500 }).xp;
    assert.ok(at500 - at20 <= 100);
  });

  test('a flawless run needs enough problems to mean something', () => {
    const three = xpForRun({ attempts: att(3, 2), correct: 3, solved: 3 });
    assert.equal(three.lines.some(l => l.code === 'perfect'), false, '3/3 is not an achievement');
    const twelve = xpForRun({ attempts: att(12, 2), correct: 12, solved: 12 });
    assert.ok(twelve.lines.some(l => l.code === 'perfect'));
  });

  test('quitting pays less than finishing', () => {
    const quit = xpForRun({ attempts: att(10, 2), correct: 10, solved: 10, completed: false }).xp;
    const done = xpForRun({ attempts: att(10, 2), correct: 10, solved: 10, completed: true }).xp;
    assert.ok(done > quit);
  });

  test('every line is itemised and the total matches', () => {
    const r = xpForRun({ attempts: att(12, 3), correct: 12, solved: 12, isDaily: true, isFirstOfDay: true, dayStreak: 5 });
    assert.equal(r.lines.reduce((n, l) => n + l.xp, 0), r.xp);
    assert.ok(r.lines.every(l => l.label && typeof l.xp === 'number'));
  });

  test('an empty run does not go negative', () => {
    const r = xpForRun({ attempts: [], correct: 0, solved: 0, completed: false });
    assert.ok(r.xp >= 0);
  });
});

describe('levels', () => {
  test('level 1 starts at zero', () => {
    assert.equal(xpForLevel(1), 0);
    assert.equal(levelFromXp(0).level, 1);
  });

  test('thresholds increase strictly', () => {
    for (let l = 1; l < 80; l++) assert.ok(xpForLevel(l + 1) > xpForLevel(l), `level ${l + 1}`);
  });

  test('level 2 is reachable in a first session', () => {
    // Roughly two runs. A player who finishes a session still on level 1 has
    // been told the progression does not apply to them.
    const oneRun = xpForRun({ attempts: att(20, 2), correct: 20, solved: 20, isFirstOfDay: true, dayStreak: 1 }).xp;
    assert.ok(oneRun * 2 >= xpForLevel(2), `${oneRun} xp/run vs ${xpForLevel(2)} needed`);
  });

  test('later levels are a genuine arc', () => {
    assert.ok(xpForLevel(30) > 10 * xpForLevel(5));
  });

  test('reports progress within the level', () => {
    const mid = Math.floor((xpForLevel(5) + xpForLevel(6)) / 2);
    const l = levelFromXp(mid);
    assert.equal(l.level, 5);
    assert.ok(l.progress > 0.4 && l.progress < 0.6);
    assert.equal(l.intoLevel + l.toNext, l.levelSpan);
  });

  test('exactly on a threshold is the new level, not the old one', () => {
    assert.equal(levelFromXp(xpForLevel(7)).level, 7);
    assert.equal(levelFromXp(xpForLevel(7) - 1).level, 6);
  });

  test('titles change as an event, not every level', () => {
    assert.equal(levelTitle(1), 'Warming up');
    assert.equal(levelTitle(6), 'Sharp');
    assert.equal(levelTitle(100), 'Untouchable');
    const distinct = new Set(Array.from({ length: 100 }, (_, i) => levelTitle(i + 1)));
    assert.ok(distinct.size >= 8 && distinct.size <= 12, `${distinct.size} distinct titles`);
  });

  test('absurd and junk XP does not break it', () => {
    assert.equal(levelFromXp(-500).level, 1);
    assert.equal(levelFromXp(NaN).level, 1);
    assert.equal(levelFromXp(undefined).level, 1);
    assert.ok(levelFromXp(1e9).level <= 200, 'bounded');
  });
});

describe('streaks', () => {
  test('same day is a no-op', () => {
    const r = resolveStreak({ lastDay: '2026-08-26', dayStreak: 9, freezes: 1, today: '2026-08-26' });
    assert.equal(r.dayStreak, 9);
    assert.equal(r.used, 0);
  });

  test('consecutive days hold the streak', () => {
    const r = resolveStreak({ lastDay: '2026-08-25', dayStreak: 9, freezes: 0, today: '2026-08-26' });
    assert.equal(r.broken, false);
    assert.equal(r.dayStreak, 9);
  });

  test('one missed day spends one freeze', () => {
    const r = resolveStreak({ lastDay: '2026-08-24', dayStreak: 40, freezes: 2, today: '2026-08-26' });
    assert.equal(r.broken, false, '40 days should not die to one bad Tuesday');
    assert.equal(r.dayStreak, 40);
    assert.equal(r.freezes, 1);
    assert.equal(r.used, 1);
  });

  test('more missed days than freezes breaks it', () => {
    const r = resolveStreak({ lastDay: '2026-08-20', dayStreak: 40, freezes: 2, today: '2026-08-26' });
    assert.equal(r.broken, true);
    assert.equal(r.dayStreak, 0);
    assert.equal(r.freezes, 0);
  });

  test('freezes are capped, and Pro gets one more', () => {
    assert.equal(resolveStreak({ lastDay: '2026-08-25', dayStreak: 5, freezes: 99, today: '2026-08-26' }).freezes, STREAK_FREEZE_MAX);
    assert.equal(resolveStreak({ lastDay: '2026-08-25', dayStreak: 5, freezes: 99, today: '2026-08-26', isPro: true }).freezes, STREAK_FREEZE_MAX_PRO);
  });

  test('a first-ever day starts at one', () => {
    const r = recordActivity({ lastDay: null, dayStreak: 0, today: '2026-08-26' });
    assert.equal(r.dayStreak, 1);
    assert.equal(r.extended, true);
  });

  test('playing twice in a day does not double-count', () => {
    const first = recordActivity({ lastDay: '2026-08-25', dayStreak: 3, daysPlayed: 3, today: '2026-08-26' });
    assert.equal(first.dayStreak, 4);
    const second = recordActivity({ lastDay: first.lastDay, dayStreak: first.dayStreak, daysPlayed: first.daysPlayed, today: '2026-08-26' });
    assert.equal(second.dayStreak, 4);
    assert.equal(second.extended, false);
  });

  test('a freeze is earned every fifth day played', () => {
    let s = { lastDay: null, dayStreak: 0, freezes: 0, daysPlayed: 0 };
    const days = ['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25'];
    for (const d of days) s = recordActivity({ ...s, today: d });
    assert.equal(s.dayStreak, 5);
    assert.equal(s.freezes, 1);
    assert.equal(s.freezeEarned, true);
  });

  test('freezes accrue on days played, not days of streak', () => {
    // Someone who breaks a streak must still be able to build a buffer, or the
    // mechanic only ever helps people who never needed it.
    let s = { lastDay: '2026-08-01', dayStreak: 0, freezes: 0, daysPlayed: 9 };
    s = recordActivity({ ...s, today: '2026-08-26' });
    assert.equal(s.dayStreak, 1, 'streak restarted');
    assert.equal(s.freezes, 1, 'but the tenth day played still earns a freeze');
  });

  test('milestones fire once, on crossing', () => {
    assert.equal(milestoneReached(6, 7), 7);
    assert.equal(milestoneReached(7, 8), null);
    assert.equal(milestoneReached(29, 30), 30);
    const r = recordActivity({ lastDay: '2026-08-25', dayStreak: 6, daysPlayed: 6, today: '2026-08-26' });
    assert.equal(r.milestone, 7);
  });

  test('state escalates as the day runs out', () => {
    const base = { lastDay: '2026-08-25', dayStreak: 12, freezes: 1, today: '2026-08-26' };
    assert.equal(streakState({ ...base, hoursLeftInDay: 14 }).status, 'at_risk');
    assert.equal(streakState({ ...base, hoursLeftInDay: 3 }).status, 'urgent');
    assert.equal(streakState({ ...base, lastDay: '2026-08-26' }).status, 'safe');
    assert.equal(streakState({ ...base, dayStreak: 0 }).status, 'none');
  });

  test('a gap with freezes in hand reads as frozen, not broken', () => {
    assert.equal(streakState({ lastDay: '2026-08-23', dayStreak: 12, freezes: 2, today: '2026-08-26' }).status, 'frozen');
    assert.equal(streakState({ lastDay: '2026-08-23', dayStreak: 12, freezes: 0, today: '2026-08-26' }).status, 'broken');
  });

  test('daysBetween handles month and year boundaries', () => {
    assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);   // 2026 is not a leap year
    assert.equal(daysBetween('2026-08-26', '2026-08-26'), 0);
    assert.equal(daysBetween('nonsense', '2026-08-26'), 0);
  });
});

describe('achievements', () => {
  test('every definition is well-formed and uniquely coded', () => {
    const codes = new Set();
    for (const a of ACHIEVEMENTS) {
      assert.ok(a.code && !codes.has(a.code), `duplicate or missing code: ${a.code}`);
      codes.add(a.code);
      assert.ok(a.name && a.desc, `${a.code} needs a name and description`);
      assert.ok(TIER_XP[a.tier], `${a.code} has an unknown tier ${a.tier}`);
      assert.ok(a.goal > 0, `${a.code} needs a positive goal`);
      assert.equal(typeof a.of, 'function');
    }
    assert.ok(ACHIEVEMENTS.length >= 25, `${ACHIEVEMENTS.length} achievements`);
  });

  test('a fresh player has none unlocked but sees every goal', () => {
    const r = evaluateAchievements({});
    assert.equal(r.unlockedCount, 0);
    assert.equal(r.achievements.length, ACHIEVEMENTS.length);
    // value, not zero: level starts at 1, so the level achievements begin
    // with a point on the board.
    assert.ok(r.achievements.every(a => a.goal > 0 && a.value < a.goal && a.progress < 1));
  });

  test('progress is legible before the unlock', () => {
    // "740 / 1000 solved" is a reason to play. "Locked" is not.
    const r = evaluateAchievements({ solved: 740 });
    const a = r.achievements.find(x => x.code === 'solved_1k');
    assert.equal(a.unlocked, false);
    assert.equal(a.value, 740);
    assert.ok(Math.abs(a.progress - 0.74) < 0.001);
  });

  test('crossing a goal unlocks it and awards XP', () => {
    const r = evaluateAchievements({ solved: 1000 });
    assert.ok(r.newlyUnlocked.some(a => a.code === 'solved_1k'));
    assert.ok(r.newlyUnlocked.some(a => a.code === 'solved_100'), 'and anything else now met');
    assert.equal(r.xpAwarded, r.newlyUnlocked.reduce((n, a) => n + a.xp, 0));
  });

  test('an already-recorded achievement does not re-fire', () => {
    const r = evaluateAchievements({ solved: 5000 }, ['solved_100', 'solved_1k']);
    assert.equal(r.newlyUnlocked.some(a => a.code === 'solved_1k'), false, 'no duplicate notification');
    assert.ok(r.achievements.find(a => a.code === 'solved_1k').unlocked, 'but still shown as earned');
    assert.equal(r.xpAwarded, 0);
  });

  test('progress never exceeds the goal', () => {
    const r = evaluateAchievements({ solved: 99999, longestStreak: 9999, level: 999 });
    assert.ok(r.achievements.every(a => a.value <= a.goal && a.progress <= 1));
  });

  test('the full set is achievable and covers every retention lever', () => {
    const r = evaluateAchievements({
      solved: 50000, longestStreak: 365, perfectRuns: 10, bestStreak: 50,
      subTwoSecondRuns: 1, dailiesDone: 100, perfectDailies: 1, modesPlayed: 8,
      zenSolved: 500, bestSurvival: 25, bestRecallDigits: 9, drillsDone: 25,
      bucketsMastered: 16, level: 60
    });
    assert.equal(r.unlockedCount, ACHIEVEMENTS.length, 'nothing is unreachable');
    for (const lever of ['streak', 'daily', 'drill', 'mastered', 'level', 'solved']) {
      assert.ok(ACHIEVEMENTS.some(a => a.code.startsWith(lever)), `no achievement covers ${lever}`);
    }
  });

  test('junk in a snapshot does not throw or unlock anything', () => {
    const r = evaluateAchievements({ solved: null, level: undefined, longestStreak: NaN, bestStreak: 'lots' });
    assert.equal(r.unlockedCount, 0);
    assert.ok(r.achievements.every(a => Number.isFinite(a.progress)));
  });
});
