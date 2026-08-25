import { S, loadAll, savePrefs, DEF_STATS, DEF_METER, canRun, runsLeft } from './state.js';
import { K, sdel } from './store.js';
import { track } from './analytics.js';
import { $, $$, cap1 } from './util.js';
import { audio } from './audio.js';
import { setScreen, renderMenu, syncSound, updAnswer } from './ui.js';
import {
  gateGame, startRun, endRun, submitPad, submitTF, submitOp,
  chipTap, digit, loop, share, setAttemptSink, setRunSink
} from './engine.js';
import { recordAttempt, submitRun, flush, initRunLog } from './runlog.js';
import { openPaywall, closePaywall, openReward, closeReward, startCheckout, watchReward, devPreviewPro, tryLicence, resumeAfterCheckout } from './paywall.js';
import { initAuth, openAuthSheet, closeAuthSheet, submitAuthSheet, signOut, onAuthChange } from './auth.js';
import { refreshEntitlement, migrateLocalProgress } from './entitlement.js';

/* ============================================================ BINDINGS
   All DOM wiring lives here. Dynamic content (game cards, the results CTA)
   is handled by delegation so re-rendering never needs to re-attach
   listeners — which also keeps ui.js free of imports from engine/paywall
   and the module graph acyclic. */
function bind() {
  $('#pro-cta').addEventListener('click', () => openPaywall(null, 'topbar'));
  $('#daily-card').addEventListener('click', () => { audio(); startRun('daily', true); });

  // game grid — delegated
  $('#game-grid').addEventListener('click', e => {
    const c = e.target.closest('.gcard');
    if (!c) return;
    audio();
    const id = c.dataset.game;
    if (gateGame(id)) startRun(id, false);
  });

  // auth strip — delegated, because renderMenu replaces its contents
  $('#auth-strip').addEventListener('click', e => {
    if (e.target.closest('#auth-in')) openAuthSheet('topbar');
    else if (e.target.closest('#auth-out')) signOut();
  });
  $('#auth-x').addEventListener('click', closeAuthSheet);
  $('#authm').addEventListener('click', e => { if (e.target.id === 'authm') closeAuthSheet(); });
  $('#auth-send').addEventListener('click', submitAuthSheet);
  $('#auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuthSheet(); });

  $$('#ops .op-chip').forEach(c => c.addEventListener('click', () => {
    const op = c.dataset.op, i = S.ops.indexOf(op);
    if (i >= 0) { if (S.ops.length === 1) return; S.ops.splice(i, 1); } else S.ops.push(op);
    c.classList.toggle('on');
    savePrefs();
  }));

  $$('#diff button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.pro && !S.pro) {
      openPaywall('**Expert difficulty** — three-digit sums and two-digit multiplication. Part of Pro.', 'difficulty');
      return;
    }
    S.difficulty = b.dataset.diff;
    $$('#diff button').forEach(x => x.classList.toggle('on', x === b));
    savePrefs();
    $('#menu-diff-hint').textContent = cap1(S.difficulty);
  }));

  $('#toggle-auto').addEventListener('click', () => { S.autoSubmit = !S.autoSubmit; $('#toggle-auto').classList.toggle('on', S.autoSubmit); savePrefs(); });
  $('#toggle-sound').addEventListener('click', () => { S.sound = !S.sound; $('#toggle-sound').classList.toggle('on', S.sound); if (S.sound) audio(); syncSound(); savePrefs(); });

  $('#reset-btn').addEventListener('click', async () => {
    const b = $('#reset-btn');
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Tap again to erase everything';
      setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Reset all progress'; }, 4000);
      return;
    }
    await sdel(K.stats); await sdel(K.meter);
    S.stats = DEF_STATS(); S.meter = DEF_METER();
    b.dataset.armed = '';
    b.textContent = 'Progress cleared';
    renderMenu();
  });

  // input panels
  $('#panel-pad').addEventListener('click', e => {
    const k = e.target.closest('.key');
    if (!k) return;
    const v = k.dataset.key;
    if (v === 'enter') submitPad();
    else if (v === 'back') { if (!S.locked) { S.input = S.input.slice(0, -1); updAnswer(); } }
    else digit(v);
  });
  $('#panel-tf').addEventListener('click', e => { const b = e.target.closest('.bigkey'); if (b) submitTF(+b.dataset.tf); });
  $('#panel-ops').addEventListener('click', e => { const b = e.target.closest('.opkey'); if (b) submitOp(b.dataset.op); });
  $('#panel-chips').addEventListener('click', e => {
    const b = e.target.closest('.chipkey');
    if (!b) return;
    if (b.dataset.clear) {
      S.picked = [];
      $$('#panel-chips .chipkey').forEach(c => c.classList.remove('picked'));
      $('#answerline').innerHTML = '<span class="eq">Σ</span><span class="typed">0</span>';
      return;
    }
    chipTap(+b.dataset.i);
  });

  $('#quit-btn').addEventListener('click', () => { setScreen('menu'); renderMenu(); });
  $('#sound-btn').addEventListener('click', () => { S.sound = !S.sound; if (S.sound) audio(); syncSound(); $('#toggle-sound').classList.toggle('on', S.sound); savePrefs(); });
  $('#zen-end').addEventListener('click', () => { if (S.game === 'zen') endRun('zen'); });

  // results
  $('#r-again').addEventListener('click', () => {
    audio();
    if (S.isDaily) { setScreen('menu'); renderMenu(); return; }
    if (!canRun()) { track('limit_hit', { game: S.game }); openReward('results'); return; }
    startRun(S.game, false);
  });
  $('#r-menu').addEventListener('click', () => { setScreen('menu'); renderMenu(); });
  $('#r-share').addEventListener('click', share);

  // results-screen dynamic CTAs — delegated
  $('#screen-results').addEventListener('click', e => {
    const cta = e.target.closest('#r-locked-cta');
    if (cta) openPaywall('You were **' + (cta.dataset.acc || 0) + '% accurate** this run. Pro shows you exactly where the misses cluster.', 'results');
  });

  // paywall
  $('#pw-x').addEventListener('click', closePaywall);
  $('#paywall').addEventListener('click', e => { if (e.target.id === 'paywall') closePaywall(); });
  $$('#plans .plan').forEach(p => p.addEventListener('click', () => startCheckout(p.dataset.plan)));
  $('#lic-btn').addEventListener('click', tryLicence);
  $('#lic-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryLicence(); });
  $('#pw-demo').addEventListener('click', devPreviewPro);

  // reward sheet
  $('#rw-x').addEventListener('click', closeReward);
  $('#rewardm').addEventListener('click', e => { if (e.target.id === 'rewardm') closeReward(); });
  $('#rw-watch').addEventListener('click', watchReward);
  $('#rw-pro').addEventListener('click', () => { closeReward(); openPaywall('Unlimited runs, no ads, and the weak-spot report.', 'reward_sheet'); });

  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if ($('#paywall').classList.contains('show') || $('#rewardm').classList.contains('show') || $('#authm').classList.contains('show')) {
    if (e.key === 'Escape') { closePaywall(); closeReward(); closeAuthSheet(); }
    return;
  }
  if (S.screen === 'game') {
    if (e.key === 'Escape') { e.preventDefault(); setScreen('menu'); renderMenu(); return; }
    const k = S.problem ? S.problem.kind : 'pad';
    if (k === 'pad' || k === 'recall') {
      if (e.key >= '0' && e.key <= '9') { e.preventDefault(); digit(e.key); }
      else if (e.key === 'Enter') { e.preventDefault(); submitPad(); }
      else if (e.key === 'Backspace') { e.preventDefault(); if (!S.locked) { S.input = S.input.slice(0, -1); updAnswer(); } }
    } else if (k === 'tf') {
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'f') { e.preventDefault(); submitTF(0); }
      else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 't') { e.preventDefault(); submitTF(1); }
    } else if (k === 'ops') {
      const m = { '+': '+', '-': '-', '*': '*', x: '*', X: '*', '/': '/' };
      if (m[e.key]) { e.preventDefault(); submitOp(m[e.key]); }
    } else if (k === 'chips') {
      const n = parseInt(e.key, 10);
      if (!isNaN(n) && n >= 1 && n <= 6) { e.preventDefault(); chipTap(n - 1); }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    audio();
    if (S.screen === 'menu') { if (gateGame(S.game)) startRun(S.game, false); }
    else if (S.screen === 'results' && !S.isDaily) {
      if (canRun()) startRun(S.game, false);
      else { track('limit_hit', { game: S.game }); openReward('kbd'); }
    }
  }
}

/* ============================================================ INIT */
async function init() {
  // Debug/test handle. Exposing state grants nothing: from Phase 1 on, Pro is
  // decided by the server and S.pro is only a mirror of what /api/me said.
  window.__mindsharp.S = S;

  bind();

  // The engine reports attempts and finished runs through these sinks, so it
  // never imports the network layer.
  setAttemptSink(recordAttempt);
  setRunSink(submitRun);
  initRunLog();

  S.stats = DEF_STATS();
  S.meter = DEF_METER();
  renderMenu();
  requestAnimationFrame(loop);

  await loadAll();
  renderMenu();
  syncSound();

  // Entitlement is server-decided. Until /api/me answers, the client behaves
  // as free — which is the correct failure mode when it never answers at all.
  onAuthChange(async sess => {
    await refreshEntitlement({ force: true });
    if (sess) { await migrateLocalProgress(); flush(); }
    renderMenu();
  });

  await initAuth();
  await refreshEntitlement({ force: true });
  if (S.authed) { await migrateLocalProgress(); flush(); }
  renderMenu();

  track('app_open', { pro: S.pro, authed: S.authed, runsLeft: S.pro ? 'inf' : runsLeft() });
  // Signals "startup finished, entitlement resolved" — used by the e2e suite
  // so tests never race the /api/me round-trip.
  window.__mindsharp.booted = true;

  // Landed back from a checkout: poll until the webhook lands.
  resumeAfterCheckout();
}

init();
