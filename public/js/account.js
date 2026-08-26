import { S } from './state.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { esc } from './ui.js';
import { get, post } from './api.js';
import { signOut } from './auth.js';
import { manageUrl } from './billing.js';
import { K, sdel } from './store.js';

/* The account sheet: what you are on, when it renews, and the one link that
   lets you cancel without emailing anyone.

   "You can buy, use, cancel and get refunded without you touching a database"
   is the Phase 6 acceptance criterion. This is the cancel half of it. */

const PLAN_NAME = { monthly: 'Pro · Monthly', yearly: 'Pro · Yearly', lifetime: 'Pro · Lifetime', comp: 'Pro · Complimentary', free: 'Free' };

export function openAccount(src) {
  const m = $('#acctm');
  if (!m) return;
  $('#acct-msg').innerHTML = '';
  $('#acct-sub').innerHTML = describe();
  const manage = $('#acct-manage');
  // Nothing to manage on lifetime or comp: hide the button rather than
  // sending someone to a portal that will only confuse them.
  const manageable = S.pro && (S.plan === 'monthly' || S.plan === 'yearly');
  manage.style.display = manageable ? '' : 'none';
  $('#acct-billing-note').textContent = billingNote();
  // Nothing to delete when there is no account. An anonymous player's data
  // never left this browser; clearing site data is already the whole story.
  $('#acct-danger').style.display = S.authed ? '' : 'none';
  cancelDelete();   // never open already-armed
  m.classList.add('show');
  track('account_view', { source: src || 'topbar', plan: S.plan });
}

export const closeAccount = () => { const m = $('#acctm'); if (m) m.classList.remove('show'); };

/* Who actually holds the billing relationship. Since Phase 12 that is not
   always us: a purchase made in the store apps is Apple's or Google's, and
   telling a store subscriber that Lemon Squeezy handles their billing sends
   them somewhere with no authority over it. */
function billingNote() {
  if (S.source === 'appstore') {
    return 'This subscription was bought through the App Store, so Apple handles the billing. '
      + 'Manage or cancel it in Settings — cancelling keeps your access until the paid period ends.';
  }
  if (S.source === 'play') {
    return 'This subscription was bought through Google Play, so Google handles the billing. '
      + 'Manage or cancel it in the Play Store — cancelling keeps your access until the paid period ends.';
  }
  return 'Billing is handled by Lemon Squeezy, our merchant of record. Cancelling stops the next '
    + 'renewal and keeps your access until the paid period ends.';
}

function describe() {
  const email = S.user?.email ? esc(S.user.email) : 'this browser';
  const plan = PLAN_NAME[S.plan] || 'Free';

  if (!S.pro) {
    return `Signed in as <b style="color:var(--ink)">${email}</b>. You're on the free plan — five runs a day, and the daily challenge is always free.`;
  }

  let when = '';
  if (S.currentPeriodEnd) {
    const d = new Date(S.currentPeriodEnd);
    if (!isNaN(d)) {
      const date = d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
      when = S.cancelAtPeriodEnd || S.planStatus === 'cancelled'
        ? ` Cancelled — your access runs until <b style="color:var(--ink)">${date}</b>, which is what you paid for.`
        : ` Renews on <b style="color:var(--ink)">${date}</b>.`;
    }
  } else if (S.plan === 'lifetime') {
    when = ' Yours for good — nothing to renew.';
  } else if (S.plan === 'comp') {
    when = ' Complimentary access, no billing attached.';
  }

  if (S.planStatus === 'past_due') {
    when += ' Your last payment failed. We\'re keeping your access while the card is retried — update it below to avoid losing it.';
  }

  return `Signed in as <b style="color:var(--ink)">${email}</b> on <b style="color:var(--amber)">${plan}</b>.${when}`;
}

export async function openPortal() {
  // A subscription bought through the App Store or Play Store can only be
  // cancelled in the OS. Our billing portal has no authority over it, and
  // sending someone there would be a dead end.
  if (S.plan !== 'free' && ['play', 'appstore'].includes(S.source)) {
    const url = manageUrl();
    if (url) { track('portal_open', { plan: S.plan, rail: S.source }); window.open(url, '_blank', 'noopener'); return; }
  }

  const btn = $('#acct-manage');
  const original = btn.textContent;
  btn.textContent = 'Opening…';
  btn.disabled = true;
  try {
    const r = await get('/api/portal');
    if (r?.url) {
      track('portal_open', { plan: S.plan });
      window.open(r.url, '_blank', 'noopener');
      note('Opened the billing portal in a new tab. Cancel, change your card or download invoices there.');
      return;
    }
    note(r?.reason === 'lifetime_no_renewal'
      ? 'Lifetime has nothing to manage — there is no renewal to cancel.'
      : 'No subscription attached to this account.');
  } catch (e) {
    note(e?.code === 'portal_unavailable'
      ? 'Couldn\'t reach the billing portal just now. Try again shortly, or email support@mindsharp.app and we\'ll cancel it for you.'
      : 'Something went wrong opening the portal. Email support@mindsharp.app and we\'ll sort it out by hand.', true);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

export async function doSignOut() {
  await signOut();
  closeAccount();
}

/* ---- deletion --------------------------------------------------------- */

/* App Store guideline 5.1.1(v) and Play's data-deletion policy both require
   this to exist in the app, not in an email to support. Two taps, because the
   first one is next to "Sign out" and this one is permanent. */
export function askDelete() {
  $('#acct-delete-confirm').style.display = '';
  $('#acct-delete').style.display = 'none';
  track('delete_offer_shown', { plan: S.plan });
}

export function cancelDelete() {
  $('#acct-delete-confirm').style.display = 'none';
  $('#acct-delete').style.display = '';
}

export async function confirmDelete() {
  const btn = $('#acct-delete-yes');
  const original = btn.textContent;
  btn.textContent = 'Deleting…';
  btn.disabled = true;
  try {
    await post('/api/account/delete', { confirm: 'DELETE' });
    track('account_deleted', { plan: S.plan });

    /* Wipe the local mirror too. Leaving a stale streak and XP behind would
       show the next person to open this browser a progress bar belonging to
       an account that no longer exists. */
    for (const k of Object.values(K)) { try { await sdel(k); } catch (e) { /* best effort */ } }

    await signOut();
    closeAccount();
    // A reload is the honest way to reach a clean state: every module holds
    // some of S, and there is no "un-load" path worth writing for this.
    window.location.replace('/?deleted=1');
  } catch (e) {
    btn.textContent = original;
    btn.disabled = false;
    note(deleteError(e), true);
  }
}

function deleteError(e) {
  if (e?.code === 'store_subscription_active') {
    const where = e.body?.source === 'appstore' ? 'the App Store' : 'Google Play';
    // Being specific matters: we genuinely cannot cancel this for them, and a
    // vague error here ends with a card still being charged.
    return `You have an active subscription through ${where}. We can't cancel that for you — `
      + `only ${where} can. Cancel it there first, then come back and delete your account.`;
  }
  if (e?.code === 'cancel_failed') {
    return 'We couldn\'t reach the billing system to cancel your subscription, so we\'ve left '
      + 'your account alone rather than delete it and keep charging you. Try again shortly.';
  }
  if (e?.code === 'entitlement_unreadable') {
    // We could not check for a live subscription, so we refused rather than
    // guess. Saying "try again" is the whole truth here.
    return 'We couldn\'t check your subscription just now, so nothing was deleted. Try again shortly.';
  }
  if (e?.code === 'auth_required') return 'Your session expired. Sign in again to delete your account.';
  return 'Something went wrong. Nothing was deleted — try again, or email support@mindsharp.app.';
}

const note = (html, err) => { $('#acct-msg').innerHTML = '<div class="notice' + (err ? ' err' : '') + '">' + html + '</div>'; };
