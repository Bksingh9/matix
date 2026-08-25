# Deviations from the build spec

Every place the implementation departs from `MINDSHARP_BUILD_SPEC.md`, with the
reason. Nothing here was changed for convenience; each is a case where
following the spec literally would have produced a bug, or where the spec
contradicts itself.

Differences caused by the live Lemon Squeezy API are in `docs/LEMONSQUEEZY.md`
instead.

---

## 1. The weakness score applies the Wilson bound to the miss rate

**Spec §7:**

```
acc_lower = Wilson lower bound (95%) of accuracy
weakness  = 0.65 * (1 - acc_lower) + 0.35 * slowness
```

**Problem.** Take the two buckets §8 names as the unit test: 3/4 and 300/400,
both 75% accurate.

| Bucket | wilsonLower(accuracy) | Spec weakness |
|---|---|---|
| 3/4 | 0.301 | **0.455** |
| 300/400 | 0.705 | 0.192 |

The four-attempt bucket ranks 2.4× weaker than the four-hundred-attempt one at
the identical rate. That is inevitable: a *lower bound on accuracy* is most
pessimistic exactly when the sample is smallest, so scoring `1 - acc_lower`
rewards ignorance. It is precisely the noise-chasing §7 says the Wilson bound
exists to prevent — "the drill engine will chase noise and the report will
contradict itself between sessions" — and it fails the test §8 specifies by
name: *"a 3/4 bucket must not outrank a 300/400 bucket"*.

**What we do.** Apply the same bound to the **miss rate**:

```
miss_lower = wilsonLower(seen - correct, seen)
weakness   = 0.65 * miss_lower + 0.35 * slowness
```

| Bucket | miss_lower | Our weakness |
|---|---|---|
| 3/4 | 0.046 | 0.030 |
| 300/400 | 0.210 | **0.137** |

The well-evidenced weakness wins. The score now answers *"how confident are we
that this bucket is genuinely bad"*, which is the question a drill ranking
needs — a weakness has to be evidenced before it is acted on.

This is the same function, not a second one: the Wilson interval is symmetric
under p → 1−p with the bounds swapped, so `wilsonLower(wrong, n)` is exactly
`1 − wilsonUpper(correct, n)`.

Covered by `test/weakness.test.mjs`, including the case where a genuinely awful
small sample (1/8) still does not outrank a mildly bad large one (60/400).

## 2. `isPro` includes `past_due`

**Spec §5:** `status IN ('active','cancelled') AND (plan = 'lifetime' OR current_period_end > now())`

**Problem.** The same section's event table says `subscription_payment_failed`
→ *"`status='past_due'`. Keep access through the dunning window; let LS
retry."* With `past_due` excluded from `isPro`, writing that status revokes
access the instant a card fails — the opposite of what the row asks for.

**What we do.** `past_due` counts as Pro. Lemon Squeezy retries for days;
cutting access mid-retry loses a customer who was about to pay you anyway.

## 3. `isPro` includes `comp`

**Spec §5:** the formula grants Pro for `plan = 'lifetime'` or a future
`current_period_end`. A comp row has `plan = 'comp'` and a null period end, so
it would never be Pro.

**Problem.** Phase 1's own acceptance criterion is *"Manually set one row to
`plan='comp'` and confirm Pro features unlock across two browsers."*

**What we do.** `comp` counts as Pro, with no period end required.

## 4. `interleave` drains largest-bucket-first

**Spec §7:** *"Shuffle so the same bucket never appears more than twice
consecutively."*

**Problem.** The obvious implementation — shuffle, then greedily pick anything
that differs from the last two — satisfies the letter of the rule early and
then strands the dominant bucket. With 10 division and 10 others it can emit
all ten others first and finish with ten divisions in a row, which is exactly
the blocked practice §7 rules out.

**What we do.** At each step, take from the largest remaining bucket that is
not currently blocked. That keeps enough separators in hand to the last
problem, and it is optimal for this constraint. When only the blocked bucket
remains (a drill from a single bucket), the run is accepted rather than
dropping problems the user is owed.

Asserted over 40 shuffles in `test/weakness.test.mjs`.

## 5. Bands are enforced by construction in the drill generator

**Spec §7** defines banding but not the generator. A first pass used per-band
operand ranges that "felt" right, and produced `23 × 7` for band 3 — which
`bandOf()` then classified as band 2, because banding keys off `max(|a|,|b|)`.

A drill targeting one bucket while logging another silently corrupts the
before/after comparison it exists to produce. The generator now guarantees the
larger operand (the dividend, for division) lands inside the band's range, and
division is built from its quotient so it always divides exactly. Verified
against `bandOf()` for every band and operation.

## 6. `store.js` has a real fallback chain

**Spec §2** describes `store.js` as *"local persistence (`window.storage` /
localStorage / memory)"*, but the original single-file build only ever wrote to
a host-provided `window.storage` and silently persisted nothing without it.

Implemented as specified. Without it, a plain browser deploy would keep no
progress at all — strictly worse than the demo it replaced.

## 7. Recall attempts carry `op = null`

The original counted every Recall answer as addition, inflating that bucket in
the lifetime tallies. Spec §3's `attempts` schema already says `op char(1) --
+ - * / (null for recall)`, so this aligns the client with the schema. It
matters because those tallies feed the weak-spot report.

## 8. `daily` and `drill` runs do not consume the free-run budget

**Spec §6** defines the cap without saying what counts toward it. The daily
challenge is the growth loop and is described in-product as "always free", and
drills are the thing Pro users are paying for. Rationing either would be
self-defeating. `v_runs_today` excludes `is_daily`, `drill` and `import`.

## 9. Extra modules beyond the §2 file list

| File | Why |
|---|---|
| `public/js/util.js` | Pure helpers (`$`, `fmt`, `OPSYM`, `mulberry32`). Putting them in `state.js` would make every module import state to format a number. |
| `public/js/runlog.js` | Attempt collection and the offline queue. §2 has no home for it; folding it into `engine.js` would give the game loop a network dependency. |
| `public/js/account.js` | The account sheet and the cancel path Phase 6 requires. |
| `api/config.js` | The client is unbundled with no build step, so there is nowhere to inject the Supabase URL and anon key at compile time. This hands over the public values at runtime. |
| `api/portal.js` | The Lemon Squeezy customer portal link — the cancel half of Phase 6's acceptance criterion. |
| `lib/http.js`, `lib/buckets.js`, `lib/drillgen.js` | Shared plumbing, view reads, and problem generation, kept out of the route handlers. |

## 10. The dev Pro preview cannot grant Pro

**Spec §6** says to keep the demo button behind `CONFIG.devMode` and strip it
from production. Since Phase 1, no client code *can* grant Pro — the button
would have nothing to do. It now prints the SQL to grant yourself a comp
entitlement instead, which is the only route that works. `devMode` is `false`
and `npm run check:prod` fails a production build that flips it back.

---

## Bugs the tests caught along the way

Recorded because each is a case where the implementation was wrong and only a
test said so.

- `api/runs.js` crashed on a `null` entry in `attempts`: the implausible-timing
  check ran over raw client input before shaping.
- `api/runs.js` silently turned a missing counter into `0`, writing a "0
  solved" run into the history a paying user is shown.
- `migrateLocalProgress()` and `tryLicence()` gated on the auth SDK's session
  object rather than on `S.authed`, so both were unreachable whenever the
  server said the user was authenticated but the SDK had not loaded.
- The drill generator's band mismatch (§5 above).
- `interleave`'s stranding bug (§4 above).
