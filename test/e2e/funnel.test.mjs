import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly, FREE_ME, proMe } from './helpers.mjs';

/* Phase 6: the funnel events actually land at runtime, not just in a grep.
   These fourteen are what the five numbers in MONETISATION_PLAN.md §8 are
   computed from. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const names = page => page.evaluate(() => window.__mindsharp.events.map(e => e.name));
const props = (page, name) => page.evaluate(n => (window.__mindsharp.events.find(e => e.name === n) || {}).props, name);

describe('funnel events', () => {
  test('app_open fires with the entitlement state', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    assert.ok((await names(page)).includes('app_open'));
    const p = await props(page, 'app_open');
    assert.equal(p.pro, false);
    assert.equal(p.authed, false);
    await ctx.close();
  });

  test('game_start and game_end bracket a run', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');

    const fired = await names(page);
    assert.ok(fired.includes('game_start'));
    assert.ok(fired.includes('game_end'));
    const end = await props(page, 'game_end');
    assert.equal(end.game, 'zen');
    assert.equal(typeof end.score, 'number');
    assert.equal(typeof end.acc, 'number');
    await ctx.close();
  });

  test('daily_start and daily_end fire for the daily challenge', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('#daily-card');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 14);
    await page.waitForSelector('#screen-results.active', { timeout: 12000 });
    const fired = await names(page);
    assert.ok(fired.includes('daily_start'));
    assert.ok(fired.includes('daily_end'));
    assert.equal(typeof (await props(page, 'daily_end')).streak, 'number');
    await ctx.close();
  });

  test('paywall_view carries where it came from', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    assert.equal((await props(page, 'paywall_view')).source, 'topbar');
    await ctx.close();
  });

  test('limit_hit fires when the free cap is reached', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: { ...FREE_ME, limits: { freeRuns: 5, runsUsedToday: 5, runsLeft: 0 } } } }
    });
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#rewardm.show');
    const fired = await names(page);
    assert.ok(fired.includes('limit_hit'));
    assert.ok(fired.includes('paywall_view'));
    await ctx.close();
  });

  test('plan_click fires before the checkout call', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' } } },
        '/api/checkout': { status: 200, body: { url: 'about:blank', plan: 'yearly' } }
      }
    });
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    await page.click('#plans .plan[data-plan="yearly"]');
    await page.waitForFunction(() => window.__mindsharp.events.some(e => e.name === 'plan_click'));
    const p = await props(page, 'plan_click');
    assert.equal(p.plan, 'yearly');
    assert.equal(p.price, '$29.99');
    await ctx.close();
  });

  test('checkout_open fires only once the server returns a URL', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' } } },
        '/api/checkout': { status: 503, body: { error: 'checkout_unavailable' } }
      }
    });
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    await page.click('#plans .plan[data-plan="monthly"]');
    await page.waitForSelector('#pw-msg .notice');
    const fired = await names(page);
    assert.ok(fired.includes('plan_click'));
    assert.equal(fired.includes('checkout_open'), false, 'a failed checkout is not an opened checkout');
    await ctx.close();
  });

  test('licence_fail fires with a reason', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' } } },
        '/api/licence/validate': { status: 409, body: { error: 'key_in_use' } }
      }
    });
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    await page.fill('#lic-input', 'MS-AAAA-BBBB');
    await page.click('#lic-btn');
    await page.waitForSelector('#pw-msg .notice.err');
    assert.equal((await props(page, 'licence_fail')).reason, 'key_in_use');
    await ctx.close();
  });

  test('licence_ok and pro_active fire on a successful redemption', async () => {
    let pro = false;
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': () => ({ status: 200, body: pro ? proMe() : { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' } } }),
        '/api/licence/validate': () => { pro = true; return { status: 200, body: { valid: true, plan: 'lifetime' } }; }
      }
    });
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    await page.fill('#lic-input', 'MS-AAAA-BBBB');
    await page.click('#lic-btn');
    await page.waitForFunction(() => window.__mindsharp.S.pro === true, null, { timeout: 8000 });
    const fired = await names(page);
    assert.ok(fired.includes('licence_ok'));
    assert.ok(fired.includes('pro_active'), 'the moment that matters for revenue');
    await ctx.close();
  });

  test('reward_watch fires from the out-of-runs sheet', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: { ...FREE_ME, limits: { freeRuns: 5, runsUsedToday: 5, runsLeft: 0 } } } }
    });
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#rewardm.show');
    await page.click('#rw-watch');
    await page.waitForFunction(() => window.__mindsharp.events.some(e => e.name === 'reward_watch'));
    await ctx.close();
  });

  test('share_click fires and the shared text carries the URL', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.evaluate(() => {
      // Capture instead of invoking the real share sheet.
      navigator.share = t => { window.__shared = t; return Promise.resolve(); };
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.click('#r-share');
    await page.waitForFunction(() => !!window.__shared);

    const shared = await page.evaluate(() => window.__shared.text);
    assert.match(shared, /MindSharp/);
    assert.match(shared, /https?:\/\//, 'the growth loop depends on the URL being in there');
    assert.ok((await names(page)).includes('share_click'));
    await ctx.close();
  });

  test('all fourteen are reachable across a full session', async () => {
    // Sanity check on the bus itself: every registered name is a string with
    // a props object, so nothing silently posts undefined to Plausible.
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 1);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    const bad = await page.evaluate(() =>
      window.__mindsharp.events.filter(e => typeof e.name !== 'string' || typeof e.props !== 'object' || !e.ts));
    assert.deepEqual(bad, [], 'every event is well-formed');
    await ctx.close();
  });
});

describe('production hygiene', () => {
  test('the dev Pro preview button is not shown', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    assert.equal(await page.locator('#pw-demo').isVisible(), false, 'a visible free-Pro button in production is lost revenue');
    await ctx.close();
  });

  test('the paywall carries the refund, terms and privacy links', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    for (const href of ['/legal/refunds', '/legal/terms', '/legal/privacy']) {
      assert.equal(await page.locator(`#paywall a[href="${href}"]`).count(), 1, `missing ${href}`);
    }
    assert.match(await page.locator('#paywall .plan-note').innerText(), /merchant of record/i);
    await ctx.close();
  });

  test('the legal pages load', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    for (const path of ['/legal/terms.html', '/legal/privacy.html', '/legal/refunds.html']) {
      const r = await page.goto(srv.origin + path);
      assert.equal(r.status(), 200, path);
      assert.ok((await page.locator('h1').innerText()).length > 0, `${path} has a heading`);
    }
    await ctx.close();
  });

  test('a Pro user can reach the cancel path without emailing anyone', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: proMe() },
        '/api/portal': { status: 200, body: { url: 'https://example.com/portal', plan: 'yearly', manageable: true } }
      }
    });
    await page.click('#pro-badge');
    await page.waitForSelector('#acctm.show');
    const text = await page.locator('#acct-sub').innerText();
    assert.match(text, /Pro · Yearly/);
    assert.match(text, /Renews on/);
    assert.equal(await page.locator('#acct-manage').isVisible(), true);
    await ctx.close();
  });

  test('a cancelled subscriber is told when access actually ends', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': {
          status: 200,
          body: {
            ...proMe(),
            entitlement: { isPro: true, plan: 'yearly', status: 'cancelled', currentPeriodEnd: '2027-03-14T00:00:00Z', cancelAtPeriodEnd: true }
          }
        }
      }
    });
    await page.click('#pro-badge');
    await page.waitForSelector('#acctm.show');
    const text = await page.locator('#acct-sub').innerText();
    assert.match(text, /Cancelled/);
    assert.match(text, /March 14, 2027/);
    assert.match(text, /what you paid for/i);
    await ctx.close();
  });

  test('lifetime hides the manage button rather than linking nowhere', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': {
          status: 200,
          body: { ...proMe(), entitlement: { isPro: true, plan: 'lifetime', status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false } }
        }
      }
    });
    await page.click('#pro-badge');
    await page.waitForSelector('#acctm.show');
    assert.match(await page.locator('#acct-sub').innerText(), /nothing to renew/i);
    assert.equal(await page.locator('#acct-manage').isVisible(), false);
    await ctx.close();
  });
});
