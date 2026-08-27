# Launch playbook

`MONETISATION_PLAN.md` decides *what* to sell and in what order. This is the
part that comes after: where to put the thing, how to get the first people to
it, and the revenue lines the plan does not cover.

Read §6 and §7 of the plan first — the ninety-day shape hasn't changed. What
has changed is that there is now a build you can send someone.

---

## 0. Before you post the link anywhere

Two of these are legal exposure, not polish. Do them first.

- [ ] **Replace `support@mindsharp.app`** in `public/legal/*.html` with an
      address you actually read. It appears in the refund policy, which is a
      commitment you are publishing.
- [ ] **Decide the name.** "MindSharp" is unregistered as far as this repo
      knows. Search the trademark register in your jurisdiction and on the app
      stores before you build any audience on it. Renaming after a Play listing
      exists is far more expensive than renaming now.
- [ ] Set `CONFIG.analytics.plausible.domain` (`public/js/config.js`). Launching
      without analytics means the launch teaches you nothing.
- [ ] Play it on a real phone. The e2e suite runs at 420×900, which is not the
      same as a thumb on glass.

---

## 1. Distribution, in the order the effort pays back

### Now — costs nothing, no accounts

| Where | What they want | Notes |
|---|---|---|
| **GitHub Pages** | already wired | `.github/workflows/pages.yml`. Free, instant, good enough to share. |
| **itch.io** | HTML5 zip, ~5 min | Upload `dist/`. No review queue. Pay-what-you-want is possible. |
| **Netlify / Cloudflare Pages** | a repo | Free tier, custom domain, better URL than a project site |

Run `node scripts/build-static.mjs --base=` for anything served at a domain
root; the `--base` flag exists only for project sites under a subpath.

### Week 2–4 — real traffic, some review friction

| Portal | Revenue model | Reality |
|---|---|---|
| **CrazyGames** | rev-share + licence | Biggest HTML5 audience. Has a developer portal and a review queue. |
| **Poki** | rev-share | Curated, slower, high quality bar. Worth the wait. |
| **GameDistribution** | rev-share across a network | Easiest acceptance, lowest per-play value |
| **Y8 / GameMonetize** | licence + rev-share | Long tail, low effort |

Pitch, one paragraph: *finished, mobile-ready, no dependencies, no login wall,
loads in under a second.* Portals reject on load time and forced signup more
than on gameplay.

**Read every contract for exclusivity.** A non-exclusive licence leaves you
free to keep selling Pro on your own domain; an exclusive one may not, and the
subscription is the compounding line. Do not trade it for $500.

### When retention justifies it — the stores

Covered in `docs/MOBILE.md`. The Android build is proven to compile; iOS needs
a Mac. Both take 15–30% and a review cycle, which is why the plan puts them
last.

---

## 2. Getting the first users

§6 of the plan lists the channels. Three things it doesn't say:

**Post to one place at a time.** A Show HN that lands quietly can be retried in
a month; a Show HN, a Product Hunt and four subreddits on the same Tuesday
cannot. You also learn nothing about which channel worked.

**The share grid is the only compounding channel you own.** Wordle's growth was
one paste-able spoiler-free result. Yours exists. Before any launch post, check
the shared text carries the URL, and that the URL is one you'll still control
in a year — which is an argument for a domain over a `github.io` subpath.

**Answer every comment for the first 48 hours.** On HN and Reddit, a founder
replying is the difference between a post that dies at 3 upvotes and one that
doesn't. Block the time or don't post.

### Copy that works, and copy that doesn't

The pitch is *measurement*, not "fun maths game" — there are ten thousand of
those and you will lose to all of them on novelty. What almost nobody offers:

> It tells you your division is 71% and your subtraction under 500 is where
> the seconds go.

Never claim it makes anyone smarter. "Faster and more accurate at arithmetic"
is provable from the user's own history. Cognitive-improvement claims attract
app-store rejection and, in some jurisdictions, regulators — Lumosity paid a
$2M FTC settlement in 2016 for exactly that class of claim.

---

## 3. Revenue lines the plan doesn't cover

The plan has four: portals, Pro, education/B2B, ads. These are additional, in
rough order of effort-to-money.

### Competitive-exam prep — the largest adjacent market

Quantitative aptitude sections are speed tests wearing a maths costume. In
India alone that is IBPS and SBI banking exams, SSC CGL, RRB, CAT — an
enormous, motivated, already-paying audience whose actual bottleneck is
*arithmetic speed under time pressure*, which is precisely what this measures.

The product barely changes: exam-shaped presets (question mix, time limits),
and a report framed as "you'd lose 4 minutes on a 35-question quant section."

Why it's the best line here: those buyers already spend on prep, the price
tolerance is far above $30/year, and the weak-spot report is a genuinely better
answer than the mock-test PDFs they buy today. It also plays to what you know.
Coaching institutes are a B2B sale, not a consumer one — closer to the $299
school tier than to Pro.

### Sponsored daily challenge

The daily is a fixed, dated, shareable unit — the same shape a sponsor buys in
a newsletter. A coaching institute or edtech brand sponsoring "today's twelve
problems" is a clean sell once the daily has consistent players. Needs volume
first; a sponsor buys an audience, not a placement.

### Embeddable widget / API licence

Edtech sites, tutoring platforms and school portals want a drop-in practice
widget and will not build one. The engine is already isolated from the network
layer (`engine.js` reports through sinks and imports nothing), so an
`<iframe>`-able build is a small change, not a rewrite. Price per site per
year. This is the highest-margin line in the document: the same code, resold.

### Referral on the Pro tier

Lemon Squeezy has affiliate support built in. Tutors who already recommend it
to students should earn something for doing so. Costs you nothing until it
works, and turns line 3's tutors into a sales channel for line 2.

### Generated practice worksheets

The weak-spot report already knows what someone gets wrong. A printable PDF
worksheet built from it sells to parents and tutors on Gumroad without
touching the subscription. Low ceiling, near-zero marginal cost, and it reaches
people who will never subscribe to anything.

### What to be careful with

- **Paid tournaments.** Entry fees plus prizes is gambling law in many
  jurisdictions, India included, and the skill-vs-chance line is not one to
  guess at. Free tournaments with sponsored prizes avoid the question entirely.
- **Selling data.** Your privacy policy says processors act on your
  instructions and don't use the data for their own purposes. Aggregate
  benchmarks published as *content* are fine and make good PR; selling the
  underlying data would contradict a document you published.
- **Ads before ~1,000 DAU.** Already argued in the plan §1 and §4. Turning them
  on early earns pennies and costs the ad-free positioning that justifies $30.

---

## 4. The first week, concretely

| Day | Do |
|---|---|
| 1 | Enable Pages. Fix the support email. Set the Plausible domain. Play it on a phone. |
| 2 | Buy the domain. Point Pages or Cloudflare at it. |
| 3 | Upload to itch.io. Send the link to ten people you know and watch them play without helping. |
| 4 | Fix whatever those ten people tripped on. It is always something you stopped seeing. |
| 5 | Supabase project + Vercel deploy, so accounts and the weak-spot report work. Run `npm run verify:rls`. |
| 6 | Submit to CrazyGames and GameDistribution. |
| 7 | Post one place. Answer everything. |

Lemon Squeezy comes after there are people to sell to. Payment infrastructure
built before an audience is the most common way a project like this stalls —
and the plan's §5 makes the same point.
