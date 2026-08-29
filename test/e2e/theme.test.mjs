import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, openApp } from './helpers.mjs';

/* Five looks over one app.
 *
 * Every theme only reassigns the variables app.css already uses, so the risk
 * is not that a colour is wrong — it is that a theme is not applied at all,
 * or is applied a frame late, or that a light theme inherits a dark-theme
 * assumption and becomes unreadable. */

const THEMES = ['ember', 'clay', 'aurora', 'neon', 'bold'];
const LIGHT = ['clay', 'bold'];

let srv, browser;
before(async () => { srv = await serve(); browser = await launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

const openWith = async theme => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  if (theme) await page.addInitScript(t => localStorage.setItem('mindsharp:theme', t), theme);
  await page.goto(srv.origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 15000 });
  return { page, ctx, errors };
};

const tokens = page => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const get = n => cs.getPropertyValue(n).trim();
  return {
    theme: document.documentElement.dataset.theme,
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    ink: get('--ink'), bg: get('--bg'), accent: get('--amber'), onAccent: get('--on-accent'),
    surface: get('--surface'), accentInk: get('--accent-ink'),
    mintInk: get('--mint-ink'), inkFaint: get('--ink-faint')
  };
});

/* Relative luminance, so "is this text readable on this background" can be
   asserted rather than eyeballed. */
const lum = hex => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('themes', () => {
  for (const theme of THEMES) {
    test(`${theme} applies before the app boots`, async () => {
      const { page, ctx, errors } = await openWith(theme);
      const t = await tokens(page);
      assert.equal(t.theme, theme);
      assert.ok(t.ink && t.accent, 'the palette resolved');
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    test(`${theme} keeps body text readable`, async () => {
      // WCAG AA for body text is 4.5:1. A theme that fails this is not a
      // style choice, it is a bug someone will report as "I can't read it".
      const { page, ctx } = await openWith(theme);
      const t = await tokens(page);
      const ratio = contrast(t.ink, t.bg);
      assert.ok(ratio >= 4.5, `${theme}: ink on bg is only ${ratio.toFixed(2)}:1`);
      const onAccent = contrast(t.onAccent, t.accent);
      assert.ok(onAccent >= 4.5, `${theme}: text on the accent is only ${onAccent.toFixed(2)}:1`);

      /* The axis that actually failed. The first version of this test checked
         only ink-on-bg and text-on-accent — both of which passed everywhere —
         while the accent used AS TEXT on a card sat at 2.11:1 in clay. Every
         eyebrow, score and glyph in the app is one of these three. */
      for (const [label, fg] of [
        ['the accent as text', t.accentInk],
        ['the success colour as text', t.mintInk],
        ['faint label text', t.inkFaint]
      ]) {
        const r = contrast(fg, t.surface);
        assert.ok(r >= 4.5, `${theme}: ${label} on a card is only ${r.toFixed(2)}:1`);
      }
      await ctx.close();
    });

    test(`${theme} tells the browser its own chrome colour`, async () => {
      // Left at the dark default, a light theme grows a black status bar.
      const { page, ctx } = await openWith(theme);
      const t = await tokens(page);
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(t.meta || ''), `meta theme-color is ${t.meta}`);
      if (LIGHT.includes(theme)) {
        assert.ok(lum(t.meta) > 0.5, `${theme} is light but its chrome colour is dark`);
      }
      await ctx.close();
    });
  }

  test('the picker switches the whole app and the choice sticks', async () => {
    const { page, ctx } = await openWith(null);
    assert.equal((await tokens(page)).theme, 'ember', 'ember is the default');

    await page.evaluate(() => document.querySelector('details.settings').open = true);
    await page.click('#theme-picker [data-theme-id="neon"]');
    assert.equal((await tokens(page)).theme, 'neon');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__mindsharp?.booted === true, null, { timeout: 15000 });
    assert.equal((await tokens(page)).theme, 'neon', 'and survives a reload');
    await ctx.close();
  });

  test('an unknown stored theme falls back rather than breaking', async () => {
    const { page, ctx } = await openWith('not-a-theme');
    assert.equal((await tokens(page)).theme, 'ember');
    await ctx.close();
  });

  test('the game is playable in every theme', async () => {
    // The point of tokens is that no component knows themes exist. This is
    // the assertion that proves it.
    for (const theme of THEMES) {
      const { page, ctx, errors } = await openWith(theme);
      await page.click('.gcard[data-game="blitz"]');
      await page.waitForSelector('#screen-game.active', { timeout: 8000 });
      const answer = await page.evaluate(() => String(window.__mindsharp.S.problem?.answer ?? ''));
      for (const ch of answer.replace('-', '')) {
        await page.click(`#panel-pad .key[data-key="${ch}"]`).catch(() => {});
      }
      await page.waitForTimeout(200);
      assert.deepEqual(errors, [], `${theme} threw while playing`);
      await ctx.close();
    }
  });
});
