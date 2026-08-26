import { S } from './state.js';
import { track } from './analytics.js';
import { $, fmt } from './util.js';
import { esc } from './ui.js';
import { get, post } from './api.js';
import { openAuthSheet } from './auth.js';

/* Daily leaderboard and weekly league.
 *
 * Both degrade honestly at low player counts. A board with four names on it
 * reads as a dead product, so below a threshold the UI says how many people
 * played instead of pretending to be a leaderboard. That is a real risk here:
 * a solo launch has single-digit daily actives for weeks. */

let tab = 'league';

export function openSocial(src, which) {
  const m = $('#socialm');
  if (!m) return;
  if (which) tab = which;
  m.classList.add('show');
  track('social_view', { source: src || 'menu', tab });
  render();
}

export const closeSocial = () => { const m = $('#socialm'); if (m) m.classList.remove('show'); };

export function setTab(t) { tab = t; render(); }

async function render() {
  const body = $('#social-body');
  if (!body) return;

  $('#social-tabs').innerHTML =
    ['league', 'daily'].map(t =>
      '<button class="stab' + (t === tab ? ' on' : '') + '" data-tab="' + t + '">'
      + (t === 'league' ? 'This week' : 'Today') + '</button>').join('');

  body.innerHTML = '<div class="lk-p">Loading…</div>';
  if (tab === 'league') await renderLeague(body);
  else await renderDaily(body);
}

/* ============================================================ LEAGUE */
async function renderLeague(body) {
  if (!S.authed) {
    body.innerHTML = '<div class="social-empty">'
      + '<b>Leagues need an account</b>'
      + '<span>You are ranked against about thirty other players each week. Top five move up, and it resets every Monday — so a bad week costs you nothing.</span>'
      + '<button class="btn-primary" id="social-signin">Sign in</button></div>';
    return;
  }

  try {
    const r = await get('/api/league');
    if (!r.available) { body.innerHTML = notConfigured(); return; }

    const ends = r.season?.endsAt ? timeLeft(r.season.endsAt) : null;

    // Below the threshold, be honest rather than showing a leaderboard of
    // three. "You and two others" is a true statement; a podium is not.
    if (!r.meaningful) {
      body.innerHTML =
        header(r, ends)
        + '<div class="social-empty">'
        + '<b>' + (r.size <= 1 ? "You're first in" : r.size + ' players so far') + '</b>'
        + '<span>Your league fills as more people play this week. Everything you earn is already counting — '
        + (r.you ? fmt(r.you.xp) + ' XP so far.' : 'play a round to get on the board.') + '</span>'
        + '</div>'
        + (r.handleSet ? '' : handleForm());
      return;
    }

    body.innerHTML =
      header(r, ends)
      + '<div class="board">'
      + r.entries.map(e =>
        '<div class="brow ' + e.zone + (e.isYou ? ' you' : '') + '">'
        + '<span class="b-rank">' + e.rank + '</span>'
        + '<span class="b-name">' + esc(e.handle) + (e.isYou ? ' <i>you</i>' : '') + '</span>'
        + '<span class="b-xp">' + fmt(e.xp) + '</span></div>').join('')
      + '</div>'
      + (r.promoteCount
        ? '<div class="lk-p" style="margin-top:10px;">Top ' + r.promoteCount + ' move up to '
          + nextTier(r.tierName) + '. Only players who scored nothing all week can drop.</div>'
        : '')
      + (r.handleSet ? '' : handleForm());
  } catch (e) {
    body.innerHTML = e?.code === 'auth_required'
      ? '<div class="lk-p">Your session expired. Sign in again to see your league.</div>'
      : '<div class="lk-p">Couldn’t load your league just now.</div>';
  }
}

const header = (r, ends) =>
  '<div class="league-head">'
  + '<span class="lh-tier">' + esc(r.tierName) + ' league</span>'
  + (ends ? '<span class="lh-ends">' + ends + ' left</span>' : '')
  + '</div>'
  + (r.lastResult === 'promoted' ? '<div class="notice">You were promoted last week. Nice.</div>' : '')
  + (r.lastResult === 'relegated' ? '<div class="notice">You dropped a tier last week — a single run this week is enough to stay.</div>' : '');

const handleForm = () =>
  '<div class="setrow" style="margin-top:16px;">'
  + '<span class="label">Your name on the board</span>'
  + '<div class="keyrow"><input id="handle-input" placeholder="e.g. brij" maxlength="16" autocomplete="off" spellcheck="false" />'
  + '<button id="handle-save">Save</button></div>'
  + '<div class="lk-p" style="margin-top:6px;">Public. Anything but your email — that is why we ask.</div>'
  + '<div id="handle-msg"></div></div>';

export async function saveHandle() {
  const input = $('#handle-input');
  const msg = $('#handle-msg');
  if (!input) return;
  const handle = input.value.trim();
  const note = (t, err) => { if (msg) msg.innerHTML = '<div class="notice' + (err ? ' err' : '') + '">' + esc(t) + '</div>'; };

  try {
    await post('/api/league', { handle });
    track('handle_set', {});
    render();
  } catch (e) {
    if (e?.code === 'handle_taken') note('That name is taken. Try another.', true);
    else if (e?.code === 'bad_handle') note('2–16 characters: letters, numbers, spaces, _ or -.', true);
    else note('Couldn’t save that just now.', true);
  }
}

/* ============================================================ DAILY */
async function renderDaily(body) {
  try {
    const r = await get('/api/leaderboard');
    if (!r.available) { body.innerHTML = notConfigured(); return; }

    if (!r.entries.length) {
      body.innerHTML = '<div class="social-empty"><b>Nobody has played today yet</b>'
        + '<span>Be first. The daily is the same twelve problems for everyone, everywhere.</span></div>';
      return;
    }

    if (!r.meaningful) {
      body.innerHTML = '<div class="social-empty">'
        + '<b>' + r.playerCount + (r.playerCount === 1 ? ' player' : ' players') + ' so far today</b>'
        + '<span>' + (r.you ? 'You scored ' + fmt(r.you.score) + '. ' : '')
        + 'Share your grid — the board fills up as people play.</span></div>';
      return;
    }

    body.innerHTML =
      '<div class="league-head"><span class="lh-tier">Daily challenge</span>'
      + '<span class="lh-ends">' + r.playerCount + ' played</span></div>'
      + '<div class="board">'
      + r.entries.map(e =>
        '<div class="brow' + (e.isYou ? ' you' : '') + '">'
        + '<span class="b-rank">' + e.rank + '</span>'
        + '<span class="b-name">' + esc(e.handle) + (e.isYou ? ' <i>you</i>' : '') + '</span>'
        + '<span class="b-xp">' + fmt(e.score) + '</span></div>').join('')
      + '</div>'
      + (r.you && r.you.rank > r.entries.length
        ? '<div class="lk-p" style="margin-top:10px;">You are #' + r.you.rank + ' with ' + fmt(r.you.score) + '.</div>'
        : '');
  } catch (e) {
    body.innerHTML = '<div class="lk-p">Couldn’t load today’s board.</div>';
  }
}

const notConfigured = () =>
  '<div class="lk-p">Leaderboards need the backend configured. The game works fine without them.</div>';

export function socialSignIn() { closeSocial(); openAuthSheet('league'); }

/* ============================================================ helpers */
const nextTier = t => ({ Bronze: 'Silver', Silver: 'Gold', Gold: 'Platinum', Platinum: 'Diamond', Diamond: 'Diamond' }[t] || 'the next tier');

function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'ending';
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return d + (d === 1 ? ' day' : ' days');
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return h + (h === 1 ? ' hour' : ' hours');
  return Math.max(1, Math.floor(ms / 60000)) + ' min';
}
