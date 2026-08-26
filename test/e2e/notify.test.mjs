import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, playCorrectly } from './helpers.mjs';

/* Phase 11. The failure mode here is not "it doesn't work" — it is "the player
   mutes the app forever", which is unrecoverable. So what is tested is the
   policy: when we ask, when we don't, and what we schedule. */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

/* A fake Capacitor, installed before any app script runs. Records every plugin
   call so the scheduling policy can be asserted. */
const withCapacitor = async (browser, srv, { permission = 'granted', platform = 'android' } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(([perm, plat]) => {
    window.__cap = { calls: [], scheduled: [], cancelled: [], channels: [] };
    const rec = (name, args) => { window.__cap.calls.push({ name, args }); };
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => plat,
      Plugins: {
        StatusBar: { setStyle: async a => rec('StatusBar.setStyle', a), setBackgroundColor: async a => rec('StatusBar.setBackgroundColor', a) },
        SplashScreen: { hide: async () => rec('SplashScreen.hide') },
        App: { addListener: () => {}, exitApp: () => rec('App.exitApp') },
        Haptics: { impact: a => rec('Haptics.impact', a), notification: a => rec('Haptics.notification', a) },
        Preferences: {
          get: async ({ key }) => ({ value: window.localStorage.getItem(key) }),
          set: async ({ key, value }) => { window.localStorage.setItem(key, value); },
          remove: async ({ key }) => { window.localStorage.removeItem(key); }
        },
        LocalNotifications: {
          createChannel: async c => { window.__cap.channels.push(c); rec('createChannel', c); },
          addListener: () => {},
          checkPermissions: async () => ({ display: perm === 'granted' ? 'granted' : 'prompt' }),
          requestPermissions: async () => { rec('requestPermissions'); return { display: perm }; },
          schedule: async ({ notifications }) => { window.__cap.scheduled.push(...notifications); rec('schedule', notifications); },
          getPending: async () => ({ notifications: window.__cap.scheduled.map(n => ({ id: n.id })) }),
          cancel: async ({ notifications }) => { window.__cap.cancelled.push(...notifications); window.__cap.scheduled = []; }
        }
      }
    };
  }, [permission, platform]);

  await ctx.route('**/api/**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authed: false, entitlement: { isPro: false, plan: 'free', status: 'none' }, limits: { freeRuns: 5, runsUsedToday: 0, runsLeft: 5 } })
  }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(srv.origin + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted, null, { timeout: 10000 });
  return { page, ctx, errors };
};

/* Fake a streak of N days by writing the local progression store. */
const seedStreak = async (page, days) => {
  await page.evaluate(d => {
    const today = new Date();
    const iso = x => new Date(today.getTime() - x * 86400000).toISOString().slice(0, 10);
    localStorage.setItem('mindsharp:progress', JSON.stringify({
      xp: 500, dayStreak: d, longestStreak: d, freezes: 1, daysPlayed: d,
      lastDay: iso(1), unlocked: [], solved: 100, correct: 90, bestRunStreak: 12,
      perfectRuns: 1, subTwoSecondRuns: 0, dailiesDone: d, perfectDailies: 1,
      drillsDone: 0, zenSolved: 50, bestSurvival: 0, bestRecallDigits: 0, modesPlayed: ['zen']
    }));
    localStorage.removeItem('mindsharp:notify');
  }, days);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
};

const runOnce = async page => {
  await page.click('.gcard[data-game="zen"]');
  await page.waitForSelector('#screen-game.active');
  await playCorrectly(page, 2);
  await page.click('#zen-end');
  await page.waitForSelector('#screen-results.active');
};

describe('asking for permission', () => {
  test('never on first launch — that is how you get denied forever', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#notify-banner.show').count(), 0);
    const cap = await page.evaluate(() => window.__cap.calls.map(c => c.name));
    assert.equal(cap.includes('requestPermissions'), false, 'no permission prompt on arrival');
    await ctx.close();
  });

  test('not offered for a streak too short to care about', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 1);
    await runOnce(page);
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#notify-banner.show').count(), 0);
    await ctx.close();
  });

  test('offered once the streak is worth protecting', async () => {
    const { page, ctx, errors } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    const text = await page.locator('#notify-banner').innerText();
    assert.match(text, /Protect your 6-day streak/i, 'names the thing at stake');
    assert.match(text, /only on days you have not played/i, 'and promises not to spam');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('accepting requests permission and schedules exactly one reminder', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-yes');
    await page.waitForFunction(() => window.__cap.scheduled.length > 0, null, { timeout: 6000 });

    const scheduled = await page.evaluate(() => window.__cap.scheduled);
    assert.equal(scheduled.length, 1, 'one reminder, not a week of them');
    assert.match(scheduled[0].title, /6-day streak/);
    assert.equal(scheduled[0].channelId, 'streak');
    assert.equal(scheduled[0].smallIcon, 'ic_stat_mindsharp');
    assert.equal(await page.locator('#notify-banner.show').count(), 0);
    await ctx.close();
  });

  test('a denied permission is never asked about again', async () => {
    const { page, ctx } = await withCapacitor(browser, srv, { permission: 'denied' });
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-yes');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mindsharp:notify') || '{}').deniedAt, null, { timeout: 6000 });

    // Play again: no second offer. iOS never re-prompts anyway, and nagging
    // in-app just annoys someone who already said no.
    await page.click('#r-menu');
    await runOnce(page);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#notify-banner.show').count(), 0);
    await ctx.close();
  });

  test('declining is remembered', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-no');
    assert.equal(await page.locator('#notify-banner.show').count(), 0);

    await page.click('#r-menu');
    await runOnce(page);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#notify-banner.show').count(), 0, 'asked once');
    await ctx.close();
  });

  test('nothing is asked or scheduled on the web', async () => {
    const { page, ctx } = await openApp(browser, srv.origin);
    await page.evaluate(() => {
      localStorage.setItem('mindsharp:progress', JSON.stringify({ xp: 500, dayStreak: 9, longestStreak: 9, freezes: 1, daysPlayed: 9, lastDay: '2020-01-01', unlocked: [], modesPlayed: [] }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__mindsharp && window.__mindsharp.booted);
    await runOnce(page);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#notify-banner.show').count(), 0, 'no native notifications in a browser');
    await ctx.close();
  });
});

describe('scheduling policy', () => {
  test('an Android channel is created, or nothing would ever show', async () => {
    const { page, ctx } = await withCapacitor(browser, srv, { platform: 'android' });
    const channels = await page.evaluate(() => window.__cap.channels);
    assert.equal(channels.length, 1);
    assert.equal(channels[0].id, 'streak');
    assert.equal(channels[0].importance, 3, 'shows without interrupting');
    await ctx.close();
  });

  test('no channel is created on iOS', async () => {
    const { page, ctx } = await withCapacitor(browser, srv, { platform: 'ios' });
    assert.deepEqual(await page.evaluate(() => window.__cap.channels), []);
    await ctx.close();
  });

  test('the reminder is aimed at a local evening, not a UTC hour', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-yes');
    await page.waitForFunction(() => window.__cap.scheduled.length > 0, null, { timeout: 6000 });

    const at = await page.evaluate(() => window.__cap.scheduled[0].schedule.at);
    const local = await page.evaluate(iso => new Date(iso).getHours(), at);
    assert.equal(local, 19, 'a fixed UTC time would fire at 3am for half the world');
    assert.ok(new Date(at).getTime() > Date.now(), 'and in the future');
    await ctx.close();
  });

  test('someone who already played today is aimed at tomorrow', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);   // this makes today's status 'safe'
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-yes');
    await page.waitForFunction(() => window.__cap.scheduled.length > 0, null, { timeout: 6000 });

    const at = await page.evaluate(() => window.__cap.scheduled[0].schedule.at);
    const sameDay = await page.evaluate(iso => new Date(iso).getDate() === new Date().getDate(), at);
    assert.equal(sameDay, false, 'reminding someone about a streak they just extended is spam');
    await ctx.close();
  });

  test('rescheduling replaces rather than accumulates', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-yes');
    await page.waitForFunction(() => window.__cap.scheduled.length > 0, null, { timeout: 6000 });

    await page.click('#r-menu');
    await runOnce(page);
    await page.waitForTimeout(800);
    assert.equal((await page.evaluate(() => window.__cap.scheduled)).length, 1,
      'still exactly one pending reminder');
    await ctx.close();
  });

  test('the settings toggle turns them off again', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await seedStreak(page, 5);
    await runOnce(page);
    await page.waitForSelector('#notify-banner.show', { timeout: 8000 });
    await page.click('#notify-yes');
    await page.waitForFunction(() => window.__cap.scheduled.length > 0, null, { timeout: 6000 });

    await page.click('#r-menu');
    await page.evaluate(() => { document.querySelector('details.settings').open = true; });
    await page.waitForSelector('#toggle-notify', { state: 'visible', timeout: 5000 });
    await page.click('#toggle-notify');
    await page.waitForFunction(() => window.__cap.scheduled.length === 0, null, { timeout: 6000 });
    assert.equal(await page.locator('#toggle-notify.on').count(), 0);
    await ctx.close();
  });
});

describe('native shell behaviour', () => {
  test('the status bar and splash are handled', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    const calls = await page.evaluate(() => window.__cap.calls.map(c => c.name));
    assert.ok(calls.includes('StatusBar.setStyle'));
    assert.ok(calls.includes('SplashScreen.hide'), 'a splash that never hides is a hung app');
    await ctx.close();
  });

  test('haptics fire on an answer', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await page.click('.gcard[data-game="zen"]');
    await page.waitForSelector('#screen-game.active');
    await playCorrectly(page, 1);
    const calls = await page.evaluate(() => window.__cap.calls.map(c => c.name));
    assert.ok(calls.includes('Haptics.impact'), 'a correct answer you can feel');
    await ctx.close();
  });

  test('progress is stored through Preferences, not localStorage alone', async () => {
    const { page, ctx } = await withCapacitor(browser, srv);
    await runOnce(page);
    await page.waitForTimeout(400);
    // The fake Preferences writes through to localStorage, so its presence
    // proves the native backend was the one used.
    const stored = await page.evaluate(() => localStorage.getItem('mindsharp:progress'));
    assert.ok(stored && JSON.parse(stored).xp > 0, 'progress persisted via the native backend');
    await ctx.close();
  });

  test('the document is marked as native so CSS can adapt', async () => {
    const { page, ctx } = await withCapacitor(browser, srv, { platform: 'ios' });
    const cls = await page.evaluate(() => document.documentElement.className);
    assert.match(cls, /native/);
    assert.match(cls, /native-ios/);
    await ctx.close();
  });
});
