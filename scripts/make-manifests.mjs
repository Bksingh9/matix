#!/usr/bin/env node
/* Generate one web manifest per theme.
 *
 * A manifest is static, so `theme_color` and `background_color` are fixed at
 * install time — which is why an installed PWA whose owner picked Clay still
 * splashed on Ember's near-black. The meta tag in index.html fixes the browser
 * chrome, but the splash screen of an installed app comes from the manifest
 * and nothing else.
 *
 * So: five manifests differing only in those two fields, and theme.js points
 * <link rel="manifest"> at the right one. Everything else — icons, scope,
 * shortcuts — is copied from the base file, which stays the single source of
 * truth. Editing a variant by hand is pointless; this regenerates it.
 *
 * `--check` verifies the variants match the base instead of writing, so a
 * change to manifest.webmanifest that forgets to regenerate fails CI rather
 * than shipping five stale copies.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'public', 'manifest.webmanifest');

/* Deliberately duplicated from public/js/theme.js rather than imported: that
   module touches `document` at load, and a build script has no DOM. The
   check:events-style guard below keeps the two in step. */
const THEME_COLOR = {
  ember: '#16120c', clay: '#E3DFF4', aurora: '#241852', neon: '#0B0712', bold: '#EFEDE6'
};

const themeJs = readFileSync(join(ROOT, 'public', 'js', 'theme.js'), 'utf8');
for (const [id, hex] of Object.entries(THEME_COLOR)) {
  if (!new RegExp(`${id}:\\s*'${hex}'`, 'i').test(themeJs)) {
    console.error(`✗ ${id} is '${hex}' here but not in public/js/theme.js — the two THEME_COLOR maps have drifted`);
    process.exit(1);
  }
}

const base = JSON.parse(readFileSync(BASE, 'utf8'));
const check = process.argv.includes('--check');
let stale = [];

for (const [id, hex] of Object.entries(THEME_COLOR)) {
  // The default theme is what manifest.webmanifest already describes; a
  // separate ember file would just be a second copy of it to keep in sync.
  if (id === 'ember') continue;
  const out = join(ROOT, 'public', `manifest-${id}.webmanifest`);
  const body = JSON.stringify({ ...base, theme_color: hex, background_color: hex }, null, 2) + '\n';
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== body) stale.push(`manifest-${id}.webmanifest`);
  } else {
    writeFileSync(out, body);
    console.log(`✓ public/manifest-${id}.webmanifest (${hex})`);
  }
}

if (check) {
  if (stale.length) {
    console.error(`✗ stale theme manifests: ${stale.join(', ')}\n  run: node scripts/make-manifests.mjs`);
    process.exit(1);
  }
  console.log('✓ theme manifests are in sync with manifest.webmanifest');
}
