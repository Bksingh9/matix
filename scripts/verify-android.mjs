#!/usr/bin/env node
/* Compile the Android app.
 *
 * This exists because the project once shipped a Gradle config that could not
 * build at all: phase 12 added the Play Billing client, which requires
 * compileSdk 35, while the Gradle config from phase 10 pinned 34. Nothing in
 * the test suite noticed, because nothing had ever run `gradlew` — the
 * Capacitor projects were committed and configured, and everyone took that
 * for "it builds".
 *
 * A configuration nobody compiles is a guess. This turns it into a command.
 *
 * Needs an Android SDK. Point ANDROID_HOME at one, or install the
 * command-line tools:
 *   https://developer.android.com/studio#command-line-tools-only
 *
 * Usage:  npm run verify:android            # debug build, the fast check
 *         npm run verify:android -- release # needs android/keystore.properties
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(ROOT, 'android');
const release = process.argv.includes('release');

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk || !existsSync(sdk)) {
  console.error('✗ no Android SDK. Set ANDROID_HOME to one, then re-run.');
  console.error('  Command-line tools: https://developer.android.com/studio#command-line-tools-only');
  console.error('  Then: sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"');
  process.exit(1);
}

/* Gradle finds the SDK through local.properties, which is gitignored because
   the path is per-machine. Write it from the environment rather than making
   every contributor remember. */
const localProps = join(ANDROID, 'local.properties');
const want = `sdk.dir=${sdk}\n`;
if (!existsSync(localProps) || readFileSync(localProps, 'utf8') !== want) {
  writeFileSync(localProps, want);
}

// The web assets have to be current, or the build proves nothing about what
// would actually ship.
console.log('· syncing public/ into the Android project');
const sync = spawnSync('npx', ['cap', 'sync', 'android'], { cwd: ROOT, encoding: 'utf8' });
if (sync.status !== 0) {
  console.error('✗ cap sync failed:\n' + (sync.stdout || '') + (sync.stderr || ''));
  process.exit(1);
}

const task = release ? 'bundleRelease' : 'assembleDebug';
console.log(`· gradlew ${task} (first run downloads Gradle; be patient)`);

const build = spawnSync('./gradlew', ['--no-daemon', task], {
  cwd: ANDROID, encoding: 'utf8',
  env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
});
const out = (build.stdout || '') + (build.stderr || '');

if (build.status !== 0) {
  console.error(`\n✗ the Android app does not build.\n`);
  // Surface the diagnosis, not the whole log — Gradle's useful lines are the
  // ones after "What went wrong".
  const lines = out.split('\n');
  const start = lines.findIndex(l => /What went wrong|FAILURE:/.test(l));
  console.error((start >= 0 ? lines.slice(start, start + 40) : lines.slice(-40)).join('\n'));
  process.exit(1);
}

const artifact = release
  ? 'app/build/outputs/bundle/release/app-release.aab'
  : 'app/build/outputs/apk/debug/app-debug.apk';
const path = join(ANDROID, artifact);
if (!existsSync(path)) {
  // Gradle can report success while producing nothing if the task was skipped.
  console.error(`\n✗ build reported success but ${artifact} is not there`);
  process.exit(1);
}

const { size } = await import('node:fs').then(fs => fs.statSync(path));
console.log(`\n✓ ${artifact} (${(size / 1024 / 1024).toFixed(1)} MB)`);
