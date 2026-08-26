# Shipping MindSharp to the App Store and Play Store

The native apps are Capacitor shells around the same `public/` build that
serves the website. There is no second codebase, no framework rewrite, and no
separate feature set — a fix ships to web, PWA and both stores at once.

## The thing to understand first

**Apple and Google require their own in-app purchase for digital goods in
games.** The "reader app" exemption covers magazines, books, music and video;
it does not cover games. So:

| Where | Payment rail | Fee |
|---|---|---|
| Web / installed PWA | Lemon Squeezy | 5% + $0.50 |
| App Store | StoreKit | 15% (Small Business Program) or 30% |
| Play Store | Play Billing | 15% up to $1M/yr, then 30% |

A subscription bought on the web works in the app and vice versa, because
entitlement is server-side and the account is what holds it. But the *purchase*
has to happen on the platform's own rail, and you may not link out to a cheaper
one from inside the app — that is the rule that gets builds rejected.

At $29.99/year: Lemon Squeezy nets you about $27.99, the stores about $25.49.
Worth knowing before you decide how hard to push people toward the web.

See `api/purchases/verify.js` for the receipt-validation side.

## Layout

```
capacitor.config.json     app id, splash, status bar, plugin config
android/                  generated Gradle project — committed, because it
                          carries the manifest, permissions and icons
ios/                      generated Xcode project — same reasoning
assets/                   1024 icon + 2732 splash sources for capacitor-assets
store/assets/             listing icons
public/js/native.js       the bridge: haptics, back button, deep links, storage
```

The native projects are committed rather than regenerated because they hold
real edits: permissions, intent filters, backup rules, orientation lock, the
notification icon and (later) your signing config.

## Daily workflow

```bash
npm run cap:sync          # copy public/ into both platforms
npm run android           # sync + open Android Studio
npm run ios               # sync + open Xcode
```

`cap sync` must be run after any change under `public/`. Nothing watches.

## Regenerating icons and splash screens

```bash
npm run assets:native
```

Order matters and the script encodes it: `capacitor-assets` fans the sources
out into every Android density and iOS slot, but it also rewrites
`public/icons` and `public/manifest.webmanifest` — replacing our PNG entries
with `../icons/icon-48.webp` paths that escape the manifest scope and carry
`type: image/png` on a `.webp` file. Chrome silently refuses the install
prompt on either. So `make-icons.mjs` and `fix-manifest.mjs` run afterwards to
put both back. Do not run `capacitor-assets` on its own.

## Android release

1. **Signing key** — generate once, and back it up somewhere you will still
   have in five years. Losing it means you can never update the listing again.
   ```bash
   keytool -genkey -v -keystore mindsharp-release.keystore \
     -alias mindsharp -keyalg RSA -keysize 2048 -validity 10000
   ```
   Keep it out of the repo. Point `android/keystore.properties` at it (already
   gitignored) and reference it from `android/app/build.gradle`.

2. **Build a bundle** (Play wants AAB, not APK):
   ```bash
   npm run android:bundle
   # android/app/build/outputs/bundle/release/app-release.aab
   ```

3. **App Links** — for `https://mindsharp.app/...` to open the app rather than
   the browser, serve `/.well-known/assetlinks.json` from the site with the
   release signing fingerprint. Without it Android verifies, fails, and quietly
   falls back to the browser. Get the fingerprint from Play Console → Setup →
   App integrity.

4. **Data safety form** — you collect email, and gameplay data tied to an
   account. Declare both. `public/legal/privacy.html` is the source of truth;
   the form has to agree with it.

## iOS release

1. Open `ios/App/App.xcworkspace` in Xcode (the workspace, not the project).
2. Signing & Capabilities: set your team. Add **Push Notifications** and
   **In-App Purchase**.
3. `ITSAppUsesNonExemptEncryption` is already `false` in Info.plist — the app
   only uses HTTPS, which is exempt, and declaring it here avoids the export
   questionnaire on every upload.
4. Archive and upload via Xcode or Transporter.

**Universal Links**: serve `/.well-known/apple-app-site-association` (no file
extension, `Content-Type: application/json`) with your team id and bundle id,
and add the Associated Domains capability with `applinks:mindsharp.app`.

## Review notes, from what actually gets rejected

- **Give the reviewer a working account.** Pro features are entitlement-gated;
  a reviewer who cannot see them will reject for "incomplete functionality".
  Set a demo account to `plan='comp'` and put the credentials in App Review
  Information.
- **Do not mention web pricing in the app.** No "cheaper on our website", no
  link to the Lemon Squeezy checkout. `startCheckout` routes to native billing
  when `isNative()`.
- **Restore Purchases must exist and be reachable** on iOS. It is in the
  account sheet.
- **Sign in must not be mandatory.** It is not — the game plays anonymously,
  which also satisfies Apple's rule about not requiring registration for
  features that do not need it.
- **Account deletion must be in-app** (App Store guideline 5.1.1(v)). The
  account sheet has it.
- **No claims about cognition.** Never say MindSharp makes anyone smarter.
  Faster and more accurate at arithmetic is provable; the rest is not, and
  health-adjacent claims attract both rejection and regulators.
- **Age rating**: 4+ / Everyone. There is no violence, no chat, no UGC.

## Testing on a device without a Mac

Android needs only Android Studio, on any platform. iOS needs a Mac for the
final build — but the whole app is a web view, so almost everything can be
verified in a mobile browser first. `npm run e2e` runs the same checks
headless.

## What is not wired up yet

- Signing configs (yours to create).
- `assetlinks.json` and `apple-app-site-association` (need your fingerprints).
- Firebase for remote push. Local notifications work without it; remote ones
  need `google-services.json` and an APNs key.
