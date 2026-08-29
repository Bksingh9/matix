import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp } from './helpers.mjs';

/* Memory Matrix, played for real.
 *
 * The rules are unit-tested in test/matrix.test.mjs; this covers the part
 * those cannot — that the reveal actually reveals, that taps land on the right
 * cells, and that a miss is judged the moment it happens. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const startMatrix = async page => {
  await page.click('.gcard[data-game="matrix"]');
  await page.waitForSelector('#screen-game.active', { timeout: 8000 });
  await page.waitForSelector('#panel-grid.show', { timeout: 5000 });
};
const waitForRecall = page => page.waitForFunction(
  () => !window.__mindsharp.S.memorizing && !window.__mindsharp.S.locked,
  null, { timeout: 8000 });
const pattern = page => page.evaluate(() => window.__mindsharp.S.problem.pattern);
const st = page => page.evaluate(() => {
  const S = window.__mindsharp.S;
  return { correct: S.correct, wrong: S.wrong, lives: S.lives, score: S.score, screen: S.screen };
});

describe('memory matrix', () => {
  test('flashes a pattern, then hides it', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await startMatrix(page);

    const p = await pattern(page);
    const litNow = await page.evaluate(() => document.querySelectorAll('#panel-grid .tile.lit').length);
    assert.equal(litNow, p.count, 'the whole pattern is shown during the reveal');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#panel-grid .tile').length),
      p.size * p.size, 'the grid is the size the rules asked for');

    await waitForRecall(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#panel-grid .tile.lit').length), 0,
      'and hidden before you may tap — otherwise it is not a memory game');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('tapping the pattern back clears the level and scores', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await startMatrix(page);
    await waitForRecall(page);

    const p = await pattern(page);
    for (const c of p.cells) await page.click(`#panel-grid .tile[data-cell="${c}"]`);
    await page.waitForFunction(() => window.__mindsharp.S.correct >= 1, null, { timeout: 5000 });

    const s = await st(page);
    assert.equal(s.correct, 1);
    assert.ok(s.score > 0, 'a clear is worth points');
    assert.equal(s.lives, 3, 'and costs no life');
    await ctx.close();
  });

  test('a tile outside the pattern costs a life immediately', async () => {
    // Judged on the tap, not at submission: otherwise tapping every tile
    // would clear every board.
    const { page, ctx } = await openApp(browser, srv.origin);
    await startMatrix(page);
    await waitForRecall(page);

    const p = await pattern(page);
    const wrong = [...Array(p.size * p.size).keys()].find(i => !p.cells.includes(i));
    await page.click(`#panel-grid .tile[data-cell="${wrong}"]`);
    await page.waitForFunction(() => window.__mindsharp.S.wrong >= 1, null, { timeout: 5000 });

    const s = await st(page);
    assert.equal(s.lives, 2);
    assert.equal(s.correct, 0, 'and no partial credit for the tiles already found');
    await ctx.close();
  });

  test('a miss shows what the pattern actually was', async () => {
    // Being told the answer is how a memory game teaches. A bare "wrong"
    // teaches nothing.
    const { page, ctx } = await openApp(browser, srv.origin);
    await startMatrix(page);
    await waitForRecall(page);

    const p = await pattern(page);
    const wrong = [...Array(p.size * p.size).keys()].find(i => !p.cells.includes(i));
    await page.click(`#panel-grid .tile[data-cell="${wrong}"]`);
    await page.waitForSelector('#panel-grid .tile.was', { timeout: 5000 });

    const shown = await page.evaluate(() => document.querySelectorAll('#panel-grid .tile.was, #panel-grid .tile.hit').length);
    assert.equal(shown, p.count, 'every tile of the pattern is accounted for');
    await ctx.close();
  });

  test('taps during the reveal are ignored', async () => {
    // Without this the whole game is "tap everything while it is still lit".
    const { page, ctx } = await openApp(browser, srv.origin);
    await startMatrix(page);

    const p = await pattern(page);
    await page.evaluate(cells => {
      for (const c of cells) document.querySelector(`#panel-grid .tile[data-cell="${c}"]`)?.click();
    }, p.cells);

    const s = await st(page);
    assert.equal(s.correct, 0, 'nothing was scored');
    assert.equal(s.wrong, 0, 'and nothing was penalised either');
    await ctx.close();
  });

  test('three misses end the run', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await startMatrix(page);

    for (let i = 0; i < 3; i++) {
      await waitForRecall(page);
      const p = await pattern(page);
      const wrong = [...Array(p.size * p.size).keys()].find(c => !p.cells.includes(c));
      await page.click(`#panel-grid .tile[data-cell="${wrong}"]`);
      await page.waitForTimeout(900);
    }
    await page.waitForSelector('#screen-results.active', { timeout: 8000 });
    assert.equal((await st(page)).lives, 0);
    await ctx.close();
  });

  test('Matrix Rush runs on a clock instead of lives', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await page.click('.gcard[data-game="mrush"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await page.waitForSelector('#panel-grid.show', { timeout: 5000 });
    await waitForRecall(page);

    // A miss must not cost a life — there are none. The clock is the pressure.
    const p = await pattern(page);
    const wrong = [...Array(p.size * p.size).keys()].find(i => !p.cells.includes(i));
    await page.click(`#panel-grid .tile[data-cell="${wrong}"]`);
    await page.waitForFunction(() => window.__mindsharp.S.wrong >= 1, null, { timeout: 5000 });

    const s = await st(page);
    assert.equal(s.screen, 'game', 'the run continues');
    assert.ok(await page.evaluate(() => window.__mindsharp.S.timeLeft > 0), 'and the clock is running');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Matrix Zen has nothing to lose — that is what makes it the way in', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await page.click('.gcard[data-game="mzen"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await page.waitForSelector('#panel-grid.show', { timeout: 5000 });

    // Three misses in a row. In Classic that ends the run; here it must not.
    for (let i = 0; i < 3; i++) {
      await waitForRecall(page);
      const p = await pattern(page);
      const wrong = [...Array(p.size * p.size).keys()].find(c => !p.cells.includes(c));
      await page.click(`#panel-grid .tile[data-cell="${wrong}"]`);
      await page.waitForTimeout(900);
    }
    assert.equal((await st(page)).screen, 'game', 'still playing after three misses');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('every matrix variant deals a real grid', async () => {
    for (const mode of ['matrix', 'mrush', 'mzen']) {
      const { page, ctx, errors } = await openApp(browser, srv.origin);
      await page.click(`.gcard[data-game="${mode}"]`);
      await page.waitForSelector('#panel-grid.show', { timeout: 8000 });
      const p = await pattern(page);
      assert.ok(p.count >= 2 && p.size >= 3, `${mode} dealt ${p.count} on ${p.size}x${p.size}`);
      assert.deepEqual(errors, [], `${mode} threw`);
      await ctx.close();
    }
  });

  test('the mode is free — it is the hook, not the paywall', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    const locked = await page.evaluate(() =>
      document.querySelector('.gcard[data-game="matrix"]')?.classList.contains('locked'));
    assert.equal(locked, false);
    await ctx.close();
  });
});
