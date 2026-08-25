import { today, yesterday } from './util.js';
import { CONFIG } from './config.js';
import { K, sget, sset } from './store.js';

/* ============================================================ STATE
   One mutable object. `S.pro` is NOT authoritative — it is a cached mirror
   of what the server said in entitlement.js. Never write it from anything
   but setPro(). */
export const S = {
  screen: 'menu', game: 'blitz', difficulty: 'medium', ops: ['+', '-', '*', '/'],
  autoSubmit: true, sound: true, pro: false, licence: null,
  problem: null, input: '', picked: [],
  score: 0, streak: 0, bestStreak: 0, mult: 1,
  solved: 0, correct: 0, wrong: 0, times: [], marks: [],
  lives: 3, level: 1, timeLeft: 60, pLimit: 7, pTimeLeft: 7,
  runStart: 0, pStart: 0, locked: false, memorizing: false, isDaily: false,
  stats: null, meter: null,
  // server-backed, filled by entitlement.js / auth.js
  authed: false, user: null, plan: 'free', planStatus: 'none',
  currentPeriodEnd: null, cancelAtPeriodEnd: false,
  serverLimits: null,
  // drill run context, filled by drills.js
  drill: null, attempts: []
};

export const DEF_STATS = () => ({
  solved: 0, correct: 0, bestStreak: 0, best: {}, recent: [], days: [],
  ops: { '+': [0, 0], '-': [0, 0], '*': [0, 0], '/': [0, 0] }
});

export const DEF_METER = () => ({
  date: today(), runs: 0, rewards: 0,
  dailyDone: false, dailyScore: 0, dailyGrid: '', dayStreak: 0, lastDay: null
});

export async function loadAll() {
  const st = await sget(K.stats);
  S.stats = Object.assign(DEF_STATS(), st || {});
  S.stats.ops = Object.assign(DEF_STATS().ops, S.stats.ops || {});
  S.stats.best = Object.assign({}, S.stats.best || {});
  S.stats.recent = S.stats.recent || [];
  S.stats.days = S.stats.days || [];

  const pr = await sget(K.prefs);
  if (pr) {
    if (Array.isArray(pr.ops) && pr.ops.length) S.ops = pr.ops;
    if (pr.difficulty) S.difficulty = pr.difficulty;
    if (typeof pr.autoSubmit === 'boolean') S.autoSubmit = pr.autoSubmit;
    if (typeof pr.sound === 'boolean') S.sound = pr.sound;
  }

  // Local Pro flag. Phase 1 deletes this read: entitlement becomes
  // server-decided and a local key must never grant Pro.
  const en = await sget(K.ent);
  if (en && en.pro) { S.pro = true; S.licence = en.licence || null; }

  const m = Object.assign(DEF_METER(), (await sget(K.meter)) || {});
  if (m.date !== today()) {
    if (m.lastDay !== yesterday() && m.lastDay !== today()) m.dayStreak = 0;
    m.date = today(); m.runs = 0; m.rewards = 0;
    m.dailyDone = false; m.dailyScore = 0; m.dailyGrid = '';
  }
  S.meter = m;

  if (!S.pro && S.difficulty === 'expert') S.difficulty = 'hard';
}

export const saveStats = () => sset(K.stats, S.stats);
export const savePrefs = () => sset(K.prefs, { ops: S.ops, difficulty: S.difficulty, autoSubmit: S.autoSubmit, sound: S.sound });
export const saveMeter = () => sset(K.meter, S.meter);

/* ---- selectors -------------------------------------------------------- */

/* Free-run budget. Signed in: the server's count is authoritative and the
   local meter is only an optimistic mirror between /api/me refreshes.
   Anonymous: local only, and trivially bypassable — which is fine. */
export function freeRunCap() {
  return (S.serverLimits && typeof S.serverLimits.freeRuns === 'number')
    ? S.serverLimits.freeRuns : CONFIG.freeRuns;
}
export const runsLeft = () => S.pro ? Infinity : Math.max(0, freeRunCap() - S.meter.runs);
export const canRun = () => S.pro || runsLeft() > 0;

/* The single writer for entitlement-derived state. entitlement.js calls this
   with whatever /api/me returned; nothing else may set S.pro. */
export function setPro(ent) {
  S.pro = !!(ent && ent.isPro);
  S.plan = (ent && ent.plan) || 'free';
  S.planStatus = (ent && ent.status) || 'none';
  S.currentPeriodEnd = (ent && ent.currentPeriodEnd) || null;
  S.cancelAtPeriodEnd = !!(ent && ent.cancelAtPeriodEnd);
  if (!S.pro && S.difficulty === 'expert') { S.difficulty = 'hard'; savePrefs(); }
}

/* Reconcile the local run meter against the server's count. The client
   decrements optimistically for responsiveness; this pulls it back to truth. */
export function applyServerLimits(limits) {
  if (!limits) return;
  S.serverLimits = limits;
  if (typeof limits.runsUsedToday === 'number') {
    S.meter.runs = Math.max(S.meter.runs, limits.runsUsedToday);
    saveMeter();
  }
}
