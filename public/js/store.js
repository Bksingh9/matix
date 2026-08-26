/* Local persistence with a fallback chain: window.storage (host-provided
   key-value API, used when the game is embedded in a portal shell) →
   localStorage → in-memory.

   Everything is async because window.storage is. Callers await; the
   localStorage and memory backends resolve immediately. */

export const K = {
  stats: 'mindsharp:stats',
  prefs: 'mindsharp:prefs',
  meter: 'mindsharp:meter',
  ent: 'mindsharp:entitlement',
  queue: 'mindsharp:runqueue',
  migrated: 'mindsharp:migrated',
  progress: 'mindsharp:progress',
  install: 'mindsharp:install',
  notify: 'mindsharp:notify'
};

const mem = new Map();

/* Set by main.js on a native launch. A WKWebView can evict localStorage under
   storage pressure, which would silently drop a month-old streak; Preferences
   is backed by UserDefaults / SharedPreferences and survives. */
let native = null;
export function useNativeStorage(impl) { native = impl || null; }

function backend() {
  if (native) return 'native';
  if (window.storage && typeof window.storage.get === 'function') return 'host';
  try {
    const probe = '__ms_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return 'local';
  } catch (e) {
    // Safari private mode, disabled storage, sandboxed iframe.
    return 'memory';
  }
}

export async function sget(k) {
  try {
    const b = backend();
    if (b === 'native') { const v = await native.get(k); return v ? JSON.parse(v) : null; }
    if (b === 'host') { const r = await window.storage.get(k); return r && r.value ? JSON.parse(r.value) : null; }
    if (b === 'local') { const v = window.localStorage.getItem(k); return v ? JSON.parse(v) : null; }
    return mem.has(k) ? JSON.parse(mem.get(k)) : null;
  } catch (e) { return null; }
}

export async function sset(k, v) {
  try {
    const s = JSON.stringify(v);
    const b = backend();
    if (b === 'native') { await native.set(k, s); return; }
    if (b === 'host') { await window.storage.set(k, s); return; }
    if (b === 'local') { window.localStorage.setItem(k, s); return; }
    mem.set(k, s);
  } catch (e) { /* a full quota must not break a run */ }
}

export async function sdel(k) {
  try {
    const b = backend();
    if (b === 'native') { await native.remove(k); return; }
    if (b === 'host') { await window.storage.delete(k); return; }
    if (b === 'local') { window.localStorage.removeItem(k); return; }
    mem.delete(k);
  } catch (e) { /* ignore */ }
}
