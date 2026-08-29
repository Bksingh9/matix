/* ============================================================ THEMES
   Which look the app wears. Pure and dependency-free so the inline boot
   snippet in index.html can share the same key and default without importing
   anything. */

export const THEMES = [
  { id: 'ember',  name: 'Ember',  hint: 'warm & dark',    swatch: '#211a11', dot: '#ffb43a' },
  { id: 'clay',   name: 'Clay',   hint: 'soft & tactile', swatch: '#ECE9F8', dot: '#FF8C5B' },
  { id: 'aurora', name: 'Aurora', hint: 'luminous',       swatch: '#3A2568', dot: '#9FF0FF' },
  { id: 'neon',   name: 'Neon',   hint: 'arcade',         swatch: '#150E22', dot: '#3EE7FF' },
  { id: 'bold',   name: 'Bold',   hint: 'flat & loud',    swatch: '#EFEDE6', dot: '#3B4EF0' }
];

export const THEME_KEY = 'mindsharp:theme';
export const DEFAULT_THEME = 'ember';

export const isTheme = id => THEMES.some(t => t.id === id);

/* The colour the browser paints around the page — the status bar on a phone,
   the URL bar on desktop. Left alone it stays the dark default and a light
   theme grows a black bar above it. */
const THEME_COLOR = {
  ember: '#16120c', clay: '#E3DFF4', aurora: '#241852', neon: '#0B0712', bold: '#EFEDE6'
};

export function applyTheme(id) {
  const theme = isTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
  return theme;
}

/* Written straight to localStorage rather than through store.js: the boot
   snippet has to read it synchronously before the first paint, and store.js
   is async because it may be backed by native Preferences. Two writers of one
   key is a smell, so this is the only place either side touches it. */
export function saveTheme(id) {
  try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* private mode */ }
}

export function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || DEFAULT_THEME; } catch (e) { return DEFAULT_THEME; }
}

export function setTheme(id) {
  const theme = applyTheme(id);
  saveTheme(theme);
  return theme;
}

export function themePickerHtml(current) {
  return '<div class="theme-row">' + THEMES.map(t =>
    '<button class="tcard' + (t.id === current ? ' on' : '') + '" data-theme-id="' + t.id + '"'
    + ' aria-pressed="' + (t.id === current ? 'true' : 'false') + '">'
    + '<span class="tsw" style="background:' + t.swatch + '"><i style="background:' + t.dot + '"></i></span>'
    + '<span class="tname">' + t.name + '</span>'
    + '<span class="thint">' + t.hint + '</span>'
    + '</button>').join('') + '</div>';
}
