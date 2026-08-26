import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, FREE_ME, proMe } from './helpers.mjs';

/* Phase 8 acceptance. The behaviour that matters most is what a leaderboard
   looks like when almost nobody is playing — which is the situation for weeks
   after launch. It must never look like a broken feature. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const entries = n => Array.from({ length: n }, (_, i) => ({
  rank: i + 1,
  handle: i === 2 ? 'brij' : `Player ${1000 + i}`,
  xp: (n - i) * 120,
  isYou: i === 2,
  zone: n >= 10 ? (i < 5 ? 'promote' : (i >= n - 5 && (n - i) * 120 === 0 ? 'relegate' : 'hold')) : 'hold'
}));

const leagueBody = (n, over = {}) => ({
  available: true, groupId: 10, tier: 1, tierName: 'Bronze',
  entries: entries(n), you: entries(n).find(e => e.isYou) || null,
  size: n, meaningful: n >= 5,
  promoteCount: n >= 10 ? 5 : 0, relegateCount: n >= 10 ? 5 : 0,
  season: { startsOn: '2026-08-24', endsOn: '2026-08-30', endsAt: new Date(Date.now() + 3 * 86400000).toISOString() },
  lastResult: null, handleSet: true, ...over
});

const dailyBody = (n, over = {}) => ({
  available: true, date: '2026-08-26',
  entries: Array.from({ length: n }, (_, i) => ({ rank: i + 1, handle: i === 1 ? 'brij' : `Player ${i}`, score: (n - i) * 40, isYou: i === 1 })),
  you: n > 1 ? { rank: 2, handle: 'brij', score: (n - 1) * 40, isYou: true } : null,
  playerCount: n, meaningful: n >= 5, ...over
});

const api = (over = {}) => ({ '/api/me': { status: 200, body: proMe() }, ...over });

const openBoard = async (page, tab) => {
  await page.click('#social-cta');
  await page.waitForSelector('#socialm.show');
  if (tab) { await page.click(`.stab[data-tab="${tab}"]`); }
};

describe('the league', () => {
  test('a full group ranks players with the promotion zone marked', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20) } })
    });
    await openBoard(page);
    await page.waitForSelector('.brow', { timeout: 6000 });

    assert.equal(await page.locator('.brow').count(), 20);
    assert.equal(await page.locator('.brow.promote').count(), 5);
    assert.equal(await page.locator('.brow.you').count(), 1);
    assert.match(await page.locator('.lh-tier').innerText(), /Bronze league/i);
    assert.match(await page.locator('.lh-ends').innerText(), /days? left/i);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('a nearly-empty league is honest instead of showing a podium', async () => {
    // The launch reality. A leaderboard of two reads as a dead product.
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(2, { meaningful: false, entries: entries(2), you: { rank: 1, handle: 'brij', xp: 240, isYou: true, zone: 'hold' } }) } })
    });
    await openBoard(page);
    await page.waitForSelector('.social-empty', { timeout: 6000 });

    const text = await page.locator('#social-body').innerText();
    assert.match(text, /2 players so far/i);
    assert.match(text, /already counting/i, 'and reassures that XP is not wasted');
    assert.equal(await page.locator('.brow').count(), 0, 'no fake leaderboard');
    await ctx.close();
  });

  test('a solo player is told they are first in, not that they are last', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(1, { meaningful: false, entries: [], you: null, size: 1 }) } })
    });
    await openBoard(page);
    await page.waitForSelector('.social-empty', { timeout: 6000 });
    assert.match(await page.locator('#social-body').innerText(), /first in/i);
    await ctx.close();
  });

  test('signed-out players are told what a league is before being asked to join', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: { '/api/me': { status: 200, body: FREE_ME } } });
    await openBoard(page);
    await page.waitForSelector('#social-signin', { timeout: 6000 });
    const text = await page.locator('#social-body').innerText();
    assert.match(text, /resets every Monday/i, 'the pitch, not just a wall');
    assert.match(text, /bad week costs you nothing/i);
    await page.click('#social-signin');
    await page.waitForSelector('#authm.show', { timeout: 5000 });
    await ctx.close();
  });

  test('promotion last week is celebrated', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20, { lastResult: 'promoted', tierName: 'Silver', tier: 2 }) } })
    });
    await openBoard(page);
    await page.waitForSelector('.notice', { timeout: 6000 });
    assert.match(await page.locator('#social-body').innerText(), /promoted last week/i);
    await ctx.close();
  });

  test('relegation is softened rather than rubbed in', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20, { lastResult: 'relegated' }) } })
    });
    await openBoard(page);
    await page.waitForSelector('.notice', { timeout: 6000 });
    assert.match(await page.locator('#social-body').innerText(), /single run this week is enough/i);
    await ctx.close();
  });

  test('a player with no handle is asked for one, and told why', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(12, { handleSet: false }) } })
    });
    await openBoard(page);
    await page.waitForSelector('#handle-input', { timeout: 6000 });
    assert.match(await page.locator('#social-body').innerText(), /Anything but your email/i);
    await ctx.close();
  });

  test('a taken handle is reported without losing what was typed', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({
        '/api/league': ({ method }) => method === 'POST'
          ? { status: 409, body: { error: 'handle_taken' } }
          : { status: 200, body: leagueBody(12, { handleSet: false }) }
      })
    });
    await openBoard(page);
    await page.waitForSelector('#handle-input', { timeout: 6000 });
    await page.fill('#handle-input', 'brij');
    await page.click('#handle-save');
    await page.waitForSelector('#handle-msg .notice.err', { timeout: 6000 });
    assert.match(await page.locator('#handle-msg').innerText(), /taken/i);
    assert.equal(await page.locator('#handle-input').inputValue(), 'brij', 'the input is not cleared');
    await ctx.close();
  });

  test('a backend outage does not break the menu', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 503, body: { error: 'down' } } })
    });
    await openBoard(page);
    await page.waitForFunction(() => /couldn|load/i.test(document.querySelector('#social-body')?.innerText || ''), null, { timeout: 6000 });
    await page.click('#social-x');
    // and the game still plays
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#screen-game.active');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('the daily leaderboard', () => {
  test('shows a ranked board once enough people have played', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20) }, '/api/leaderboard': { status: 200, body: dailyBody(12) } })
    });
    await openBoard(page, 'daily');
    await page.waitForSelector('.brow', { timeout: 6000 });
    assert.equal(await page.locator('.brow').count(), 12);
    assert.equal(await page.locator('.brow.you').count(), 1);
    assert.match(await page.locator('.lh-ends').innerText(), /12 played/i);
    await ctx.close();
  });

  test('an empty day invites the player to be first', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20) }, '/api/leaderboard': { status: 200, body: dailyBody(0, { entries: [], you: null }) } })
    });
    await openBoard(page, 'daily');
    await page.waitForSelector('.social-empty', { timeout: 6000 });
    assert.match(await page.locator('#social-body').innerText(), /Be first/i);
    await ctx.close();
  });

  test('a thin day reports the count rather than faking a board', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20) }, '/api/leaderboard': { status: 200, body: dailyBody(3) } })
    });
    await openBoard(page, 'daily');
    await page.waitForSelector('.social-empty', { timeout: 6000 });
    const text = await page.locator('#social-body').innerText();
    assert.match(text, /3 players so far today/i);
    assert.match(text, /Share your grid/i, 'and points at the growth loop');
    assert.equal(await page.locator('.brow').count(), 0);
    await ctx.close();
  });

  test('is visible without an account', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: FREE_ME }, '/api/leaderboard': { status: 200, body: dailyBody(12) } }
    });
    await openBoard(page, 'daily');
    await page.waitForSelector('.brow', { timeout: 6000 });
    assert.equal(await page.locator('.brow').count(), 12, 'you can look before you sign up');
    await ctx.close();
  });

  test('tabs switch between the two boards', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/league': { status: 200, body: leagueBody(20) }, '/api/leaderboard': { status: 200, body: dailyBody(12) } })
    });
    await openBoard(page);
    await page.waitForSelector('.brow', { timeout: 6000 });
    assert.match(await page.locator('.lh-tier').innerText(), /Bronze/i);
    await page.click('.stab[data-tab="daily"]');
    await page.waitForFunction(() => /Daily challenge/i.test(document.querySelector('.lh-tier')?.innerText || ''), null, { timeout: 6000 });
    await page.click('.stab[data-tab="league"]');
    await page.waitForFunction(() => /Bronze/i.test(document.querySelector('.lh-tier')?.innerText || ''), null, { timeout: 6000 });
    await ctx.close();
  });
});
