#!/usr/bin/env node
/* Restores the web manifest's icon list.
 *
 * `capacitor-assets generate` rewrites public/manifest.webmanifest with
 * entries like { src: "../icons/icon-48.webp", type: "image/png" } — a path
 * that escapes the manifest's own scope, and a MIME type that does not match
 * the file. Chrome refuses the install prompt on either, silently. This runs
 * after it and puts the correct list back. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const FILE = join(ROOT, 'public', 'manifest.webmanifest');

const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-384.png', sizes: '384x384', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
];

const missing = ICONS.filter(i => !existsSync(join(ROOT, 'public', i.src)));
if (missing.length) {
  console.error('✗ missing icons: ' + missing.map(i => i.src).join(', ') + '\n  run: npm run icons');
  process.exit(1);
}

const m = JSON.parse(readFileSync(FILE, 'utf8'));
m.icons = ICONS;
writeFileSync(FILE, JSON.stringify(m, null, 2) + '\n');
console.log('✓ manifest icons restored (' + ICONS.length + ' entries)');
