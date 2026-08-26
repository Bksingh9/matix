import { track } from './analytics.js';
import { $ } from './util.js';
import { K, sget, sset } from './store.js';
import { isNative, platform } from './native.js';
import { progressView } from './progress.js';

/* Streak reminders.
 *
 * On mobile this is the single biggest retention lever there is. It is also
 * the easiest thing in the whole product to get wrong, because the failure
 * mode is not "it doesn't work" — it is "the player turns off notifications
 * for your app forever", which is unrecoverable.
 *
 * So the rules here are deliberately conservative:
 *
 *  - Ask only when there is something to protect. A permission prompt on
 *    first launch gets denied by most people, and iOS never asks twice.
 *  - At most one reminder a day, and only when the streak is actually at
 *    risk. A daily "come back!" to someone who already played today is spam.
 *  - Everything is scheduled locally. No server needs to know, nothing is
 *    sent to someone who has already opened the app, and it works offline.
 */

const CHANNEL = 'streak';
const MIN_STREAK_TO_ASK = 3;      // something worth protecting
const REMIND_HOUR = 19;           // local evening, before the day runs out

const plugin = name => window.Capacitor?.Plugins?.[name] || null;

let prefs = { enabled: null, askedAt: null, lastScheduledFor: null, deniedAt: null };

export async function initNotifications() {
  prefs = Object.assign(prefs, (await sget(K.notify)) || {});
  if (!isNative()) return;

  const LocalNotifications = plugin('LocalNotifications');
  if (!LocalNotifications) return;

  // Android 8+ needs a channel before anything will show at all.
  if (platform() === 'android' && LocalNotifications.createChannel) {
    try {
      await LocalNotifications.createChannel({
        id: CHANNEL,
        name: 'Streak reminders',
        description: 'A nudge when your streak is about to end',
        importance: 3,               // default: shows, but does not interrupt
        visibility: 1,
        vibration: true
      });
    } catch (e) { /* older Android */ }
  }

  // Opening from a notification should go straight to the daily challenge —
  // the thing the reminder was about.
  try {
    LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
      track('notification_opened', { id: notification?.id });
      window.dispatchEvent(new CustomEvent('ms:launch-intent', { detail: { go: 'daily' } }));
    });
  } catch (e) { /* ignore */ }

  if (prefs.enabled) await reschedule();
}

const save = () => sset(K.notify, prefs);

export const notificationsEnabled = () => prefs.enabled === true;

/* Should we ask? Only once the player has a streak they would mind losing. */
export function shouldOfferReminders() {
  if (!isNative()) return false;
  if (prefs.enabled !== null) return false;        // already decided
  if (prefs.deniedAt) return false;                 // the OS said no; do not nag
  const st = progressView()?.streak;
  return (st?.dayStreak || 0) >= MIN_STREAK_TO_ASK;
}

/* Called after a run, when the streak has just gone up — the moment the offer
   makes sense rather than an interruption. */
export function maybeOfferReminders() {
  if (!shouldOfferReminders()) return;
  const el = $('#notify-banner');
  if (!el || el.classList.contains('show')) return;

  const days = progressView()?.streak?.dayStreak || 0;
  el.innerHTML =
    '<span class="ib-text"><b>Protect your ' + days + '-day streak</b>'
    + '<span>One reminder in the evening, only on days you have not played yet.</span></span>'
    + '<button class="ib-go" id="notify-yes">Turn on</button>'
    + '<button class="ib-x" id="notify-no" aria-label="No thanks">✕</button>';
  el.classList.add('show');
  prefs.askedAt = Date.now();
  save();
  track('notify_offer_shown', { streak: days });
}

export function hideOffer() { $('#notify-banner')?.classList.remove('show'); }

export async function enableReminders() {
  hideOffer();
  const LocalNotifications = plugin('LocalNotifications');
  if (!LocalNotifications) return false;

  try {
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();

    if (perm.display !== 'granted') {
      // iOS never asks again. Record it and never show the offer again either.
      prefs.enabled = false;
      prefs.deniedAt = Date.now();
      save();
      track('notify_denied', {});
      return false;
    }

    prefs.enabled = true;
    save();
    track('notify_enabled', {});
    await reschedule();
    return true;
  } catch (e) {
    console.warn('[notify] could not enable:', e && e.message);
    return false;
  }
}

export async function declineReminders() {
  prefs.enabled = false;
  save();
  hideOffer();
  track('notify_declined', {});
}

export async function disableReminders() {
  prefs.enabled = false;
  save();
  await cancelAll();
  track('notify_disabled', {});
}

/* ============================================================ SCHEDULING

   One notification, for tomorrow evening, replaced every time the player
   opens the app. Scheduling a week ahead would keep firing after they have
   already played — which is the fastest route to being muted. */
export async function reschedule() {
  const LocalNotifications = plugin('LocalNotifications');
  if (!LocalNotifications || !prefs.enabled) return;

  await cancelAll();

  const st = progressView()?.streak;
  const streak = st?.dayStreak || 0;
  const at = nextReminderTime();

  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: 1001,
        channelId: CHANNEL,
        title: streak > 0 ? `Keep your ${streak}-day streak` : 'Two minutes of maths?',
        body: streak > 0
          ? 'Today’s twelve are waiting. One round keeps it alive.'
          : 'Today’s daily challenge is up — the same twelve problems for everyone.',
        schedule: { at, allowWhileIdle: true },
        smallIcon: 'ic_stat_mindsharp',
        // Android only; ignored elsewhere.
        extra: { go: 'daily' }
      }]
    });
    prefs.lastScheduledFor = at.toISOString();
    save();
  } catch (e) {
    console.warn('[notify] schedule failed:', e && e.message);
  }
}

async function cancelAll() {
  const LocalNotifications = plugin('LocalNotifications');
  if (!LocalNotifications) return;
  try {
    const pending = await LocalNotifications.getPending();
    if (pending?.notifications?.length) {
      await LocalNotifications.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
    }
  } catch (e) { /* nothing pending */ }
}

/* The next REMIND_HOUR that is still in the future, in the device's own
   timezone. A UTC-fixed time would fire at 3am for half the world. */
function nextReminderTime() {
  const now = new Date();
  const at = new Date(now);
  at.setHours(REMIND_HOUR, 0, 0, 0);
  // If today's slot has passed, or they have already played today, aim at
  // tomorrow — reminding someone about a streak they already extended is the
  // definition of spam.
  const playedToday = progressView()?.streak?.status === 'safe';
  if (at <= now || playedToday) at.setDate(at.getDate() + 1);
  return at;
}

/* ============================================================ REMOTE PUSH

   Registration only. Nothing is sent yet — a remote push needs Firebase on
   Android and an APNs key on iOS, and until those exist a token is just a
   token. Kept here so the plumbing is one function away rather than a
   refactor. */
export async function registerForPush() {
  const Push = plugin('PushNotifications');
  if (!Push || !isNative()) return null;
  try {
    const perm = await Push.requestPermissions();
    if (perm.receive !== 'granted') return null;
    await Push.register();
    return new Promise(resolve => {
      Push.addListener('registration', t => { track('push_registered', {}); resolve(t.value); });
      Push.addListener('registrationError', () => resolve(null));
      setTimeout(() => resolve(null), 8000);
    });
  } catch (e) { return null; }
}

/* Settings row, so someone who said yes can change their mind without
   digging through OS settings. */
export function reminderSettingsHtml() {
  if (!isNative()) return '';
  const on = prefs.enabled === true;
  return '<button class="toggle' + (on ? ' on' : '') + '" id="toggle-notify">'
    + '<span class="tn">Streak reminders</span><span class="switch"></span></button>';
}

export async function toggleReminders() {
  if (prefs.enabled === true) await disableReminders();
  else await enableReminders();
  const b = $('#toggle-notify');
  if (b) b.classList.toggle('on', prefs.enabled === true);
}
