import { track } from './analytics.js';
import { K, sget, sset } from './store.js';
import { $ } from './util.js';
import { toast } from './progress.js';

/* Install prompt and service-worker lifecycle.
 *
 * The timing is the whole trick. A prompt on arrival is an interruption from a
 * stranger and gets dismissed permanently — browsers only give you the one
 * chance. A prompt after someone has played a few rounds and started a streak
 * is an offer they were already halfway to wanting.
 *
 * Also: an installed app is the single biggest retention lever short of push
 * notifications. Home-screen presence roughly doubles return rate for this
 * kind of game, which is why it is worth being careful with.
 */

const MIN_RUNS_BEFORE_PROMPT = 3;
const REPROMPT_AFTER_DAYS = 14;

let deferred = null;        // the beforeinstallprompt event, held for later
let state = { runs: 0, dismissedAt: null, installedAt: null, promptedAt: null };

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true ||
  document.referrer.startsWith('android-app://');

/* Capacitor sets this; inside a native shell there is nothing to install. */
export const isNativeShell = () => !!(window.Capacitor?.isNativePlatform?.() ?? window.Capacitor?.isNative);

export async function initInstall() {
  state = Object.assign(state, (await sget(K.install)) || {});

  registerServiceWorker();

  if (isStandalone() || isNativeShell()) {
    if (!state.installedAt) { state.installedAt = Date.now(); save(); track('app_installed', {}); }
    return;
  }

  window.addEventListener('beforeinstallprompt', e => {
    // Hold it. Firing immediately spends the one chance the browser gives us
    // on someone who has not played yet.
    e.preventDefault();
    deferred = e;
    maybeShowBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    state.installedAt = Date.now();
    save();
    hideBanner();
    track('app_installed', {});
    toast({ kind: 'level', glyph: '◆', title: 'Installed', body: 'MindSharp is on your home screen. Your streak is easier to keep now.' });
  });
}

/* Called by main.js after every finished run. */
export function noteRunFinished() {
  state.runs = (state.runs || 0) + 1;
  save();
  maybeShowBanner();
}

function eligible() {
  if (isStandalone() || isNativeShell() || state.installedAt) return false;
  if ((state.runs || 0) < MIN_RUNS_BEFORE_PROMPT) return false;
  if (state.dismissedAt && Date.now() - state.dismissedAt < REPROMPT_AFTER_DAYS * 86400000) return false;
  return true;
}

function maybeShowBanner() {
  if (!eligible()) return;
  // Android/Chrome: we hold a real prompt. iOS: no API at all, so the banner
  // explains the Share-sheet route instead of promising a button that works.
  if (!deferred && !isIos()) return;
  showBanner();
}

function showBanner() {
  const el = $('#install-banner');
  if (!el || el.classList.contains('show')) return;

  el.innerHTML = isIos() && !deferred
    ? '<span class="ib-text"><b>Add MindSharp to your home screen</b>'
      + '<span>Tap the Share button, then <i>Add to Home Screen</i>. It opens full-screen and works offline.</span></span>'
      + '<button class="ib-x" id="install-dismiss" aria-label="Dismiss">✕</button>'
    : '<span class="ib-text"><b>Install MindSharp</b>'
      + '<span>Home-screen icon, full screen, works offline.</span></span>'
      + '<button class="ib-go" id="install-go">Install</button>'
      + '<button class="ib-x" id="install-dismiss" aria-label="Dismiss">✕</button>';

  el.classList.add('show');
  state.promptedAt = Date.now();
  save();
  track('install_prompt_shown', { platform: isIos() ? 'ios' : 'android' });
}

export function hideBanner() {
  const el = $('#install-banner');
  if (el) el.classList.remove('show');
}

export async function acceptInstall() {
  if (!deferred) { hideBanner(); return; }
  track('install_clicked', {});
  deferred.prompt();
  try {
    const { outcome } = await deferred.userChoice;
    track('install_choice', { outcome });
    if (outcome !== 'accepted') { state.dismissedAt = Date.now(); save(); }
  } catch (e) { /* the browser withdrew it */ }
  deferred = null;
  hideBanner();
}

export function dismissInstall() {
  state.dismissedAt = Date.now();
  save();
  hideBanner();
  track('install_dismissed', {});
}

const save = () => sset(K.install, state);
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

/* ============================================================ SERVICE WORKER

   Registered only over HTTPS (or localhost). A failure here must never stop
   the game loading — offline support is a bonus, not a dependency. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  // Inside a native shell the assets are already local; a service worker adds
  // a second cache with its own staleness problems.
  if (isNativeShell()) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      // A waiting worker means a new version is ready. Tell the player rather
      // than swapping the app out from under a run in progress.
      if (reg.waiting) offerUpdate(reg);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(reg);
        });
      });
    } catch (e) {
      console.warn('[sw] registration failed:', e && e.message);
    }
  });
}

let reloading = false;
function offerUpdate(reg) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  toast({
    kind: 'level', glyph: '↻',
    title: 'Update ready',
    body: 'Tap to reload into the new version.'
  });

  // The toast is not clickable, so give it a moment and then apply on the next
  // return to the menu rather than mid-run.
  const apply = () => {
    if (document.querySelector('#screen-game.active')) return;   // never mid-run
    reg.waiting?.postMessage('skip-waiting');
    document.removeEventListener('visibilitychange', apply);
  };
  setTimeout(apply, 3000);
  document.addEventListener('visibilitychange', apply);
}
