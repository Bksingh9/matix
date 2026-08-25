import { S } from './state.js';

let AC = null;

/* Must be called from a user gesture the first time, or the context stays
   suspended on iOS. */
export function audio() {
  if (!S.sound) return;
  try {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
  } catch (e) { AC = null; }
}

function tone(f, st, d, ty, v) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = ty || 'sine';
  o.frequency.value = f;
  const t = AC.currentTime + st;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v || .05, t + .01);
  g.gain.exponentialRampToValueAtTime(1e-4, t + d);
  o.connect(g); g.connect(AC.destination);
  o.start(t); o.stop(t + d + .02);
}

export function beep(k) {
  if (!S.sound || !AC) return;
  if (k === 'ok') { tone(660, 0, .09, 'sine', .05); tone(920, .07, .11, 'sine', .05); }
  else if (k === 'no') { tone(150, 0, .16, 'square', .05); }
  else { tone(500, 0, .07, 'triangle', .04); }
}
