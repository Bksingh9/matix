import { S } from './state.js';
import { K, sget, sset } from './store.js';
import { track } from './analytics.js';
import { $, fmt } from './util.js';
import { esc } from './ui.js';
import { get } from './api.js';
import {
  xpForRun, levelFromXp, recordActivity, resolveStreak, streakState,
  evaluateAchievements, milestoneXp, ACHIEVEMENTS
} from './progression.js';

/* Progression on the client.
 *
 * Two jobs:
 *  1. Anonymous players get the full loop locally — XP, levels, streaks and
 *     achievements. Gating progression behind sign-in would mean the retention
 *     mechanic only starts working after the moment it exists to survive.
 *  2. Signed-in players get the server's numbers, which are authoritative;
 *     the local copy becomes a mirror.
 */

const DEF = () => ({
  xp: 0, dayStreak: 0, longestStreak: 0, freezes: 0, daysPlayed: 0, lastDay: null,
  unlocked: [],
  solved: 0, correct: 0, bestRunStreak: 0, perfectRuns: 0, subTwoSecondRuns: 0,
  dailiesDone: 0, perfectDailies: 0, drillsDone: 0, zenSolved: 0,
  bestSurvival: 0, bestRecallDigits: 0, modesPlayed: []
});

let local = DEF();
let server = null;

export const progressView = () => server || localView();
export const isServerBacked = () => !!server;

function localView() {
  const today = utcToday();
  const resolved = resolveStreak({ lastDay: local.lastDay, dayStreak: local.dayStreak, freezes: local.freezes, today, isPro: S.pro });
  const ach = evaluateAchievements(snapshot(), local.unlocked);
  return {
    authed: false,
    level: levelFromXp(local.xp),
    streak: {
      ...streakState({ lastDay: local.lastDay, dayStreak: resolved.dayStreak, freezes: resolved.freezes, today, hoursLeftInDay: 24 - new Date().getUTCHours() }),
      longest: local.longestStreak, daysPlayed: local.daysPlayed, lastDay: local.lastDay
    },
    totals: {
      solved: local.solved, correct: local.correct,
      accuracy: local.solved ? local.correct / local.solved : null,
      dailiesDone: local.dailiesDone, drillsDone: local.drillsDone,
      bestRunStreak: local.bestRunStreak, modesPlayed: local.modesPlayed.length
    },
    achievements: ach.achievements,
    achievementsUnlocked: ach.unlockedCount,
    achievementsTotal: ach.total
  };
}

const snapshot = () => ({
  solved: local.solved, longestStreak: local.longestStreak, perfectRuns: local.perfectRuns,
  bestStreak: local.bestRunStreak, subTwoSecondRuns: local.subTwoSecondRuns,
  dailiesDone: local.dailiesDone, perfectDailies: local.perfectDailies,
  modesPlayed: local.modesPlayed.length, zenSolved: local.zenSolved,
  bestSurvival: local.bestSurvival, bestRecallDigits: local.bestRecallDigits,
  drillsDone: local.drillsDone, level: levelFromXp(local.xp).level, bucketsMastered: 0
});

export async function initProgress() {
  local = Object.assign(DEF(), (await sget(K.progress)) || {});
  local.unlocked = local.unlocked || [];
  local.modesPlayed = local.modesPlayed || [];
}

const save = () => sset(K.progress, local);

/* Pull the server's numbers after sign-in. They win. */
export async function refreshProgress() {
  if (!S.authed) { server = null; return localView(); }
  try {
    const r = await get('/api/progress');
    server = r && r.authed ? r : null;
    return server || localView();
  } catch {
    server = null;
    return localView();
  }
}

export function applyServerProgress(p) {
  if (!p) return;
  // /api/runs returns the delta; merge it into the cached view so the profile
  // is current without a second round-trip.
  server = server || { authed: true, totals: {}, achievements: [], achievementsTotal: p.achievementsTotal };
  server.level = p.level;
  server.streak = { ...(server.streak || {}), ...p.streak, status: p.streak.extended ? 'safe' : (server.streak?.status || 'safe') };
  server.achievementsUnlocked = p.achievementsUnlocked;
  server.achievementsTotal = p.achievementsTotal;
}

/* ============================================================ LOCAL RUN
   Mirrors lib/progress-store.js applyRun() for an anonymous player. Same
   module does the arithmetic, so the two cannot drift. */
export function applyLocalRun({ game, isDaily, solved, correct, bestStreak, durationMs, attempts }) {
  const today = utcToday();
  const isFirstOfDay = local.lastDay !== today;
  const key = isDaily ? 'daily' : game;

  // recordActivity resolves the gap itself — see the note on it.
  const activity = recordActivity({
    lastDay: local.lastDay, dayStreak: local.dayStreak, freezes: local.freezes,
    daysPlayed: local.daysPlayed, today, isPro: S.pro
  });

  const runXp = xpForRun({ attempts, game: key, isDaily, solved, correct, isFirstOfDay, dayStreak: activity.dayStreak, completed: true });
  const lines = [...runXp.lines];
  let gain = runXp.xp;

  if (activity.milestone) {
    const bonus = milestoneXp(activity.milestone);
    gain += bonus;
    lines.push({ code: 'milestone', label: `${activity.milestone}-day milestone`, xp: bonus });
  }

  const avgMs = solved ? (durationMs || 0) / solved : Infinity;
  const perfect = solved >= 10 && correct === solved;

  local.solved += solved;
  local.correct += correct;
  local.bestRunStreak = Math.max(local.bestRunStreak, bestStreak || 0);
  local.perfectRuns += perfect ? 1 : 0;
  local.subTwoSecondRuns += (solved >= 15 && avgMs < 2000) ? 1 : 0;
  local.dailiesDone += isDaily ? 1 : 0;
  local.perfectDailies += (isDaily && solved > 0 && correct === solved) ? 1 : 0;
  local.drillsDone += game === 'drill' ? 1 : 0;
  local.zenSolved += game === 'zen' ? solved : 0;
  local.bestSurvival = Math.max(local.bestSurvival, game === 'survival' ? correct : 0);
  local.bestRecallDigits = Math.max(local.bestRecallDigits, maxRecallDigits(attempts));
  if (!local.modesPlayed.includes(key)) local.modesPlayed.push(key);
  local.dayStreak = activity.dayStreak;
  local.longestStreak = Math.max(local.longestStreak, activity.dayStreak);
  local.freezes = activity.freezes;
  local.daysPlayed = activity.daysPlayed;
  local.lastDay = activity.lastDay;

  const beforeLevel = levelFromXp(local.xp);
  const ach = evaluateAchievements({ ...snapshot(), level: levelFromXp(local.xp + gain).level }, local.unlocked);
  if (ach.xpAwarded) {
    gain += ach.xpAwarded;
    lines.push({ code: 'achievements', label: ach.newlyUnlocked.length === 1 ? 'Achievement' : `${ach.newlyUnlocked.length} achievements`, xp: ach.xpAwarded });
  }
  for (const a of ach.newlyUnlocked) if (!local.unlocked.includes(a.code)) local.unlocked.push(a.code);

  local.xp += gain;
  const afterLevel = levelFromXp(local.xp);
  save();

  return {
    xpGained: gain, xpLines: lines, xp: local.xp, level: afterLevel,
    levelledUp: afterLevel.level > beforeLevel.level,
    levelsGained: afterLevel.level - beforeLevel.level,
    streak: {
      dayStreak: activity.dayStreak, longest: local.longestStreak, freezes: activity.freezes,
      freezeEarned: !!activity.freezeEarned, freezesUsed: activity.freezesUsed || 0,
      milestone: activity.milestone, extended: activity.extended, wasBroken: activity.broken
    },
    achievements: ach.newlyUnlocked,
    achievementsUnlocked: ach.unlockedCount,
    achievementsTotal: ach.total
  };
}

/* The local copy comes with the player on sign-in, same as stats. */
export const localProgressForMigration = () => ({ ...local });

function maxRecallDigits(attempts) {
  let max = 0;
  for (const a of attempts || []) {
    if (a.kind !== 'recall' || !a.isCorrect) continue;
    const n = a.answer == null ? 0 : String(Math.abs(a.answer)).length;
    if (n > max) max = n;
  }
  return max;
}

export const utcToday = () => new Date().toISOString().slice(0, 10);

/* ============================================================ REWARD MOMENTS

   The numbers are useless if the player never sees them move. Each of these is
   a deliberate beat on the results screen: XP counting up, a level-up card, a
   streak milestone, an achievement toast. */

export function renderXpPanel(p) {
  const el = $('#r-xp');
  if (!el || !p) return;

  el.innerHTML =
    '<div class="xp-head">'
    + '<span class="xp-total">+' + fmt(p.xpGained) + ' XP</span>'
    + '<span class="xp-level">Lv ' + p.level.level + ' · ' + esc(p.level.title) + '</span>'
    + '</div>'
    + '<div class="xp-bar"><i style="width:0%"></i></div>'
    + '<div class="xp-next">' + (p.level.toNext > 0 ? fmt(p.level.toNext) + ' XP to level ' + (p.level.level + 1) : 'Max level') + '</div>'
    + '<div class="xp-lines">'
    + p.xpLines.map(l => '<div class="xp-line"><span>' + esc(l.label) + '</span><span>+' + l.xp + '</span></div>').join('')
    + '</div>';
  el.classList.add('show');

  // Animate on the next frame so the transition actually runs.
  requestAnimationFrame(() => {
    const bar = el.querySelector('.xp-bar i');
    if (bar) bar.style.width = (p.level.progress * 100).toFixed(1) + '%';
  });

  if (p.levelledUp) showLevelUp(p);
  if (p.streak?.milestone) showStreakMilestone(p.streak);
  if (p.achievements?.length) showAchievements(p.achievements);
  if (p.streak?.freezesUsed) showFreezeUsed(p.streak);
}

function showLevelUp(p) {
  track('level_up', { level: p.level.level, title: p.level.title });
  toast({
    kind: 'level',
    glyph: '★',
    title: 'Level ' + p.level.level,
    body: p.level.title + (p.levelsGained > 1 ? ` · ${p.levelsGained} levels at once` : '')
  });
}

function showStreakMilestone(streak) {
  track('streak_milestone', { days: streak.milestone });
  toast({
    kind: 'streak',
    glyph: '🔥',
    title: streak.milestone + ' days in a row',
    body: streak.milestone >= 100 ? 'That is genuinely rare. Keep it.' : 'Come back tomorrow and make it ' + (streak.milestone + 1) + '.'
  });
}

function showFreezeUsed(streak) {
  toast({
    kind: 'freeze',
    glyph: '❄',
    title: 'Streak saved',
    body: (streak.freezesUsed === 1 ? 'A streak freeze' : streak.freezesUsed + ' streak freezes')
      + ' covered the day' + (streak.freezesUsed === 1 ? '' : 's') + ' you missed. '
      + (streak.freezes > 0 ? streak.freezes + ' left.' : 'None left — play daily to earn more.')
  });
}

function showAchievements(list) {
  for (const a of list) {
    track('achievement_unlocked', { code: a.code, tier: a.tier });
    toast({ kind: 'ach ' + a.tier, glyph: TIER_GLYPH[a.tier] || '◆', title: a.name, body: a.desc, xp: a.xp });
  }
}

const TIER_GLYPH = { bronze: '◆', silver: '◆', gold: '★', platinum: '✦' };

/* A queue, not a stack of overlapping cards: three unlocks at once should read
   as three moments, not one pile. */
const queue = [];
let showing = false;

export function toast({ kind, glyph, title, body, xp }) {
  queue.push({ kind, glyph, title, body, xp });
  if (!showing) next();
}

function next() {
  const item = queue.shift();
  const host = $('#toasts');
  if (!item || !host) { showing = false; return; }
  showing = true;

  const el = document.createElement('div');
  el.className = 'toast ' + (item.kind || '');
  el.innerHTML = '<span class="t-glyph">' + esc(item.glyph || '◆') + '</span>'
    + '<span class="t-text"><b>' + esc(item.title) + '</b>'
    + (item.body ? '<span>' + esc(item.body) + '</span>' : '') + '</span>'
    + (item.xp ? '<span class="t-xp">+' + item.xp + '</span>' : '');
  host.appendChild(el);

  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => { el.remove(); next(); }, 260);
  }, 2600);
}

/* ============================================================ PROFILE SHEET */
export async function openProfile(src) {
  const m = $('#profm');
  if (!m) return;
  m.classList.add('show');
  track('profile_view', { source: src || 'topbar' });

  const p = await refreshProgress();
  renderProfile(p);
}

export const closeProfile = () => { const m = $('#profm'); if (m) m.classList.remove('show'); };

function renderProfile(p) {
  const body = $('#prof-body');
  if (!body || !p) return;

  const st = p.streak || {};
  const t = p.totals || {};
  const acc = t.accuracy != null ? Math.round(t.accuracy * 100) + '%' : '—';

  body.innerHTML =
    '<div class="prof-level">'
    + '<div class="pl-ring"><span>' + p.level.level + '</span></div>'
    + '<div class="pl-meta">'
    + '<b>' + esc(p.level.title) + '</b>'
    + '<span>' + fmt(p.level.xp) + ' XP · ' + (p.level.toNext > 0 ? fmt(p.level.toNext) + ' to level ' + (p.level.level + 1) : 'max') + '</span>'
    + '<div class="xp-bar"><i style="width:' + (p.level.progress * 100).toFixed(1) + '%"></i></div>'
    + '</div></div>'

    + '<div class="prof-streak ' + (st.status || '') + '">'
    + '<span class="ps-big">🔥 ' + (st.dayStreak || 0) + '</span>'
    + '<span class="ps-meta">' + streakCopy(st) + '</span>'
    + '</div>'

    + '<div class="prof-grid">'
    + statTile('Solved', fmt(t.solved || 0))
    + statTile('Accuracy', acc)
    + statTile('Best streak', fmt(t.bestRunStreak || 0))
    + statTile('Dailies', fmt(t.dailiesDone || 0))
    + '</div>'

    + '<div class="prof-sec">Achievements <span>' + p.achievementsUnlocked + ' / ' + p.achievementsTotal + '</span></div>'
    + '<div class="ach-list">'
    + [...(p.achievements || [])]
      .sort((a, b) => (b.unlocked - a.unlocked) || (b.progress - a.progress))
      .map(a =>
        '<div class="ach' + (a.unlocked ? ' on' : '') + ' ' + a.tier + '">'
        + '<span class="a-glyph">' + (TIER_GLYPH[a.tier] || '◆') + '</span>'
        + '<span class="a-text"><b>' + esc(a.name) + '</b><span>' + esc(a.desc) + '</span>'
        + (a.unlocked ? '' : '<div class="a-bar"><i style="width:' + (a.progress * 100).toFixed(0) + '%"></i></div>')
        + '</span>'
        + '<span class="a-val">' + (a.unlocked ? '✓' : fmt(a.value) + '/' + fmt(a.goal)) + '</span>'
        + '</div>').join('')
    + '</div>'
    + (p.authed ? '' : '<div class="prof-note">Signed out — this progress lives in this browser only. Sign in and it follows you to any device.</div>');
}

function statTile(k, v) {
  return '<div class="prof-tile"><span class="pt-v">' + v + '</span><span class="pt-k">' + k + '</span></div>';
}

function streakCopy(st) {
  switch (st.status) {
    case 'safe': return 'Played today. Longest: ' + (st.longest || 0) + '.';
    case 'urgent': return 'Play today or you lose it — ' + (st.hoursLeftInDay || 0) + 'h left.';
    case 'at_risk': return 'Play today to keep it going.';
    case 'frozen': return (st.freezes || 0) + ' freeze' + (st.freezes === 1 ? '' : 's') + ' holding it. Play today to be safe.';
    case 'broken': return 'Broken. Play today to start again.';
    default: return 'Play today to start a streak.';
  }
}

export { ACHIEVEMENTS };
