import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly, proMe, FREE_ME } from './helpers.mjs';

/* Phase 4 acceptance: playing produces well-formed attempt rows, and a run
   played offline is not a lost run. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const authedMe = (over = {}) => ({ ...proMe(), ...over });

function collector() {
  const posted = [];
  return {
    posted,
    api: {
      '/api/me': { status: 200, body: authedMe() },
      '/api/runs': ({ body }) => { posted.push(body); return { status: 200, body: { runId: posted.length, accepted: true } }; }
    }
  };
}

describe('attempt collection', () => {
  test('a played run posts attempts with operands and timings', async () => {
    const c = collector();
    const { page, ctx, errors } = await openApp(browser, srv.origin, { api: c.api });

    await page.click('.gcard[data-game="blitz"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 4);
    await page.evaluate(() => { window.__mindsharp.S.timeLeft = 0.05; });
    await page.waitForSelector('#screen-results.active');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(400);

    const run = c.posted.find(p => p.game === 'blitz');
    assert.ok(run, 'the run was posted');
    assert.equal(run.difficulty, 'medium');
    assert.ok(run.attempts.length >= 4, `${run.attempts.length} attempts logged`);
    assert.equal(run.correct, run.attempts.filter(a => a.isCorrect).length);

    for (const a of run.attempts) {
      assert.ok(['pad', 'tf', 'ops', 'chips', 'recall'].includes(a.kind), `kind ${a.kind}`);
      assert.ok(['+', '-', '*', '/'].includes(a.op), `op ${a.op}`);
      assert.equal(typeof a.a, 'number', 'operand a present');
      assert.equal(typeof a.b, 'number', 'operand b present');
      assert.equal(typeof a.answer, 'number');
      assert.equal(typeof a.isCorrect, 'boolean');
      assert.ok(a.elapsedMs > 0 && a.elapsedMs < 120000, `sane elapsedMs: ${a.elapsedMs}`);
    }
    // The client must never send a band — the server computes it.
    assert.ok(run.attempts.every(a => a.band === undefined), 'no client-supplied band');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('recall attempts carry a null op', async () => {
    const c = collector();
    const { page, ctx } = await openApp(browser, srv.origin, { api: c.api });
    await page.click('.gcard[data-game="recall"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 3);
    // End the run directly rather than racing the per-problem timer, which
    // will not fire while a recall problem is still in its memorise phase.
    await page.evaluate(() => import('/js/engine.js').then(m => m.endRun('dead')));
    await page.waitForSelector('#screen-results.active', { timeout: 8000 });
    await page.waitForTimeout(400);

    const run = c.posted.find(p => p.game === 'recall');
    assert.ok(run, 'recall run posted');
    assert.ok(run.attempts.length >= 3);
    assert.ok(run.attempts.every(a => a.op === null), 'a memory round is not addition');
    await ctx.close();
  });

  test('a wrong answer records what was actually entered', async () => {
    const c = collector();
    const { page, ctx } = await openApp(browser, srv.origin, { api: c.api });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');

    // Answer deliberately wrong.
    const wrong = await page.evaluate(() => {
      const p = window.__mindsharp.S.problem;
      return String(p.answer + 1);
    });
    for (const ch of wrong) await page.click(`#panel-pad .key[data-key="${ch}"]`);
    await page.evaluate(() => { if (!window.__mindsharp.S.locked) document.querySelector('#panel-pad .key.enter').click(); });
    await page.waitForTimeout(900);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForTimeout(400);

    const run = c.posted.find(p => p.game === 'zen');
    const miss = run.attempts.find(a => !a.isCorrect);
    assert.ok(miss, 'the miss was logged');
    assert.equal(miss.given, Number(wrong), 'the wrong answer itself, not just "wrong"');
    assert.equal(miss.timedOut, false);
    await ctx.close();
  });

  test('an anonymous player posts nothing', async () => {
    const posted = [];
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: FREE_ME },
        '/api/runs': ({ body }) => { posted.push(body); return { status: 200, body: { runId: 1, accepted: true } }; }
      }
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForTimeout(400);
    assert.equal(posted.length, 0, 'no account, nothing to attach a run to');
    await ctx.close();
  });
});

describe('offline retry queue', () => {
  test('a run played offline is queued and sent on the next success', async () => {
    let online = false;
    const posted = [];
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: authedMe() },
        '/api/runs': ({ body }) => {
          if (!online) return { status: 503, body: { error: 'offline' } };
          posted.push(body);
          return { status: 200, body: { runId: posted.length, accepted: true } };
        }
      }
    });

    // Play with the server refusing.
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForFunction(() => {
      const q = localStorage.getItem('mindsharp:runqueue');
      return q && JSON.parse(q).length === 1;
    }, null, { timeout: 6000 });
    assert.equal(posted.length, 0, 'nothing reached the server yet');

    // Server comes back; the next successful run drains the queue.
    online = true;
    await page.click('#r-menu');
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForFunction(() => {
      const q = localStorage.getItem('mindsharp:runqueue');
      return !q || JSON.parse(q).length === 0;
    }, null, { timeout: 8000 });

    assert.equal(posted.length, 2, 'both the queued run and the new one arrived');
    await ctx.close();
  });

  test('the queue survives a reload', async () => {
    let online = false;
    const posted = [];
    const api = {
      '/api/me': { status: 200, body: authedMe() },
      '/api/runs': ({ body }) => {
        if (!online) return { status: 503, body: { error: 'offline' } };
        posted.push(body);
        return { status: 200, body: { runId: posted.length, accepted: true } };
      }
    };
    const { page, ctx } = await openApp(browser, srv.origin, { api });

    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForFunction(() => {
      const q = localStorage.getItem('mindsharp:runqueue');
      return q && JSON.parse(q).length === 1;
    }, null, { timeout: 6000 });

    online = true;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    await page.waitForFunction(() => {
      const q = localStorage.getItem('mindsharp:runqueue');
      return !q || JSON.parse(q).length === 0;
    }, null, { timeout: 8000 });
    assert.equal(posted.length, 1, 'the run from the previous session was delivered');
    await ctx.close();
  });

  test('a rejected payload is dropped rather than retried forever', async () => {
    let calls = 0;
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: authedMe() },
        '/api/runs': () => { calls++; return { status: 400, body: { error: 'bad_game' } }; }
      }
    });
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 2);
    await page.click('#zen-end');
    await page.waitForSelector('#screen-results.active');
    await page.waitForTimeout(700);

    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('mindsharp:runqueue') || '[]').length);
    assert.equal(queued, 0, 'a 400 is a bug in the payload, not a connectivity problem');
    assert.equal(calls, 1, 'and it is not retried');
    await ctx.close();
  });

  test('a duplicate daily submission is not queued', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: {
        '/api/me': { status: 200, body: authedMe() },
        '/api/runs': { status: 409, body: { error: 'daily_already_submitted', runId: 7, score: 300 } }
      }
    });
    await page.click('#daily-card');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 14);
    await page.waitForSelector('#screen-results.active', { timeout: 12000 });
    await page.waitForTimeout(600);
    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('mindsharp:runqueue') || '[]').length);
    assert.equal(queued, 0, 'the server already has today; retrying would never succeed');
    await ctx.close();
  });

  test('the queue is bounded so it cannot fill storage', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      api: { '/api/me': { status: 200, body: authedMe() }, '/api/runs': { status: 503, body: { error: 'down' } } }
    });
    const size = await page.evaluate(async () => {
      const { K, sset } = await import('/js/store.js');
      const runlog = await import('/js/runlog.js');
      const S = window.__mindsharp.S;
      await sset(K.queue, Array.from({ length: 60 }, (_, i) => ({ at: Date.now(), payload: { game: 'zen', n: i } })));
      S.attempts = [];
      await runlog.submitRun({ acc: 100, durationMs: 1000 });
      return runlog.queueSize();
    });
    assert.ok(size <= 40, `queue capped at 40, got ${size}`);
    await ctx.close();
  });
});
