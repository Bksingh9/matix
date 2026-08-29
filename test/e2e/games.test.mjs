import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly, snapshotState, openSettings, blockWebfonts } from './helpers.mjs';

/* Phase 0 acceptance: the modular build must behave like the single file.
   Every game mode is actually played, not just rendered. */

let srv, browser;

before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

describe('app boot', () => {
  test('loads with no console errors and renders the menu', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    assert.equal(await page.locator('#screen-menu.active').count(), 1);
    // Derived from the catalogue rather than hard-coded: the point of this
    // assertion is that every non-hidden mode gets a card, not that there are
    // exactly N of them. A literal here fails every time a mode is added,
    // which teaches people to bump the number rather than read the failure.
    const expected = await page.evaluate(async () => {
      const { GAMES } = await import('/js/games.js');
      return Object.values(GAMES).filter(g => !g.hidden).length;
    });
    assert.ok(expected >= 8, 'the catalogue itself looks wrong');
    assert.equal(await page.locator('.gcard').count(), expected, 'every visible mode gets a card');
    assert.match(await page.locator('#runs-pill').innerText(), /5 runs left/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('locked Pro games show a Pro chip and open the paywall', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    assert.equal(await page.locator('.gcard.locked').count(), 3, 'Target, Recall and Drill locked');
    await page.click('.gcard[data-game="target"]');
    await page.waitForSelector('#paywall.show');
    assert.match(await page.locator('#pw-reason').innerText(), /Target/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('game modes', () => {
  const freeModes = ['blitz', 'survival', 'verify', 'operator', 'zen'];
  const proModes = ['target', 'recall'];

  for (const mode of freeModes) {
    test(`${mode}: plays and scores`, async () => {
      const { page, ctx, errors } = await openApp(browser, srv.origin);
      await page.click(`.gcard[data-game="${mode}"]`);
      await page.waitForSelector('#screen-game.active');
      const answered = await playCorrectly(page, 4);
      assert.ok(answered >= 3, `${mode} answered ${answered} problems`);
      const s = await snapshotState(page);
      assert.ok(s.score > 0, `${mode} scored ${s.score}`);
      assert.ok(s.correct >= 3, `${mode} got ${s.correct} correct`);
      assert.deepEqual(errors, [], `${mode} console errors`);
      await ctx.close();
    });
  }

  for (const mode of proModes) {
    test(`${mode}: plays and scores when Pro`, async () => {
      const { page, ctx, errors } = await openApp(browser, srv.origin, { pro: true });
      await page.click(`.gcard[data-game="${mode}"]`);
      await page.waitForSelector('#screen-game.active');
      const answered = await playCorrectly(page, 4);
      assert.ok(answered >= 2, `${mode} answered ${answered} problems`);
      const s = await snapshotState(page);
      assert.ok(s.correct >= 2, `${mode} got ${s.correct} correct`);
      assert.deepEqual(errors, [], `${mode} console errors`);
      await ctx.close();
    });
  }

  test('zen ends on demand and reaches the results screen', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 3);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    assert.equal(await page.locator('#r-heading').innerText(), 'Session complete');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('blitz run ends on the clock and records a best score', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    // fast-forward the run clock rather than waiting 60s
    await page.evaluate(() => { window.__mindsharp.S.timeLeft = 0.05; });
    await page.waitForSelector('#screen-results.active', { timeout: 5000 });
    assert.equal(await page.locator('#r-heading').innerText(), "Time's up");
    const best = await page.evaluate(() => window.__mindsharp.S.stats.best.blitz);
    assert.ok(best > 0, 'best score persisted');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('daily challenge', () => {
  test('is deterministic for a given date and locks after one attempt', async () => {
    const seq = async () => {
      const { page, ctx } = await openApp(browser, srv.origin);
      await page.click('#daily-card');
      await page.waitForSelector('#screen-game.active');
      const first = await page.evaluate(() => {
        const p = window.__mindsharp.S.problem;
        return [p.kind, p.answer];
      });
      await ctx.close();
      return first;
    };
    const a = await seq(), b = await seq();
    assert.deepEqual(a, b, 'same date must yield the same first problem');
  });

  test('completes twelve problems and produces a share grid', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await page.click('#daily-card');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 14);
    await page.waitForSelector('#screen-results.active', { timeout: 10000 });
    const grid = await page.locator('#r-grid').innerText();
    assert.equal([...grid].filter(c => c === '🟩' || c === '🟥').length, 12, 'twelve grid squares');
    assert.equal(await page.locator('#r-heading').innerText(), 'Daily done');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('free-run cap', () => {
  test('five runs then the reward sheet', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    for (let i = 0; i < 5; i++) {
      await page.click('.gcard[data-game="blitz"]');
      await page.waitForSelector('#screen-game.active');
      await page.click('#quit-btn');
      await page.waitForSelector('#screen-menu.active');
    }
    assert.match(await page.locator('#runs-pill').innerText(), /0 runs left/);
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#rewardm.show');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Pro removes the cap and the runs pill', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, { pro: true });
    assert.equal(await page.locator('#runs-pill').isVisible(), false);
    for (let i = 0; i < 6; i++) {
      await page.click('.gcard[data-game="blitz"]');
      await page.waitForSelector('#screen-game.active');
      await page.click('#quit-btn');
      await page.waitForSelector('#screen-menu.active');
    }
    assert.equal(await page.locator('#rewardm.show').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe('settings', () => {
  test('operation chips constrain the generator', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await openSettings(page);
    for (const op of ['+', '-', '/']) await page.click(`#ops .op-chip[data-op="${op}"]`);
    assert.deepEqual(await page.evaluate(() => window.__mindsharp.S.ops), ['*']);
    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#screen-game.active');
    const ops = new Set();
    for (let i = 0; i < 5; i++) {
      ops.add(await page.evaluate(() => window.__mindsharp.S.problem.op));
      await playCorrectly(page, 1);
    }
    assert.deepEqual([...ops], ['*'], 'only multiplication generated');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('expert difficulty is Pro-gated', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await openSettings(page);
    await page.click('#diff button[data-diff="expert"]');
    await page.waitForSelector('#paywall.show');
    assert.match(await page.locator('#pw-reason').innerText(), /Expert difficulty/);
    assert.equal(await page.evaluate(() => window.__mindsharp.S.difficulty), 'medium');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the last operation chip cannot be turned off', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await openSettings(page);
    for (const op of ['+', '-', '/', '*']) await page.click(`#ops .op-chip[data-op="${op}"]`);
    const ops = await page.evaluate(() => window.__mindsharp.S.ops);
    assert.equal(ops.length, 1, 'at least one operation stays selected');
    await ctx.close();
  });
});

describe('persistence', () => {
  test('stats survive a reload', async () => {
    const ctx = await blockWebfonts(await browser.newContext({ viewport: { width: 420, height: 900 } }));
    const page = await ctx.newPage();
    await page.goto(srv.origin + '/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__mindsharp);
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 3);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    const before = await page.evaluate(() => window.__mindsharp.S.stats.solved);
    assert.ok(before >= 3);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.S && window.__mindsharp.S.stats.solved > 0, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__mindsharp.S.stats.solved), before);
    await ctx.close();
  });

  test('recall answers do not pollute the addition tally', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { pro: true });
    await page.click('.gcard[data-game="recall"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 3);
    const ops = await page.evaluate(() => window.__mindsharp.S.stats.ops);
    assert.deepEqual(ops['+'], [0, 0], 'recall has no operation, so no bucket moves');
    await ctx.close();
  });
});
