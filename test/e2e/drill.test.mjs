import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly, proMe, FREE_ME } from './helpers.mjs';

/* Phase 5 acceptance, from the player's side: a Pro user with a bad division
   record taps "Drill these", plays a visibly division-heavy set, and sees a
   real before/after delta. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const WEAKSPOTS = {
  buckets: [
    { op: '/', band: 2, label: 'Division, 10–99', seen: 60, accuracy: 0.55, medianMs: 5200, targetMs: 3200, weakness: 0.62, trend: 'worsening', mastered: false },
    { op: '*', band: 3, label: 'Multiplication, 100–999', seen: 40, accuracy: 0.65, medianMs: 4900, targetMs: 4800, weakness: 0.41, trend: 'steady', mastered: false },
    { op: '+', band: 1, label: 'Addition, 0–9', seen: 50, accuracy: 0.98, medianMs: 1200, targetMs: 2200, weakness: 0.04, trend: null, mastered: true }
  ],
  strongest: { op: '+', band: 1, label: 'Addition, 0–9', accuracy: 0.98 },
  overall: { accuracy: 0.79, medianMs: 3400, attemptsAnalysed: 220 },
  sampleTooSmall: false,
  attemptsNeeded: 0
};

/* 20 problems: 14 division band 2, 4 multiplication band 3, 2 addition band 1,
   interleaved the way the real endpoint returns them. */
function drillSet() {
  const div = Array.from({ length: 14 }, (_, i) => ({ op: '/', a: (i % 9 + 3) * 6, b: 6, answer: i % 9 + 3, band: 2, difficulty: 'medium' }));
  const mul = Array.from({ length: 4 }, (_, i) => ({ op: '*', a: 120 + i * 30, b: 3, answer: (120 + i * 30) * 3, band: 3, difficulty: 'hard' }));
  const add = Array.from({ length: 2 }, (_, i) => ({ op: '+', a: 3 + i, b: 4, answer: 7 + i, band: 1, difficulty: 'easy' }));
  const out = [];
  const pools = [div, mul, add];
  while (pools.some(p => p.length)) {
    for (const p of pools) if (p.length) out.push(p.shift());
  }
  return out;
}

const DRILL = {
  drillId: 88,
  size: 20,
  targeted: [
    { op: '/', band: 2, count: 14, label: 'Division, 10–99', weakness: 0.62, accuracy: 0.55, medianMs: 5200, targetMs: 3200, seen: 60 },
    { op: '*', band: 3, count: 4, label: 'Multiplication, 100–999', weakness: 0.41, accuracy: 0.65, medianMs: 4900, targetMs: 4800, seen: 40 },
    { op: '+', band: 1, count: 2, label: 'Addition, 0–9', weakness: 0.04, accuracy: 0.98, medianMs: 1200, targetMs: 2200, seen: 50 }
  ],
  problems: drillSet(),
  overall: WEAKSPOTS.overall
};

const proApi = (over = {}) => ({
  '/api/me': { status: 200, body: proMe() },
  '/api/weakspots': { status: 200, body: WEAKSPOTS },
  '/api/drills': { status: 200, body: DRILL },
  '/api/runs': { status: 200, body: { runId: 1, accepted: true } },
  ...over
});

describe('the weak-spot report', () => {
  test('a Pro user sees ranked buckets after a run', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForSelector('.ws-row', { timeout: 6000 });

    const text = await page.locator('#r-locked').innerText();
    assert.match(text, /Division, 10–99/);
    assert.match(text, /55%/);
    assert.match(text, /5\.2s/);
    assert.match(text, /mastered/i, 'graduated buckets stay visible with a marker');
    await page.waitForSelector('#weak-drill-btn');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('a thin sample says "not yet" instead of inventing insight', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: proApi({
        '/api/weakspots': { status: 200, body: { ...WEAKSPOTS, buckets: [], sampleTooSmall: true, attemptsNeeded: 28, overall: { accuracy: null, medianMs: null, attemptsAnalysed: 12 } } }
      })
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForFunction(() => /more rounds/.test(document.querySelector('#weak-body')?.innerText || ''), null, { timeout: 6000 });
    const text = await page.locator('#weak-body').innerText();
    assert.match(text, /more rounds/);
    assert.equal(/\d+%/.test(text), false, 'no percentages from twelve data points');
    await ctx.close();
  });

  test('a free user sees a teaser describing what actually exists', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: FREE_ME }, '/api/runs': { status: 200, body: { runId: 1, accepted: true } } }
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    const text = await page.locator('#r-locked').innerText();
    assert.match(text, /before\/after/i, 'the teaser names the feature that now exists');
    assert.match(text, /forty answers/i, 'and is honest about needing data first');
    await page.waitForSelector('#r-locked-cta');
    await ctx.close();
  });
});

describe('drill mode', () => {
  test('is locked for free users and opens the paywall', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: FREE_ME } }
    });
    const card = page.locator('.gcard[data-game="drill"]');
    assert.equal(await card.count(), 1, 'the drill card is in the grid');
    assert.ok((await card.getAttribute('class')).includes('locked'));
    await card.click();
    await page.waitForSelector('#paywall.show');
    await ctx.close();
  });

  test('plays the exact set the server returned, in order', async () => {
    const { page, ctx, errors, calls } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });

    assert.equal(calls.filter(c => c.path === '/api/drills').length, 1);

    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(await page.evaluate(() => {
        const p = window.__mindsharp.S.problem;
        return { op: p.op, a: p.a, b: p.b };
      }));
      await playCorrectly(page, 1);
    }
    const expected = DRILL.problems.slice(0, 5).map(p => ({ op: p.op, a: p.a, b: p.b }));
    assert.deepEqual(seen, expected, 'no client-side generation in drill mode');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('is visibly division-heavy for a bad division record', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    const ops = await page.evaluate(() => window.__mindsharp.S.drill.problems.map(p => p.op));
    const division = ops.filter(o => o === '/').length;
    assert.ok(division >= 10, `${division}/20 division — visibly targeted`);
    await ctx.close();
  });

  test('costs no lives — it is practice, not a test', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });

    const livesBefore = await page.evaluate(() => window.__mindsharp.S.lives);
    // Answer wrong deliberately.
    const wrong = await page.evaluate(() => String(window.__mindsharp.S.problem.answer + 1));
    for (const ch of wrong) await page.click(`#panel-pad .key[data-key="${ch}"]`);
    await page.evaluate(() => { if (!window.__mindsharp.S.locked) document.querySelector('#panel-pad .key.enter').click(); });
    await page.waitForTimeout(900);

    assert.equal(await page.evaluate(() => window.__mindsharp.S.lives), livesBefore, 'a miss costs nothing');
    assert.equal(await page.evaluate(() => window.__mindsharp.S.screen), 'game', 'the run continues');
    await ctx.close();
  });

  test('ignores the difficulty selector and says so', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: proApi() });
    await page.evaluate(() => { document.querySelector('details.settings').open = true; });
    await page.click('#diff button[data-diff="easy"]');
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    // The set is still the server's, band-3 multiplication included.
    const bands = await page.evaluate(() => window.__mindsharp.S.drill.problems.map(p => p.band));
    assert.ok(bands.includes(3), 'still drilling band 3 despite "easy" being selected');
    assert.match(await page.locator('#subprompt').innerText(), /Targeting/i, 'the UI says the band is what sets the numbers');
    await ctx.close();
  });

  test('reaching the end of the set finishes the run', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await playCorrectly(page, 24);
    await page.waitForSelector('#screen-results.active', { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__mindsharp.S.solved), 20);
    await ctx.close();
  });
});

describe('the before/after screen', () => {
  test('shows a real delta per targeted bucket', async () => {
    const posted = [];
    const { page, ctx, errors } = await openApp(browser, srv.origin, {
      api: proApi({ '/api/runs': ({ body }) => { posted.push(body); return { status: 200, body: { runId: 5, accepted: true } }; } })
    });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await playCorrectly(page, 24);          // answer everything correctly
    await page.waitForSelector('#screen-results.active', { timeout: 20000 });
    await page.waitForSelector('.ba-row', { timeout: 6000 });

    const text = await page.locator('#r-locked').innerText();
    assert.match(text, /Before \/ after/i);
    assert.match(text, /Division, 10–99/);
    assert.match(text, /55%/, 'the pre-drill number');
    assert.match(text, /100%/, 'and this session');
    assert.match(text, /\+45 pts/, 'the delta itself');
    assert.match(text, /improved on/i);

    // The run is attributed to the drill so it can be marked complete.
    const run = posted.find(p => p.game === 'drill');
    assert.ok(run, 'the drill run was posted');
    assert.equal(run.drillId, 88);
    assert.equal(run.difficulty, 'mixed');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('does not claim improvement that did not happen', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });

    // Answer every problem wrong.
    for (let i = 0; i < 20; i++) {
      const done = await page.evaluate(() => window.__mindsharp.S.screen !== 'game');
      if (done) break;
      await page.evaluate(() => {
        const S = window.__mindsharp.S;
        if (S.locked || !S.problem) return;
        S.input = String(S.problem.answer + 1);
      });
      await page.evaluate(() => import('/js/engine.js').then(m => m.submitPad()));
      await page.waitForTimeout(760);
    }
    await page.waitForSelector('#screen-results.active', { timeout: 20000 });
    await page.waitForSelector('.ba-row', { timeout: 6000 });

    const text = await page.locator('#r-locked').innerText();
    assert.match(text, /-55 pts/, 'the drop is reported honestly');
    assert.equal(/improved on/i.test(text), false, 'no invented progress');
    await ctx.close();
  });

  test('offers another drill straight from the comparison', async () => {
    const { page, ctx, calls } = await openApp(browser, srv.origin, { api: proApi() });
    await page.click('.gcard[data-game="drill"]');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await playCorrectly(page, 24);
    await page.waitForSelector('#screen-results.active', { timeout: 20000 });
    await page.waitForSelector('#weak-drill-btn', { timeout: 6000 });

    const before = calls.filter(c => c.path.startsWith('/api/drills')).length;
    await page.click('#weak-drill-btn');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    assert.equal(calls.filter(c => c.path.startsWith('/api/drills')).length, before + 1, 'a fresh set, not a replay');
    await ctx.close();
  });
});

describe('cold start', () => {
  test('a 422 explains how much more play is needed, and starts nothing', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: proApi({ '/api/drills': { status: 422, body: { error: 'insufficient_data', attemptsNeeded: 28, attemptsSoFar: 12 } } })
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForSelector('#weak-drill-btn', { timeout: 6000 });
    await page.click('#weak-drill-btn');

    await page.waitForFunction(() => /more rounds/i.test(document.querySelector('#weak-body')?.innerText || ''), null, { timeout: 6000 });
    assert.match(await page.locator('#weak-body').innerText(), /more rounds/i);
    assert.equal(await page.evaluate(() => window.__mindsharp.S.screen), 'results', 'no fabricated drill');
    await ctx.close();
  });

  test('a fully mastered profile is told so', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: proApi({ '/api/drills': { status: 422, body: { error: 'all_mastered', buckets: [] } } })
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForSelector('#weak-drill-btn', { timeout: 6000 });
    await page.click('#weak-drill-btn');
    await page.waitForFunction(() => /graduated/i.test(document.querySelector('#weak-body')?.innerText || ''), null, { timeout: 6000 });
    await ctx.close();
  });
});
