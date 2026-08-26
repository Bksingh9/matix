import { S } from './state.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { esc } from './ui.js';
import { get } from './api.js';
import { signOut } from './auth.js';
import { manageUrl } from './billing.js';

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
  m.classList.add('show');
  track('account_view', { source: src || 'topbar', plan: S.plan });
}

export const closeAccount = () => { const m = $('#acctm'); if (m) m.classList.remove('show'); };

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

const note = (html, err) => { $('#acct-msg').innerHTML = '<div class="notice' + (err ? ' err' : '') + '">' + html + '</div>'; };
