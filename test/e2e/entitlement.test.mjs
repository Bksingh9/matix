import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, FREE_ME, proMe } from './helpers.mjs';

/* Phase 1 acceptance: Pro can only be granted by the server. Clearing browser
   storage cannot take it away; editing browser storage cannot grant it. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const isProInUi = page => page.evaluate(() => ({
  flag: window.__mindsharp.S.pro,
  badge: document.querySelector('#pro-badge').style.display !== 'none',
  cta: document.querySelector('#pro-cta').style.display !== 'none',
  lockedCards: document.querySelectorAll('.gcard.locked').length
}));

describe('entitlement is server-decided', () => {
  test('a free /api/me leaves the client on the free tier', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    assert.deepEqual(await isProInUi(page), { flag: false, badge: false, cta: true, lockedCards: 3 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('a Pro /api/me unlocks Pro with no local state involved', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, { pro: true });
    assert.deepEqual(await isProInUi(page), { flag: true, badge: true, cta: false, lockedCards: 0 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Pro survives clearing every byte of browser storage', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { pro: true });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    assert.equal((await isProInUi(page)).flag, true, 'the server still says Pro');
    await ctx.close();
  });

  test('writing a Pro flag into local storage does not grant Pro', async () => {
    // The exact attack the old build was open to: set the entitlement key,
    // reload, get Pro. It must do nothing now.
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.evaluate(() => {
      localStorage.setItem('mindsharp:entitlement', JSON.stringify({ pro: true, licence: 'MS-FAKE-KEY0', since: Date.now() }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    const ui = await isProInUi(page);
    assert.equal(ui.flag, false, 'a forged local entitlement must not grant Pro');
    assert.equal(ui.lockedCards, 3, 'Pro games stay locked');
    await ctx.close();
  });

  test('the dev preview button cannot switch Pro on', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    await page.click('#pw-demo');
    await page.waitForSelector('#pw-msg .notice');
    assert.equal((await isProInUi(page)).flag, false, 'no button can grant Pro any more');
    assert.match(await page.locator('#pw-msg').innerText(), /decided by the server/i);
    await ctx.close();
  });
});

describe('failure modes', () => {
  test('an unreachable server falls back to free, never to Pro', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { apiDown: true });
    const ui = await isProInUi(page);
    assert.equal(ui.flag, false);
    assert.equal(ui.lockedCards, 3);
    // and the game is still playable offline
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#screen-game.active');
    await ctx.close();
  });

  test('a 500 from /api/me falls back to free', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 500, body: { error: 'server_error' } } }
    });
    assert.equal((await isProInUi(page)).flag, false);
    await ctx.close();
  });

  test('a Pro user who loses connectivity keeps the cached entitlement', async () => {
    // A paying user briefly seeing the free tier is a bug report, so the cache
    // holds; it just never upgrades a free user to Pro.
    const { page, ctx } = await openApp(browser, srv.origin, { pro: true });
    assert.equal((await isProInUi(page)).flag, true);
    await ctx.route('**/api/**', r => r.abort('connectionrefused'));
    const ent = await page.evaluate(() => import('/js/entitlement.js').then(m => m.getEntitlement({ force: true })));
    assert.equal(ent.isPro, true, 'cached value survives one failed refresh');
    await ctx.close();
  });
});

describe('run limits come from the server', () => {
  test('the server-reported cap replaces the local default', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': {
          status: 200,
          body: { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' }, limits: { freeRuns: 3, runsUsedToday: 2, runsLeft: 1 } }
        }
      }
    });
    assert.match(await page.locator('#runs-pill').innerText(), /1 run left/);
    await ctx.close();
  });

  test('a signed-in user who has spent the budget is gated immediately', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': {
          status: 200,
          body: { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' }, limits: { freeRuns: 5, runsUsedToday: 5, runsLeft: 0 } }
        }
      }
    });
    assert.match(await page.locator('#runs-pill').innerText(), /0 runs left/);
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#rewardm.show');
    await ctx.close();
  });

  test('Pro hides the runs pill regardless of the local meter', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: proMe() } }
    });
    assert.equal(await page.locator('#runs-pill').isVisible(), false);
    await ctx.close();
  });
});

describe('sign-in', () => {
  test('the strip offers sign-in when auth is configured', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/config': { status: 200, body: { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', authEnabled: true, checkoutEnabled: false } } }
    });
    await page.waitForSelector('#auth-in');
    await page.click('#auth-in');
    await page.waitForSelector('#authm.show');
    await ctx.close();
  });

  test('the strip shows the email and a sign-out when authed', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { pro: true });
    assert.match(await page.locator('#auth-strip').innerText(), /player@example\.com|player@|…/);
    await page.waitForSelector('#auth-out');
    await ctx.close();
  });

  test('a malformed email is rejected before any request goes out', async () => {
    const { page, ctx, calls } = await openApp(browser, srv.origin, {
      api: { '/api/config': { status: 200, body: { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon', authEnabled: true, checkoutEnabled: false } } }
    });
    await page.click('#auth-in');
    await page.waitForSelector('#authm.show');
    await page.fill('#auth-email', 'not-an-email');
    const before = calls.length;
    await page.click('#auth-send');
    await page.waitForSelector('#auth-msg .notice.err');
    assert.match(await page.locator('#auth-msg').innerText(), /doesn.t look like an email/i);
    assert.equal(calls.length, before, 'no network call for an invalid address');
    await ctx.close();
  });

  test('a licence key without an account prompts sign-in instead of unlocking', async () => {
    const { page, ctx, calls } = await openApp(browser, srv.origin);
    await page.click('#pro-cta');
    await page.waitForSelector('#paywall.show');
    await page.fill('#lic-input', 'MS-4KQ2-A19Z');
    await page.click('#lic-btn');
    await page.waitForSelector('#pw-msg .notice.err');
    assert.equal(calls.filter(c => c.path === '/api/licence/validate').length, 0, 'no validate call while signed out');
    assert.equal((await isProInUi(page)).flag, false);
    await ctx.close();
  });
});

describe('local progress migration', () => {
  test('back-fills anonymous history on first sign-in', async () => {
    const posted = [];
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u9', email: 'new@example.com' }, hasRuns: false } },
        '/api/runs': ({ body }) => { posted.push(body); return { status: 200, body: { runId: 1, accepted: true } }; }
      }
    });
    // seed local history, then reload so init() runs the migration against it
    await page.evaluate(() => {
      localStorage.setItem('mindsharp:stats', JSON.stringify({
        solved: 240, correct: 205, bestStreak: 17, best: { blitz: 512 },
        recent: [], days: ['2026-08-20', '2026-08-21', '2026-08-22'],
        ops: { '+': [40, 42], '-': [30, 35], '*': [60, 80], '/': [75, 83] }
      }));
      localStorage.removeItem('mindsharp:migrated');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    await page.waitForFunction(() => !!localStorage.getItem('mindsharp:migrated'), null, { timeout: 5000 });

    assert.equal(posted.length, 1, 'exactly one backfill run');
    const run = posted[0];
    assert.equal(run.game, 'import');
    assert.equal(run.solved, 240);
    assert.equal(run.correct, 205);
    assert.equal(run.bestStreak, 17);
    assert.deepEqual(run.importDays, ['2026-08-20', '2026-08-21', '2026-08-22'], 'day streak carried over');

    // and the local copy is kept, not deleted
    assert.ok(await page.evaluate(() => localStorage.getItem('mindsharp:stats')), 'local stats retained as a fallback');
    await ctx.close();
  });

  test('does not back-fill an account that already has runs', async () => {
    const posted = [];
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u9', email: 'old@example.com' }, hasRuns: true } },
        '/api/runs': ({ body }) => { posted.push(body); return { status: 200, body: { runId: 1, accepted: true } }; }
      }
    });
    await page.evaluate(() => {
      localStorage.setItem('mindsharp:stats', JSON.stringify({ solved: 99, correct: 80, bestStreak: 4, best: {}, recent: [], days: ['2026-08-22'], ops: {} }));
      localStorage.removeItem('mindsharp:migrated');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    await page.waitForFunction(() => !!localStorage.getItem('mindsharp:migrated'), null, { timeout: 5000 });
    assert.equal(posted.length, 0, 'no duplicate import');
    await ctx.close();
  });

  test('runs at most once', async () => {
    const posted = [];
    const api = {
      '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u9', email: 'new@example.com' }, hasRuns: false } },
      '/api/runs': ({ body }) => { posted.push(body); return { status: 200, body: { runId: 1, accepted: true } }; }
    };
    const { page, ctx } = await openApp(browser, srv.origin, { api });
    await page.evaluate(() => {
      localStorage.setItem('mindsharp:stats', JSON.stringify({ solved: 50, correct: 44, bestStreak: 6, best: {}, recent: [], days: ['2026-08-22'], ops: {} }));
      localStorage.removeItem('mindsharp:migrated');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!localStorage.getItem('mindsharp:migrated'), null, { timeout: 5000 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    await page.waitForTimeout(300);
    assert.equal(posted.length, 1, 'migration is idempotent across reloads');
    await ctx.close();
  });
});
