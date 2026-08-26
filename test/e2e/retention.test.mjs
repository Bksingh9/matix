import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly, FREE_ME, proMe } from './helpers.mjs';

/* Phase 7 acceptance, from the player's side: a run visibly moves a level bar,
   a streak appears in the top bar, achievements pop, and none of it requires
   an account. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const runOnce = async (page, mode = 'zen', answers = 3) => {
  await page.click(`.gcard[data-game="${mode}"]`);
  await page.waitForSelector('#screen-game.active');
  await playCorrectly(page, answers);
  await page.click('#zen-end');
  await page.waitForSelector('#screen-results.active');
};

/* Watches the toast host until `want` appears or the budget runs out,
   accumulating every toast that passes through. */
async function collectToasts(page, want, budgetMs = 10000) {
  const seen = new Set();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    for (const t of await page.locator('#toasts .toast').allInnerTexts()) seen.add(t);
    if ([...seen].some(t => want.test(t))) break;
    await page.waitForTimeout(150);
  }
  return [...seen];
}

const localProgress = page => page.evaluate(() => JSON.parse(localStorage.getItem('mindsharp:progress') || 'null'));

describe('anonymous progression', () => {
  test('a first run awards XP and shows the itemised panel', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await runOnce(page);
    await page.waitForSelector('#r-xp.show', { timeout: 6000 });

    const text = await page.locator('#r-xp').innerText();
    assert.match(text, /\+\d+ XP/);
    assert.match(text, /Lv [12]/i);
    assert.match(text, /correct/i, 'the answer line is itemised');
    assert.match(text, /Run finished/i);
    assert.match(text, /First run today/i);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('XP accumulates locally across runs and survives a reload', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await runOnce(page);
    const first = (await localProgress(page)).xp;
    assert.ok(first > 0);

    await page.click('#r-menu');
    await runOnce(page);
    const second = (await localProgress(page)).xp;
    assert.ok(second > first, `${second} should exceed ${first}`);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    assert.equal((await localProgress(page)).xp, second, 'progress is not lost on reload');
    await ctx.close();
  });

  test('the streak chip appears after the first run', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    assert.equal(await page.locator('#streak-chip').isVisible(), false, 'nothing to show yet');
    await runOnce(page);
    await page.click('#r-menu');
    await page.waitForSelector('#streak-chip', { state: 'visible', timeout: 5000 });
    assert.match(await page.locator('#streak-chip').innerText(), /1/);
    await ctx.close();
  });

  test('the level chip tracks the level', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    assert.equal(await page.locator('#level-num').innerText(), '1');
    // Enough play to guarantee at least one level.
    for (let i = 0; i < 3; i++) { await runOnce(page, 'zen', 6); await page.click('#r-menu'); }
    const lvl = Number(await page.locator('#level-num').innerText());
    assert.ok(lvl >= 2, `expected to level up, still on ${lvl}`);
    await ctx.close();
  });

  test('an achievement fires a toast', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    // 10+ problems at 100% unlocks "Flawless".
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 11);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    // Toasts show one at a time on purpose: three unlocks should read as
    // three moments, not one pile. So watch the queue rather than snapshot it.
    const seen = await collectToasts(page, /Flawless/i, 12000);
    assert.ok(seen.some(t => /Flawless/i.test(t)), `expected a Flawless toast, got ${JSON.stringify(seen)}`);
    await ctx.close();
  });

  test('the profile sheet shows level, streak and achievement progress', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await runOnce(page, 'zen', 4);
    await page.click('#r-menu');
    await page.click('#level-chip');
    await page.waitForSelector('#profm.show');
    await page.waitForSelector('.ach', { timeout: 5000 });

    const text = await page.locator('#prof-body').innerText();
    assert.match(text, /XP/);
    assert.match(text, /🔥\s*1/, 'the streak is shown');
    assert.match(text, /Achievements/i);
    assert.match(text, /signed out/i, 'and it is honest that this is browser-only');
    assert.ok((await page.locator('.ach').count()) >= 25, 'the full board is visible, locked included');
    // A locked achievement shows how far off it is, not just "locked".
    assert.ok((await page.locator('.ach:not(.on) .a-bar').count()) > 0, 'progress bars on locked entries');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the daily challenge pays a visible premium', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.click('#daily-card');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 14);
    await page.waitForSelector('#screen-results.active', { timeout: 12000 });
    await page.waitForSelector('#r-xp.show', { timeout: 6000 });
    const text = await page.locator('#r-xp').innerText();
    assert.match(text, /Daily challenge/i);
    assert.match(text, /Perfect daily/i);
    await ctx.close();
  });
});

describe('server progression', () => {
  const serverProgress = (over = {}) => ({
    xpGained: 148,
    xpLines: [
      { code: 'answers', label: '18 correct', xp: 54 },
      { code: 'complete', label: 'Run finished', xp: 5 },
      { code: 'first_today', label: 'First run today', xp: 10 },
      { code: 'streak', label: '7-day streak', xp: 35 },
      { code: 'milestone', label: '7-day milestone', xp: 44 }
    ],
    xp: 2400,
    level: { level: 7, xp: 2400, intoLevel: 120, levelSpan: 300, toNext: 180, progress: 0.4, title: 'Getting quick' },
    levelledUp: true,
    levelsGained: 1,
    streak: { dayStreak: 7, longest: 7, freezes: 1, freezeEarned: true, freezesUsed: 0, milestone: 7, extended: true, wasBroken: false },
    achievements: [{ code: 'streak_7', name: 'One week', desc: 'Play 7 days running', tier: 'bronze', xp: 25 }],
    achievementsUnlocked: 4,
    achievementsTotal: 31,
    ...over
  });

  const api = (over = {}) => ({
    '/api/me': { status: 200, body: proMe() },
    '/api/runs': { status: 200, body: { runId: 1, accepted: true, progress: serverProgress() } },
    '/api/progress': {
      status: 200,
      body: {
        authed: true,
        level: serverProgress().level,
        streak: { status: 'safe', dayStreak: 7, freezes: 1, longest: 7, daysPlayed: 7, lastDay: '2026-08-26' },
        totals: { solved: 420, correct: 380, accuracy: 0.905, dailiesDone: 7, drillsDone: 2, bestRunStreak: 22, modesPlayed: 5 },
        achievements: [
          { code: 'streak_7', name: 'One week', desc: 'Play 7 days running', tier: 'bronze', goal: 7, value: 7, progress: 1, unlocked: true, xp: 25 },
          { code: 'streak_30', name: 'One month', desc: 'Play 30 days running', tier: 'silver', goal: 30, value: 7, progress: 0.23, unlocked: false, xp: 60 }
        ],
        achievementsUnlocked: 4,
        achievementsTotal: 31
      }
    },
    '/api/weakspots': { status: 200, body: { buckets: [], strongest: null, overall: { attemptsAnalysed: 0 }, sampleTooSmall: true, attemptsNeeded: 40 } },
    ...over
  });

  test("the server's numbers win, and the milestone is celebrated", async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, { api: api() });
    await runOnce(page, 'zen', 2);
    await page.waitForSelector('#r-xp.show', { timeout: 6000 });

    const text = await page.locator('#r-xp').innerText();
    assert.match(text, /\+148 XP/, "the server's total, not a locally computed one");
    assert.match(text, /Lv 7/i);
    assert.match(text, /7-day milestone/);

    const toasts = await collectToasts(page, /Level 7/, 12000);
    assert.ok(toasts.some(t => /Level 7/.test(t)), `level-up card; got ${JSON.stringify(toasts)}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the streak chip reflects the server streak', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: api() });
    await page.waitForSelector('#streak-chip', { state: 'visible', timeout: 6000 });
    assert.match(await page.locator('#streak-chip').innerText(), /7/);
    assert.equal(await page.locator('#level-num').innerText(), '7');
    await ctx.close();
  });

  test('an at-risk streak is flagged in the top bar', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({
        '/api/progress': {
          status: 200,
          body: {
            authed: true,
            level: { level: 7, xp: 2400, intoLevel: 0, levelSpan: 300, toNext: 300, progress: 0, title: 'Getting quick' },
            streak: { status: 'urgent', dayStreak: 12, freezes: 0, longest: 12, hoursLeftInDay: 3 },
            totals: {}, achievements: [], achievementsUnlocked: 0, achievementsTotal: 31
          }
        }
      })
    });
    await page.waitForSelector('#streak-chip.urgent', { timeout: 6000 });
    await page.click('#streak-chip');
    await page.waitForSelector('#profm.show');
    assert.match(await page.locator('#prof-body').innerText(), /or you lose it/i);
    await ctx.close();
  });

  test('a frozen streak reads as frozen, not lost', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({
        '/api/progress': {
          status: 200,
          body: {
            authed: true,
            level: { level: 9, xp: 4000, intoLevel: 0, levelSpan: 400, toNext: 400, progress: 0, title: 'Fast hands' },
            streak: { status: 'frozen', dayStreak: 40, freezes: 2, longest: 40 },
            totals: {}, achievements: [], achievementsUnlocked: 0, achievementsTotal: 31
          }
        }
      })
    });
    await page.waitForSelector('#streak-chip.frozen', { timeout: 6000 });
    assert.match(await page.locator('#streak-chip').innerText(), /❄|40/);
    await ctx.close();
  });

  test('a signed-in profile does not claim to be browser-only', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: api() });
    await page.click('#level-chip');
    await page.waitForSelector('#profm.show');
    await page.waitForSelector('.ach', { timeout: 6000 });
    const text = await page.locator('#prof-body').innerText();
    assert.equal(/signed out/i.test(text), false);
    assert.match(text, /90|91/, 'accuracy from the server');
    await ctx.close();
  });

  test('a progression-less response does not leave a stale panel', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: api({ '/api/runs': { status: 200, body: { runId: 2, accepted: true } } })
    });
    await runOnce(page, 'zen', 2);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#r-xp.show').count(), 0, 'no XP, no panel');
    await ctx.close();
  });
});

describe('offline', () => {
  test('a queued run still awards progression locally', async () => {
    // The streak must tick over even on a train. Reconciled from
    // /api/progress on the next successful connection.
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: { ...FREE_ME, authed: true, user: { id: 'u1', email: 'a@b.co' } } },
        '/api/progress': { status: 503, body: { error: 'down' } },
        '/api/runs': { status: 503, body: { error: 'down' } }
      }
    });
    await runOnce(page, 'zen', 3);
    await page.waitForSelector('#r-xp.show', { timeout: 8000 });
    assert.match(await page.locator('#r-xp').innerText(), /\+\d+ XP/);
    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('mindsharp:runqueue') || '[]').length);
    assert.equal(queued, 1, 'and the run is still queued for upload');
    await ctx.close();
  });
});
