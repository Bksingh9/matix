# Store listing pack

Everything a console asks you to paste. Assets are in `assets/` and
`screenshots/`; regenerate the latter with `npm run store:shots`.

**Nothing here claims the app makes anyone smarter.** That is deliberate, not
timid: Lumosity paid a $2M FTC settlement in 2016 for exactly that class of
claim, and both stores reject health-adjacent wording. "Faster and more
accurate at arithmetic" is provable from the player's own history. Anything
about intelligence, memory improvement or brain health is not — keep it out of
the listing, the screenshots and the app.

---

## Names

| Field | Value | Limit |
|---|---|---|
| App name (Play) | `MindSharp: Brain Training Game` | 30 |
| App name (Apple) | `MindSharp — Brain Training` | 30 |
| Subtitle (Apple) | `Mental maths & memory drills` | 30 |
| Short description (Play) | `Timed mental maths and memory grids. Find what slows you down, then drill it.` | 80 |

Both name fields carry the two phrases people actually search — "brain
training" and "mental maths" — without becoming keyword soup. The subtitle
carries "memory", which the matrix modes are, and which the name does not.

## Long description (Play, 4000 chars)

```
Eight timed modes. One question: what is actually slowing you down?

Most brain games give you a score. MindSharp gives you an answer — your
division is 71%, and your subtraction under 500 is where the seconds go.

TRAIN
· Blitz — sixty seconds, as many as you can
· Survival — three lives, every answer buys less time
· Verify — true or false, fast
· Operator — the numbers are given, find the missing sign
· Matrix — a pattern flashes on the grid, tap it back
· Matrix Rush — sixty seconds of grids
· Matrix Zen — the grid, no clock, nothing to lose
· Zen — no clock, no lives, just repetitions

THE DAILY
Twelve problems. The same twelve for every player, worldwide. One attempt,
then share your grid.

MEASURE
Every answer is recorded — the operation, the numbers, what you typed, how
long you took. The weak-spot report reads that history and tells you which
buckets cost you time. Drill mode then builds a set from your own misses.

KEEP GOING
Streaks that survive a bad day (you earn freezes), XP per problem rather than
per score, weekly leagues that reset on Monday, and 31 achievements.

FIVE THEMES
Ember, Clay, Aurora, Neon and Bold. Switch any time.

PLAYS ANYWHERE
Works offline. No account needed — sign in only if you want your history on
more than one device.

FREE, AND WHAT PRO ADDS
Every mode above is free. Pro adds unlimited runs, Expert difficulty, the
weak-spot report and drills built from it, and removes ads.
```

## Promotional text (Apple, 170 chars — editable without review)

```
Five themes, eight modes, and a weak-spot report that names the arithmetic
costing you time. New: Memory Matrix, in three flavours.
```

## Keywords (Apple, 100 chars, comma-separated, no spaces)

```
mental,maths,math,memory,brain,training,arithmetic,speed,drill,focus,daily,puzzle,matrix,grid
```

Do not repeat words already in the name or subtitle — Apple indexes those
anyway, and the 100 characters are better spent on words that are not.

---

## Play Data safety — the answers

Derived from `public/legal/privacy.html`; if you change one, change both.

| Question | Answer |
|---|---|
| Does your app collect or share user data? | **Yes** |
| Is data encrypted in transit? | **Yes** — HTTPS everywhere |
| Can users request deletion? | **Yes** — in-app, immediate (`/api/account/delete`) |

**Collected — Personal info → Email address.** Collected, not shared.
Required? **No** — the game plays anonymously. Purpose: account management.

**Collected — App activity → In-app actions.** Game results and per-problem
answers. Collected, not shared. Optional. Purpose: app functionality
(the weak-spot report is built from it) and analytics.

**Collected — App info & performance → Crash logs / diagnostics.** Only if you
enable an analytics provider; the default ships none.

Not collected: location, contacts, photos, files, messages, health, financial
info, browsing history, calendar, audio, and any advertising ID. **Say so.**
Over-declaring is as much a review problem as under-declaring.

## Apple App Privacy

Same substance, Apple's shape:

- **Data Used to Track You:** none.
- **Data Linked to You:** Email address (account), User Content (game results
  and answer history), Identifiers (user id), Usage Data.
- **Data Not Linked to You:** Diagnostics, if analytics is enabled.

## Ratings and audience

| | |
|---|---|
| Play content rating | Everyone |
| Apple age rating | 4+ |
| Target audience | 13+ — **not** directed at children |
| Contains ads | Only if you turn them on. Declare honestly. |
| In-app purchases | Yes — Pro subscription and lifetime |

**Do not set the target audience to include under-13.** It puts you under
COPPA and Play's Families policy, which changes what SDKs you may ship and
what data you may collect. The app is not designed for it and the privacy
policy does not cover it.

---

## Review notes to paste into App Review Information

```
MindSharp plays fully anonymously — sign-in is optional and only syncs
history across devices.

Pro features (unlimited runs, Expert difficulty, the weak-spot report and
Drill mode) are entitlement-gated. A demo account with Pro is below so you can
see them without purchasing.

Demo account: <email you set to plan='comp'>
Sign-in is a one-time emailed link; tell us if you would prefer a password
account instead and we will provide one.

Restore Purchases is on the paywall, native builds only.
Account deletion is in Your account → Delete my account, and is immediate.
```

Set that demo account to `plan='comp'` in `entitlements` before submitting.
A reviewer who cannot reach the paid features rejects for "incomplete
functionality" — it is the most common avoidable rejection for a freemium app.

---

## Still to produce

- [ ] **Feature graphic, 1024×500** — Play requires it. `npm run store:feature`.
- [ ] **App preview video** — optional both stores, and the single biggest
      lever on install rate for a game you can *watch*. Your spec §8 makes the
      same point about short-form video.
- [ ] Localised listings, once one language converts.
