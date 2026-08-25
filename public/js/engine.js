import { S, saveStats, saveMeter, canRun } from './state.js';
import { GAMES, generate, diff, seedFromDate, useSystemRandom } from './games.js';
import { audio, beep } from './audio.js';
import { track } from './analytics.js';
import { $, now, today, yesterday, OPSYM, fmt } from './util.js';
import { openPaywall, openReward } from './paywall.js';
import {
  setScreen, renderRuns, renderResults, showPanel, renderChips, updAnswer,
  flashGood, flashBad, updScore, updStreak, updCenter, updBar, syncSound, gridString
} from './ui.js';

/* ============================================================ GATING */
export function gateGame(id) {
  const g = GAMES[id];
  if (g.pro && !S.pro) {
    openPaywall('**' + g.name + '** is a Pro game. Pro also lifts the daily run cap and unlocks your weak-spot report.', 'game_locked:' + id);
    return false;
  }
  if (!canRun()) { track('limit_hit', { game: id }); openReward('limit:' + id); return false; }
  return true;
}

function consumeRun() {
  if (S.pro) return;
  S.meter.runs++;
  saveMeter();
  renderRuns();
}

/* ============================================================ LIFECYCLE */
export function startRun(id, isDaily) {
  if (isDaily) {
    if (S.meter.dailyDone) { showDailyResult(); return; }
    const d = today();
    seedFromDate(d);
    S.isDaily = true; S.game = 'daily';
    track('daily_start', { date: d });
  } else {
    useSystemRandom();
    S.isDaily = false; S.game = id;
    consumeRun();
    track('game_start', { game: id, difficulty: S.difficulty, pro: S.pro });
  }
  const g = GAMES[S.game];
  S.score = 0; S.streak = 0; S.bestStreak = 0; S.mult = 1;
  S.solved = 0; S.correct = 0; S.wrong = 0; S.times = []; S.marks = []; S.attempts = [];
  S.lives = g.lives || 3; S.level = 1; S.locked = false; S.input = ''; S.picked = [];
  S.problem = null; S.memorizing = false;
  S.timeLeft = g.duration || 60; S.runStart = now(); lastTs = null;
  if (id !== 'drill') S.drill = null;
  syncSound();
  $('#zen-end').classList.toggle('show', S.game === 'zen');
  setScreen('game');
  updScore(); updStreak();
  nextProblem();
}

export function nextProblem() {
  if (S.screen !== 'game') return;
  S.problem = nextSource();
  if (!S.problem) { endRun(S.game === 'drill' ? 'drill' : 'done'); return; }
  S.input = ''; S.picked = []; S.locked = false;
  const p = S.problem, g = GAMES[S.game];
  if (!S.isDaily && g.timer === 'problem' && S.game !== 'drill') {
    const l = Math.floor(S.correct / 3) + 1;
    S.level = l;
    S.pLimit = Math.max(3.5, 7 - .25 * (l - 1));
    S.pTimeLeft = S.pLimit;
  }
  $('#card').classList.remove('fc', 'fw', 'shake');
  $('#prompt').classList.toggle('small', !!p.small);
  $('#subprompt').textContent = p.sub || '';
  $('#prompt').innerHTML = p.html;
  showPanel(p.kind);
  const showAns = (p.kind === 'pad' || p.kind === 'recall' || p.kind === 'chips');
  $('#answerline').style.visibility = showAns ? 'visible' : 'hidden';
  if (p.kind === 'chips') { renderChips(p); $('#answerline').innerHTML = '<span class="eq">Σ</span><span class="typed">0</span>'; }
  else updAnswer();
  if (p.kind === 'recall') {
    S.memorizing = true; S.locked = true; beep('tick');
    setTimeout(() => {
      if (S.screen !== 'game' || S.problem !== p) return;
      let m = '';
      for (let i = 0; i < p.digits.length; i++) m += '▮ ';
      $('#prompt').innerHTML = '<span class="hide">' + m.trim() + '</span>';
      $('#subprompt').textContent = 'Type it back';
      S.memorizing = false; S.locked = false; S.pStart = now();
      if (GAMES[S.game].timer === 'problem') S.pTimeLeft = S.pLimit;
    }, p.showMs);
  } else S.pStart = now();
  updCenter(); updBar();
}

/* Drill mode plays a server-generated set in order; everything else
   generates locally. Registered by drills.js to avoid engine → drills. */
let drillSource = null;
export const setDrillSource = fn => { drillSource = fn; };
function nextSource() {
  if (S.game === 'drill' && drillSource) return drillSource();
  return generate();
}

/* ============================================================ SCORING */
function updMult() { const s = S.streak; S.mult = s >= 15 ? 3 : s >= 10 ? 2.5 : s >= 6 ? 2 : s >= 3 ? 1.5 : 1; }

function points(t) {
  const d = diff();
  const base = { easy: 10, medium: 16, hard: 26, expert: 38 }[d] || 16;
  const ideal = { easy: 3.5, medium: 4.5, hard: 6, expert: 7.5 }[d] || 4.5;
  const bonus = Math.round(base * .8 * Math.max(0, Math.min(1, (ideal - t) / ideal)));
  return Math.max(1, Math.round((base + bonus) * S.mult));
}

/* ============================================================ SUBMISSIONS */
export function submitPad() {
  if (S.locked || S.input === '') return;
  const t = (now() - S.pStart) / 1000;
  S.locked = true; S.solved++;
  const given = parseInt(S.input, 10);
  if (given === S.problem.answer) good(t, given); else bad(String(S.problem.answer), t, given);
}

export function submitTF(v) {
  if (S.locked) return;
  const t = (now() - S.pStart) / 1000;
  S.locked = true; S.solved++;
  if (v === S.problem.answer) good(t, v); else bad(S.problem.answer ? 'True' : 'False', t, v);
}

export function submitOp(op) {
  if (S.locked) return;
  const t = (now() - S.pStart) / 1000;
  S.locked = true; S.solved++;
  if (op === S.problem.answer) good(t, op); else bad(OPSYM[S.problem.answer], t, op);
}

export function chipTap(i) {
  if (S.locked) return;
  const p = S.problem;
  if (i >= p.pool.length) return;
  const at = S.picked.indexOf(i);
  if (at >= 0) S.picked.splice(at, 1); else S.picked.push(i);
  document.querySelectorAll('#panel-chips .chipkey[data-i]').forEach(c => c.classList.toggle('picked', S.picked.indexOf(+c.dataset.i) >= 0));
  const sum = S.picked.reduce((a, x) => a + p.pool[x], 0);
  $('#answerline').innerHTML = '<span class="eq">Σ</span><span class="typed' + (sum > p.answer ? ' wrong' : '') + '">' + sum + '</span>';
  if (sum === p.answer) { const t = (now() - S.pStart) / 1000; S.locked = true; S.solved++; good(t, sum); }
  else if (sum > p.answer) { S.locked = true; S.solved++; bad('Over', (now() - S.pStart) / 1000, sum); }
}

export function digit(d) {
  if (S.locked || S.memorizing || S.screen !== 'game') return;
  audio();
  const len = String(S.problem.answer).length;
  const cap = S.autoSubmit ? len : Math.max(len + 1, 6);
  if (S.input.length >= cap) return;
  S.input += d;
  updAnswer();
  if (S.autoSubmit && S.input.length >= len) submitPad();
}

/* ============================================================ OUTCOMES */
function good(t, given) {
  S.correct++; S.times.push(t); S.streak++; S.marks.push(1);
  if (S.streak > S.bestStreak) S.bestStreak = S.streak;
  updMult();
  const pts = points(t);
  S.score += pts;
  tally(true);
  logAttempt({ correct: true, timedOut: false, elapsedMs: Math.round(t * 1000), given });
  beep('ok'); flashGood(pts); updScore(); updStreak(); updCenter(); updBar();
  if (S.isDaily && S.solved >= GAMES.daily.total) { setTimeout(() => endRun('done'), 380); return; }
  setTimeout(nextProblem, 240);
}

function bad(show, t, given) {
  S.wrong++; S.streak = 0; S.mult = 1; S.marks.push(0);
  updStreak();
  tally(false);
  logAttempt({ correct: false, timedOut: false, elapsedMs: Math.round((t || 0) * 1000), given });
  beep('no'); flashBad(show);
  if (S.isDaily) {
    if (S.solved >= GAMES.daily.total) { setTimeout(() => endRun('done'), 800); return; }
    setTimeout(nextProblem, 700);
    return;
  }
  // Drill mode is practice, not a test: a miss costs no life.
  if (GAMES[S.game].timer === 'problem' && S.game !== 'drill') {
    S.lives--;
    updCenter();
    setTimeout(() => { if (S.lives <= 0) endRun('dead'); else nextProblem(); }, 820);
  } else setTimeout(nextProblem, 680);
}

function timeoutProblem() {
  if (S.locked || S.memorizing) return;
  S.locked = true; S.solved++; S.wrong++; S.streak = 0; S.mult = 1; S.marks.push(0);
  updStreak();
  tally(false);
  logAttempt({ correct: false, timedOut: true, elapsedMs: Math.round(S.pLimit * 1000), given: null });
  S.lives--;
  updCenter(); beep('no');
  flashBad(S.problem.kind === 'recall' ? S.problem.digits : String(S.problem.answer), 'Time');
  setTimeout(() => { if (S.lives <= 0) endRun('dead'); else nextProblem(); }, 820);
}

/* Local lifetime per-operation tallies. Recall has no operation (op === null)
   so it no longer inflates the addition bucket. */
function tally(isCorrect) {
  const o = S.problem && S.problem.op;
  if (!o || !S.stats.ops[o]) return;
  if (isCorrect) S.stats.ops[o][0]++;
  S.stats.ops[o][1]++;
}

/* Attempt rows for POST /api/runs. Registered by drills.js in Phase 4 so the
   engine has no dependency on the network layer. */
let attemptSink = null;
export const setAttemptSink = fn => { attemptSink = fn; };
function logAttempt(res) {
  if (!attemptSink || !S.problem) return;
  try { attemptSink(S.problem, res); } catch (e) { /* logging must never break a run */ }
}

/* ============================================================ LOOP */
let lastTs = null;
export function loop(ts) {
  if (S.screen === 'game') {
    if (lastTs == null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const g = GAMES[S.game];
    if (!S.isDaily && g.timer === 'run') {
      S.timeLeft -= dt;
      if (S.timeLeft <= 0) { S.timeLeft = 0; updCenter(); updBar(); endRun('time'); }
      else { updCenter(); updBar(); }
    } else if (!S.isDaily && g.timer === 'problem' && S.game !== 'drill' && !S.locked && !S.memorizing) {
      S.pTimeLeft -= dt;
      if (S.pTimeLeft <= 0) { S.pTimeLeft = 0; updBar(); timeoutProblem(); }
      else updBar();
    }
  } else lastTs = null;
  requestAnimationFrame(loop);
}

/* ============================================================ END OF RUN */
let runSink = null;
export const setRunSink = fn => { runSink = fn; };

export function endRun(reason) {
  if (S.screen !== 'game') return;
  S.screen = 'results';
  const acc = S.solved ? Math.round(100 * S.correct / S.solved) : 0;
  const avg = S.times.length ? S.times.reduce((a, b) => a + b, 0) / S.times.length : 0;
  const durationMs = Math.round(now() - S.runStart);
  const mins = Math.max(1 / 600, durationMs / 60000), perMin = S.correct / mins;
  const key = S.isDaily ? 'daily' : S.game;
  const prev = S.stats.best[key] || 0, isBest = S.score > prev && S.score > 0;

  S.stats.solved += S.solved;
  S.stats.correct += S.correct;
  if (S.bestStreak > S.stats.bestStreak) S.stats.bestStreak = S.bestStreak;
  if (isBest) S.stats.best[key] = S.score;
  S.stats.recent.push({ g: key, score: S.score, acc, date: Date.now() });
  if (S.stats.recent.length > 100) S.stats.recent = S.stats.recent.slice(-100);
  if (S.stats.days.indexOf(today()) < 0) S.stats.days.push(today());
  saveStats();

  if (S.isDaily) {
    S.meter.dailyDone = true;
    S.meter.dailyScore = S.score;
    S.meter.dailyGrid = gridString();
    S.meter.dayStreak = (S.meter.lastDay === yesterday()) ? (S.meter.dayStreak || 0) + 1 : 1;
    S.meter.lastDay = today();
    saveMeter();
    track('daily_end', { score: S.score, acc, streak: S.meter.dayStreak });
  } else track('game_end', { game: S.game, score: S.score, acc, solved: S.solved, reason, pro: S.pro });

  // Never block or break the results screen over an upload.
  if (runSink) {
    try {
      const p = runSink({ reason, acc, durationMs });
      if (p && typeof p.catch === 'function') p.catch(() => { });
    } catch (e) { /* ignore */ }
  }

  renderResults({ reason, acc, avg, perMin, isBest });
  setScreen('results');
  if (resultsHook) { try { resultsHook({ reason, acc, avg, perMin, isBest }); } catch (e) { } }
}

/* Lets drills.js decorate the results screen (weak-spot table, drill
   before/after) without engine.js importing it. */
let resultsHook = null;
export const setResultsHook = fn => { resultsHook = fn; };

export function showDailyResult() {
  S.isDaily = true; S.game = 'daily'; S.score = S.meter.dailyScore;
  S.marks = (S.meter.dailyGrid || '').match(/./gu) || [];
  S.marks = S.marks.map(c => c === '\u{1F7E9}' ? 1 : 0);
  S.solved = S.marks.length;
  S.correct = S.marks.filter(x => x).length;
  S.wrong = S.solved - S.correct;
  S.bestStreak = 0; S.times = [];
  const r = { reason: 'done', acc: S.solved ? Math.round(100 * S.correct / S.solved) : 0, avg: 0, perMin: 0, isBest: false };
  renderResults(r);
  setScreen('results');
  if (resultsHook) { try { resultsHook(r); } catch (e) { /* decoration only */ } }
}

/* ---- share: the growth loop ---- */
export function share() {
  track('share_click', { game: S.isDaily ? 'daily' : S.game });
  const head = S.isDaily
    ? 'MindSharp Daily · ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'MindSharp ' + GAMES[S.game].name;
  const text = head + '\n' + (S.isDaily ? gridString() + '\n' : '') + 'Score ' + fmt(S.score)
    + (S.solved ? '  ·  ' + Math.round(100 * S.correct / S.solved) + '% accurate' : '') + '\n' + location.href;
  if (navigator.share) { navigator.share({ text }).catch(() => { }); return; }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      const b = $('#r-share'), o = b.textContent;
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = o; }, 1400);
    }).catch(() => { });
  }
}
