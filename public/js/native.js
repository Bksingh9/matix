import { S } from './state.js';
import { track } from './analytics.js';
import { $ } from './util.js';

/* Native shell integration.
 *
 * Plugins are reached through `window.Capacitor.Plugins`, not through
 * `import '@capacitor/haptics'`. Bare specifiers need a bundler to resolve,
 * and this project deliberately has none — Capacitor injects its runtime into
 * the WebView before our scripts run, so the global is there when it matters
 * and simply absent on the web.
 *
 * The result is one build that runs as a website, an installed PWA and a
 * native app, with every call below degrading to a no-op rather than a crash.
 * There is no second mobile codebase to keep in sync.
 */

const CAP = () => window.Capacitor;
const plugin = name => CAP()?.Plugins?.[name] || null;

export const isNative = () => !!(CAP()?.isNativePlatform?.());
export const platform = () => CAP()?.getPlatform?.() || 'web';

export async function initNative() {
  if (!isNative()) return { native: false, platform: 'web' };

  document.documentElement.classList.add('native', 'native-' + platform());
  track('native_launch', { platform: platform() });

  await Promise.allSettled([initStatusBar(), initBackButton(), initAppState()]);
  await hideSplash();

  return { native: true, platform: platform() };
}

/* ---- status bar --------------------------------------------------------
   The app is dark; a light status bar over it is unreadable. */
async function initStatusBar() {
  const StatusBar = plugin('StatusBar');
  if (!StatusBar) return;
  await StatusBar.setStyle({ style: 'DARK' });
  if (platform() === 'android') await StatusBar.setBackgroundColor({ color: '#16120c' });
}

async function hideSplash() {
  const SplashScreen = plugin('SplashScreen');
  if (SplashScreen) await SplashScreen.hide().catch(() => { });
}

/* ---- Android back button ------------------------------------------------
   Back must not exit the app from mid-run. It closes a sheet, then leaves a
   game, and only exits from the menu — what a player expects, and a Play
   Store review point. */
async function initBackButton() {
  if (platform() !== 'android') return;
  const App = plugin('App');
  if (!App) return;

  App.addListener('backButton', () => {
    const sheet = ['#paywall', '#rewardm', '#authm', '#acctm', '#profm', '#socialm']
      .map(id => $(id)).find(el => el?.classList.contains('show'));
    if (sheet) { sheet.classList.remove('show'); return; }

    if (S.screen === 'game' || S.screen === 'results') {
      window.dispatchEvent(new CustomEvent('ms:go-menu'));
      return;
    }
    App.exitApp();
  });
}

/* ---- foreground / background --------------------------------------------
   Returning from the background is the moment to re-check the streak and
   drain the offline queue: it is usually a new day. */
async function initAppState() {
  const App = plugin('App');
  if (!App) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) window.dispatchEvent(new CustomEvent('ms:resumed'));
  });

  // Deep links: mindsharp://daily, or https://mindsharp.app/?go=daily
  App.addListener('appUrlOpen', ({ url }) => {
    try {
      const u = new URL(url);
      const go = u.searchParams.get('go') || u.host || u.pathname.replace(/^\//, '');
      if (go) window.dispatchEvent(new CustomEvent('ms:launch-intent', { detail: { go } }));
    } catch (e) { /* not a URL we understand */ }
  });
}

/* ---- haptics ------------------------------------------------------------
   A correct answer you can feel is materially more satisfying than one you
   only see, and it is most of what "feels native" actually means. Falls back
   to the Vibration API on Android web. */
export function tap(kind = 'light') {
  // The sound toggle governs feel as well; an error still buzzes, because it
  // is information rather than decoration.
  if (!S.sound && kind !== 'error') return;
  try {
    const Haptics = plugin('Haptics');
    if (Haptics) {
      if (kind === 'error') Haptics.notification({ type: 'ERROR' });
      else if (kind === 'success') Haptics.notification({ type: 'SUCCESS' });
      else if (kind === 'heavy') Haptics.impact({ style: 'HEAVY' });
      else Haptics.impact({ style: 'LIGHT' });
      return;
    }
    if (navigator.vibrate) navigator.vibrate(kind === 'error' ? [16, 40, 16] : 10);
  } catch (e) { /* never let feedback break a run */ }
}

/* ---- storage ------------------------------------------------------------
   A WKWebView can have its localStorage evicted under storage pressure, which
   would silently drop a streak someone has held for a month. Preferences is
   backed by UserDefaults / SharedPreferences and survives. store.js adopts
   this when it is present. */
export function nativeStorage() {
  const Preferences = plugin('Preferences');
  if (!Preferences) return null;
  return {
    get: async k => (await Preferences.get({ key: k })).value ?? null,
    set: (k, v) => Preferences.set({ key: k, value: v }),
    remove: k => Preferences.remove({ key: k })
  };
}
