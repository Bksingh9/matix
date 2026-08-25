import { S, runsLeft } from './state.js';
import { GAMES } from './games.js';
import { CONFIG } from './config.js';
import { $, $$, fmt, fmtT, OPSYM, today, cap1 } from './util.js';

/* Pure rendering. This module reads state and writes DOM; it never binds
   handlers and never imports engine.js or paywall.js. main.js owns the
   event wiring (delegated), which keeps the module graph a DAG. */

export function setScreen(n) {
  S.screen = n;
  ['menu', 'game', 'results'].forEach(x => $('#screen-' + x).classList.toggle('active', x === n));
  window.scrollTo(0, 0);
}

export const syncSound = () => { $('#sound-btn').textContent = S.sound ? '\u{1F50A}' : '\u{1F507}'; };

/* ============================================================ MENU */
export function renderRuns() {
  const p = $('#runs-pill');
  if (S.pro) { p.style.display = 'none'; return; }
  p.style.display = '';
  const n = runsLeft();
  p.innerHTML = '<b>' + n + '</b> run' + (n === 1 ? '' : 's') + ' left';
}

export function renderMenu() {
  const st = S.stats, m = S.meter;
  $('#pro-cta').style.display = S.pro ? 'none' : '';
  $('#pro-badge').style.display = S.pro ? '' : 'none';
  renderRuns();
  renderAuth();
  $('#ad-slot').classList.toggle('show', !S.pro && CONFIG.ads.enabled);
  $('#pp-m').textContent = CONFIG.prices.monthly;
  $('#pp-y').textContent = CONFIG.prices.yearly;
  $('#pp-l').textContent = CONFIG.prices.lifetime;
  $('#rw-watch').textContent = 'Watch ad · +' + CONFIG.ads.rewardRuns + ' runs';
  $('#pw-demo').style.display = CONFIG.devMode ? '' : 'none';

  const bests = Object.keys(st.best).map(k => st.best[k]);
  $('#s-best').textContent = fmt(bests.length ? Math.max.apply(null, bests) : 0);
  $('#s-solved').textContent = fmt(st.solved);
  $('#s-streak').textContent = fmt(st.bestStreak);
  $('#s-days').textContent = fmt(st.days.length);

  $('#daily-date').textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  $('#daily-streak').textContent = 'Day streak: ' + (m.dayStreak || 0);
  const dc = $('#daily-card');
  if (m.dailyDone) { dc.classList.add('done'); $('#daily-h').textContent = 'Today: ' + fmt(m.dailyScore); $('#daily-go').textContent = 'See result'; }
  else { dc.classList.remove('done'); $('#daily-h').textContent = "Today's twelve"; $('#daily-go').textContent = 'Play today'; }

  $('#game-grid').innerHTML = Object.keys(GAMES).filter(k => !GAMES[k].hidden).map(k => {
    const g = GAMES[k], lock = g.pro && !S.pro, best = st.best[k] ? fmt(st.best[k]) : '—';
    return '<button class="gcard' + (lock ? ' locked' : '') + '" data-game="' + k + '">'
      + '<div class="gc-top"><span class="gc-glyph">' + g.glyph + '</span>'
      + (lock ? '<span class="gc-lock">Pro</span>' : '<span class="gc-meta">' + best + '</span>') + '</div>'
      + '<div class="gc-name">' + g.name + '</div><div class="gc-desc">' + g.desc + '</div></button>';
  }).join('');

  $$('#ops .op-chip').forEach(c => c.classList.toggle('on', S.ops.indexOf(c.dataset.op) >= 0));
  $$('#diff button').forEach(b => b.classList.toggle('on', b.dataset.diff === S.difficulty));
  $('#toggle-auto').classList.toggle('on', S.autoSubmit);
  $('#toggle-sound').classList.toggle('on', S.sound);
  $('#menu-diff-hint').textContent = cap1(S.difficulty);
}

/* Auth strip in the top bar. Signed out shows "Sign in"; signed in shows the
   email and a sign-out link. */
export function renderAuth() {
  const el = $('#auth-strip');
  if (!el) return;
  if (S.authed && S.user) {
    // One control, not two: it opens the account sheet, which is where signing
    // out and cancelling both live.
    el.innerHTML = '<button class="auth-link" id="auth-acct" title="' + esc(S.user.email || '') + '">'
      + esc(shortMail(S.user.email)) + '</button>';
  } else {
    el.innerHTML = '<button class="auth-link" id="auth-in">Sign in</button>';
  }
}

const shortMail = m => {
  if (!m) return 'Account';
  return m.length <= 18 ? m : m.slice(0, 9) + '…' + m.slice(m.indexOf('@'));
};
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ============================================================ GAME */
export function showPanel(kind) {
  ['pad', 'tf', 'ops', 'chips'].forEach(p => $('#panel-' + p).classList.remove('show'));
  const map = { pad: 'pad', recall: 'pad', tf: 'tf', ops: 'ops', chips: 'chips' };
  $('#panel-' + (map[kind] || 'pad')).classList.add('show');
}

export function renderChips(p) {
  $('#panel-chips').innerHTML = p.pool.map((n, i) => '<button class="chipkey" data-i="' + i + '">' + n + '</button>').join('')
    + '<button class="chipkey" data-clear="1" style="grid-column:span 3;color:var(--ink-dim);font-size:12px;letter-spacing:.12em;">CLEAR</button>';
}

export function updAnswer() {
  $('#answerline').innerHTML = S.input === ''
    ? '<span class="eq">=</span><span class="caret"></span>'
    : '<span class="eq">=</span><span class="typed">' + S.input + '</span><span class="caret"></span>';
}

export function flashGood(pts) {
  const c = $('#card'); c.classList.remove('fw', 'shake'); c.classList.add('fc');
  const s = $('#g-score'); s.classList.remove('pump'); void s.offsetWidth; s.classList.add('pump');
  const f = document.createElement('span');
  f.className = 'float-pts'; f.textContent = '+' + pts;
  $('#score-wrap').appendChild(f);
  setTimeout(() => { if (f.parentNode) f.remove(); }, 900);
}

export function flashBad(text, tag) {
  const c = $('#card'); c.classList.remove('fc'); c.classList.add('fw', 'shake');
  $('#answerline').style.visibility = 'visible';
  $('#answerline').innerHTML = '<span class="eq">=</span><span class="typed wrong">' + text + '</span>' + (tag ? '<span class="wrongtag">' + tag + '</span>' : '');
}

export const updScore = () => { $('#g-score').textContent = fmt(S.score); };

export function updStreak() {
  $('#streak-val').textContent = S.streak;
  $('#streak-flame').classList.toggle('show', S.streak >= 2);
  const m = $('#streak-mult');
  if (S.mult > 1) { m.textContent = '×' + S.mult; m.classList.add('show'); }
  else m.classList.remove('show');
}

const hearts = n => { let h = ''; for (let i = 0; i < 3; i++) h += i < n ? '<span class="hf">♥</span>' : '<span class="he">♡</span>'; return h; };

export function updCenter() {
  const L = $('#center-label'), V = $('#center-value'), g = GAMES[S.game];
  V.classList.remove('urgent');
  if (S.isDaily) { L.textContent = 'Progress'; V.textContent = S.solved + '/' + GAMES.daily.total; }
  else if (S.game === 'drill' && S.drill) { L.textContent = 'Progress'; V.textContent = S.solved + '/' + S.drill.problems.length; }
  else if (g.timer === 'run') { L.textContent = 'Time'; V.textContent = fmtT(S.timeLeft); if (S.timeLeft <= 10) V.classList.add('urgent'); }
  else if (g.timer === 'problem') { L.textContent = 'Lives'; V.innerHTML = hearts(S.lives); }
  else { L.textContent = 'Solved'; V.textContent = String(S.correct); }
}

export function updBar() {
  const w = $('.timerbar-wrap'), f = $('#timerbar'), g = GAMES[S.game];
  if (!S.isDaily && g.timer === 'none') { w.style.visibility = 'hidden'; return; }
  w.style.visibility = 'visible';
  let frac = 0, prog = false;
  if (S.isDaily) { frac = S.solved / GAMES.daily.total; prog = true; }
  else if (S.game === 'drill' && S.drill) { frac = S.solved / S.drill.problems.length; prog = true; }
  else if (g.timer === 'run') frac = S.timeLeft / (g.duration || 60);
  else if (g.timer === 'problem') frac = S.pTimeLeft / S.pLimit;
  frac = Math.max(0, Math.min(1, frac));
  f.style.width = (frac * 100).toFixed(1) + '%';
  f.classList.toggle('progress', prog);
  f.classList.toggle('low', !prog && frac < .2);
}

/* ============================================================ RESULTS */
export const gridString = () => S.marks.map(m => m ? '\u{1F7E9}' : '\u{1F7E5}').join('');

const HEAD = { time: "Time's up", dead: 'Game over', done: 'Nice work', zen: 'Session complete', drill: 'Drill complete' };

export function renderResults(r) {
  const g = GAMES[S.isDaily ? 'daily' : S.game];
  $('#r-eyebrow').textContent = S.isDaily
    ? 'Daily challenge · ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : (S.game === 'drill' ? 'Drill · targeted practice' : g.name + ' · ' + cap1(S.difficulty));
  $('#r-heading').textContent = S.isDaily ? 'Daily done' : (HEAD[r.reason] || 'Results');
  $('#r-score').textContent = fmt(S.score);
  $('#r-newbest').classList.toggle('show', !!r.isBest);
  $('#r-grid').textContent = S.isDaily ? gridString() : '';

  const rows = S.solved ? [
    { k: 'Correct', v: S.correct + '/' + S.solved }, { k: 'Accuracy', v: r.acc + '%' },
    { k: 'Best streak', v: String(S.bestStreak) }, { k: 'Avg time', v: r.avg.toFixed(1) + 's' },
    { k: 'Per minute', v: String(Math.round(r.perMin)) }, { k: 'Mistakes', v: String(S.wrong) }
  ] : [{ k: 'Solved', v: '0' }, { k: 'Accuracy', v: '—' }];
  $('#r-stats').innerHTML = rows.map(s => '<div class="r-stat"><span class="rv">' + s.v + '</span><span class="rk">' + s.k + '</span></div>').join('');

  renderWeakBox(r);

  const key = S.isDaily ? 'daily' : S.game;
  const sc = S.stats.recent.filter(x => x.g === key).slice(-10).map(x => x.score);
  $('#r-spark').innerHTML = sc.length >= 2 ? spark(sc) : '<div class="empty">Play a few rounds to see your trend.</div>';
  $('#r-again').textContent = S.isDaily ? 'Back to games' : 'Play again';
}

/* The locked/unlocked weak-spot card.

   The Pro branch renders a frame that drills.js fills asynchronously from
   /api/weakspots. A drill run replaces the whole card with its before/after
   comparison instead. */
export function renderWeakBox(r) {
  const box = $('#r-locked');
  if (S.pro) {
    box.innerHTML = '<div class="lk-h">Weak-spot report <span class="tag">Pro</span></div>'
      + '<div id="weak-body"><div class="lk-p">Reading your last 400 answers…</div></div>';
  } else {
    // Describes what now exists, rather than what was once promised.
    box.innerHTML = '<div class="lk-h">Weak-spot report <span class="tag">Pro</span></div>'
      + '<div class="lk-p">Pro scores each operation and number range you play — accuracy, pace against a target time, '
      + 'and whether you are getting better or worse — then builds a twenty-problem drill from the buckets you actually miss, '
      + 'and shows you the before/after when you finish it.</div>'
      + '<div class="lk-p" style="margin-top:6px;opacity:.75;">Needs about forty answers before it will say anything. '
      + 'It won\'t guess from a handful.</div>'
      + '<button class="lk-cta" id="r-locked-cta" data-acc="' + (r && typeof r.acc === 'number' ? r.acc : 0) + '">Unlock with Pro →</button>';
  }
}

export function spark(sc) {
  const w = 380, h = 44, p = 5;
  const mn = Math.min.apply(null, sc), mx = Math.max.apply(null, sc), rg = (mx - mn) || 1;
  const pts = sc.map((s, i) => {
    const x = p + (w - 2 * p) * (sc.length === 1 ? .5 : i / (sc.length - 1));
    const y = h - p - (h - 2 * p) * ((s - mn) / rg);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const last = pts[pts.length - 1].split(',');
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">'
    + '<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(255,180,58,.28)"/><stop offset="100%" stop-color="rgba(255,180,58,0)"/></linearGradient></defs>'
    + '<path d="M' + p + ',' + (h - p) + ' L' + pts.join(' L') + ' L' + (w - p) + ',' + (h - p) + ' Z" fill="url(#sg)"/>'
    + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#ffb43a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
    + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.2" fill="#ffb43a"/></svg>';
}

export { OPSYM, today };
