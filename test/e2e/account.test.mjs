import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp, proMe } from './helpers.mjs';

/* Account deletion in the browser.
 *
 * App Store guideline 5.1.1(v) does not just require the endpoint — it
 * requires a reviewer to be able to find and use it. So these tests are about
 * reachability and the two-tap guard, not about what the server does with the
 * request (test/account-delete.test.mjs covers that). */

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const openSheet = async page => {
  await page.evaluate(() => document.querySelector('#pro-badge').click());
  await page.waitForSelector('#acctm.show', { timeout: 4000 });
};

const visible = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return null;
  return el.offsetParent !== null || getComputedStyle(el).display !== 'none';
}, sel);

describe('account deletion', () => {
  test('is reachable from the account sheet when signed in', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin, { pro: true });
    await openSheet(page);
    assert.equal(await visible(page, '#acct-danger'), true, 'a reviewer has to be able to find it');
    assert.equal(await visible(page, '#acct-delete'), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('is hidden for an anonymous player', async () => {
    // There is no account to delete, and their data never left this browser.
    const { page, ctx } = await openApp(browser, srv.origin);
    // Anonymous players have no route to this sheet in the UI, so reach it the
    // way the app does — the same module instance, not a test-only hook.
    await page.evaluate(async () => {
      const m = await import('/js/account.js');
      m.openAccount('test');
    });
    await page.waitForSelector('#acctm.show', { timeout: 4000 });
    assert.equal(await visible(page, '#acct-danger'), false);
    await ctx.close();
  });

  test('one tap arms, it does not delete', async () => {
    const { page, ctx, calls } = await openApp(browser, srv.origin, { pro: true });
    await openSheet(page);
    await page.evaluate(() => document.querySelector('#acct-delete').click());

    assert.equal(await visible(page, '#acct-delete-confirm'), true, 'the confirmation appears');
    assert.equal(await visible(page, '#acct-delete'), false, 'and the first button gets out of the way');
    assert.equal(calls.some(c => c.path === '/api/account/delete'), false, 'nothing was sent');
    await ctx.close();
  });

  test('backing out leaves the account alone', async () => {
    const { page, ctx, calls } = await openApp(browser, srv.origin, { pro: true });
    await openSheet(page);
    await page.evaluate(() => document.querySelector('#acct-delete').click());
    await page.evaluate(() => document.querySelector('#acct-delete-no').click());

    assert.equal(await visible(page, '#acct-delete-confirm'), false);
    assert.equal(await visible(page, '#acct-delete'), true);
    assert.equal(calls.some(c => c.path === '/api/account/delete'), false);
    await ctx.close();
  });

  test('the sheet never opens already armed', async () => {
    // Closing on the confirmation and reopening must not leave a
    // "Yes, delete everything" button under the reviewer's thumb.
    const { page, ctx } = await openApp(browser, srv.origin, { pro: true });
    await openSheet(page);
    await page.evaluate(() => document.querySelector('#acct-delete').click());
    await page.evaluate(() => document.querySelector('#acct-x').click());
    await openSheet(page);

    assert.equal(await visible(page, '#acct-delete-confirm'), false);
    assert.equal(await visible(page, '#acct-delete'), true);
    await ctx.close();
  });

  test('confirming sends the typed confirmation and wipes local state', async () => {
    const { page, ctx, calls } = await openApp(browser, srv.origin, {
      pro: true,
      api: { '/api/account/delete': { status: 200, body: { deleted: true } } }
    });
    await page.evaluate(() => localStorage.setItem('mindsharp:progress', JSON.stringify({ xp: 4000 })));
    await openSheet(page);
    await page.evaluate(() => document.querySelector('#acct-delete').click());
    await page.evaluate(() => document.querySelector('#acct-delete-yes').click());

    // 'commit', not the default 'load': the point here is that the redirect
    // was issued, and the landing page is the next test's job.
    await page.waitForURL(/deleted=1/, { waitUntil: 'commit', timeout: 8000 });

    const sent = calls.find(c => c.path === '/api/account/delete');
    assert.ok(sent, 'the request went out');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.body.confirm, 'DELETE', 'the server insists on this');

    // Leaving a stale streak behind would show the next person a progress bar
    // belonging to an account that no longer exists.
    const stale = await page.evaluate(() => localStorage.getItem('mindsharp:progress'));
    assert.equal(stale, null, 'the local mirror went with it');
    await ctx.close();
  });

  /* Split from the test above on purpose. An in-page location.replace() leaves
     the module graph unexecuted under this Chromium, so nothing after the
     navigation can be asserted there — the reload is verified here instead, by
     loading the URL the app redirects to. Do not merge these back together. */
  test('the reload it lands on says what happened', async () => {
    const { page, ctx, errors } = await openApp(browser, srv.origin);
    await page.goto(srv.origin + '/?deleted=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 8000 });

    // A silent reset looks identical to the app having lost their data, which
    // is the exact anxiety deletion is supposed to resolve.
    await page.waitForFunction(
      () => /Account deleted/.test(document.querySelector('#toasts')?.textContent || ''),
      null, { timeout: 4000 });

    // And the marker is cleaned off the URL, so a refresh does not say it twice.
    assert.equal(await page.evaluate(() => location.search), '');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('a store subscriber is told to cancel in the store first', async () => {
    // We genuinely cannot cancel an App Store subscription. A vague error here
    // ends with a card still being charged.
    const { page, ctx } = await openApp(browser, srv.origin, {
      pro: true,
      api: {
        '/api/me': { status: 200, body: proMe({ entitlement: { ...proMe().entitlement, source: 'appstore' } }) },
        '/api/account/delete': { status: 409, body: { error: 'store_subscription_active', source: 'appstore' } }
      }
    });
    await openSheet(page);
    await page.evaluate(() => document.querySelector('#acct-delete').click());
    await page.evaluate(() => document.querySelector('#acct-delete-yes').click());

    await page.waitForSelector('#acct-msg .notice.err', { timeout: 6000 });
    const msg = await page.textContent('#acct-msg');
    assert.match(msg, /App Store/, 'it has to name the right store');
    assert.match(msg, /can't cancel that for you|cannot cancel/i);

    // And the account is still there, so they can come back.
    assert.equal(await page.evaluate(() => location.search.includes('deleted=1')), false);
    await ctx.close();
  });

  test('the billing note names whoever actually holds the subscription', async () => {
    // Telling a store subscriber that Lemon Squeezy handles their billing
    // sends them somewhere with no authority over it.
    const cases = [
      [null, /Lemon Squeezy/],
      ['appstore', /App Store/],
      ['play', /Google Play/]
    ];
    for (const [source, expected] of cases) {
      const me = proMe();
      const { page, ctx } = await openApp(browser, srv.origin, {
        pro: true,
        api: { '/api/me': { status: 200, body: { ...me, entitlement: { ...me.entitlement, source } } } }
      });
      await openSheet(page);
      const note = await page.textContent('#acct-billing-note');
      assert.match(note, expected, `source=${source}`);
      await ctx.close();
    }
  });

  test('a failed delete re-enables the button rather than stranding them', async () => {
    const { page, ctx } = await openApp(browser, srv.origin, {
      pro: true,
      api: { '/api/account/delete': { status: 500, body: { error: 'server_error' } } }
    });
    await openSheet(page);
    await page.evaluate(() => document.querySelector('#acct-delete').click());
    await page.evaluate(() => document.querySelector('#acct-delete-yes').click());

    await page.waitForSelector('#acct-msg .notice.err', { timeout: 6000 });
    const btn = await page.evaluate(() => {
      const b = document.querySelector('#acct-delete-yes');
      return { disabled: b.disabled, label: b.textContent };
    });
    assert.equal(btn.disabled, false, 'they can try again');
    assert.match(btn.label, /delete everything/i, 'and it is not stuck saying "Deleting…"');
    await ctx.close();
  });
});
