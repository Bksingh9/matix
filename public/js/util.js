/* Pure helpers. No imports, no state — everything else may depend on this. */

export const now = () => performance.now();
export const $ = s => document.querySelector(s);
export const $$ = s => document.querySelectorAll(s);

export const fmt = n => Math.round(n).toLocaleString('en-US');
export const fmtT = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

export const OPSYM = { '+': '+', '-': '−', '*': '×', '/': '÷' };

export const today = () => new Date().toISOString().slice(0, 10);
export const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

export const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
export const clamp01 = n => Math.max(0, Math.min(1, n));

/* Seeded PRNG — the daily challenge must produce the same twelve problems
   for every player on a given date. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
