import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, launch, blockWebfonts } from './helpers.mjs';

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
  const ctx = await blockWebfonts(await browser.newContext({ viewport: { width: 420, height: 900 } }));
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
    surface: get('--surface'), surface2: get('--surface-2'), surface3: get('--surface-3'),
    accentInk: get('--accent-ink'), mintInk: get('--mint-ink'), inkFaint: get('--ink-faint'),
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
    tiers: {
      bronze: get('--tier-bronze'), silver: get('--tier-silver'),
      gold: get('--tier-gold'), platinum: get('--tier-platinum'), freeze: get('--tier-freeze')
    }
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

    test(`${theme} keeps the achievement metals visible`, async () => {
      /* These were literals — pastel bronze, silver, gold, platinum — chosen
         against a near-black card. On Clay and Bold they landed at about
         1.3:1 and the glyph a player had just earned was invisible. */
      const { page, ctx } = await openWith(theme);
      const t = await tokens(page);
      for (const [name, hex] of Object.entries(t.tiers)) {
        assert.ok(/^#[0-9a-fA-F]{6}$/.test(hex), `${theme}: --tier-${name} is "${hex}"`);
        const r = contrast(hex, t.surface);
        assert.ok(r >= 4.5, `${theme}: the ${name} glyph on a card is only ${r.toFixed(2)}:1`);
      }
      await ctx.close();
    });

    test(`${theme} raises its surfaces in the right order`, async () => {
      /* --surface-2 and -3 are used for things that sit ON a card: tab strips,
         progress tracks, sheets. Neon had -2 darker than -1, so every raised
         element read as a hole. */
      const { page, ctx } = await openWith(theme);
      const t = await tokens(page);
      const [l1, l2, l3] = [t.surface, t.surface2, t.surface3].map(lum);
      const dir = LIGHT.includes(theme) ? -1 : 1;
      assert.ok(dir * (l2 - l1) >= 0, `${theme}: --surface-2 goes the wrong way (${l1.toFixed(3)} -> ${l2.toFixed(3)})`);
      assert.ok(dir * (l3 - l2) >= 0, `${theme}: --surface-3 goes the wrong way (${l2.toFixed(3)} -> ${l3.toFixed(3)})`);
      await ctx.close();
    });

    test(`${theme} points at a manifest that matches it`, async () => {
      /* An installed app splashes on the manifest's background_color, not on
         the meta tag — so a Clay user's app used to flash Ember black on every
         cold start. */
      const { page, ctx } = await openWith(theme);
      const t = await tokens(page);
      const expected = theme === 'ember' ? 'manifest.webmanifest' : `manifest-${theme}.webmanifest`;
      assert.equal(t.manifest, expected);

      const res = await page.request.get(new URL(expected, srv.origin + '/').href);
      assert.equal(res.status(), 200, `${expected} is not served`);
      const man = await res.json();
      assert.equal(man.theme_color.toLowerCase(), t.meta.toLowerCase(),
        `${theme}: the manifest and the meta tag disagree`);
      assert.equal(man.background_color.toLowerCase(), t.meta.toLowerCase());
      assert.equal(man.id, './', 'every variant must keep the same app identity');
      await ctx.close();
    });
  }

  test('the picker switches the whole app and the choice sticks', async () => {
    const { page, ctx } = await openWith(null);
    assert.equal((await tokens(page)).theme, 'ember', 'ember is the default');

    await page.evaluate(() => document.querySelector('details.settings').open = true);
    await page.focus('#theme-picker [data-theme-id="neon"]');
    await page.click('#theme-picker [data-theme-id="neon"]');
    assert.equal((await tokens(page)).theme, 'neon');

    /* The picker used to be re-rendered wholesale on every change, which
       destroyed the very button the keyboard user had just activated and
       dropped focus to <body> mid-interaction. */
    const focused = await page.evaluate(() => document.activeElement?.dataset?.themeId || null);
    assert.equal(focused, 'neon', 'activating a theme threw focus away');
    const pressed = await page.evaluate(() =>
      [...document.querySelectorAll('#theme-picker [data-theme-id]')]
        .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.themeId));
    assert.deepEqual(pressed, ['neon'], 'exactly one card reads as pressed');

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
