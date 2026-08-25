import { S } from './state.js';
import { track } from './analytics.js';
import { $ } from './util.js';
import { fromDrill } from './games.js';
import * as api from './api.js';
import { setDrillSource, startRun } from './engine.js';
import { esc } from './ui.js';
import { openPaywall } from './paywall.js';

/* Drill mode client, plus the Pro weak-spot panel on the results screen.

   Drill problems come from the server pre-generated and are played in order,
   so the pre/post comparison measures the same thing twice. */

let cursor = 0;

export function initDrills() {
  setDrillSource(() => {
    const set = S.drill?.problems || [];
    if (cursor >= set.length) return null;      // null ends the run
    return fromDrill(set[cursor++]);
  });
}

/* ============================================================ START */
export async function startDrill(source) {
  if (!S.pro) {
    openPaywall('**Drill** builds twenty problems from your own misses. It’s the Pro feature — and the reason the report is worth having.', 'drill_locked');
    return;
  }

  const btn = $('#weak-drill-btn');
  if (btn) { btn.textContent = 'Building your drill…'; btn.disabled = true; }

  try {
    const d = await api.get('/api/drills?size=20');
    if (!d || !Array.isArray(d.problems) || !d.problems.length) throw new Error('empty_drill');

    S.drill = { drillId: d.drillId, problems: d.problems, targeted: d.targeted || [], startedAt: Date.now() };
    cursor = 0;
    track('drill_start', { drillId: d.drillId, size: d.problems.length, source: source || 'menu' });
    startRun('drill', false);
  } catch (e) {
    const code = e && e.code;
    if (code === 'insufficient_data') {
      const need = e.body?.attemptsNeeded ?? 40;
      note(`Play about ${Math.max(1, Math.ceil(need / 8))} more rounds and I can build you a drill — right now there are ${e.body?.attemptsSoFar ?? 0} answers on record, and ${need} more would make the targeting honest.`);
    } else if (code === 'all_mastered') {
      note('Every bucket with enough data has graduated. Nothing left to drill — try a harder difficulty and give me something to work with.');
    } else if (code === 'pro_required') {
      openPaywall('**Drill** builds twenty problems from your own misses.', 'drill_403');
    } else if (code === 'auth_required') {
      note('Sign in to build a drill — it reads your answer history, which lives on your account.');
    } else {
      note('Couldn’t build a drill just now. Try again in a moment.');
    }
  } finally {
    if (btn) { btn.textContent = 'Drill these →'; btn.disabled = false; }
  }
}

function note(msg) {
  const body = $('#weak-body');
  if (body) body.innerHTML = '<div class="lk-p">' + esc(msg) + '</div>';
  else alert(msg);
}

/* ============================================================ RESULTS
   Called by the engine after every run. Decorates the results screen: the
   before/after panel for a drill, the weak-spot report otherwise. */
export function onResults() {
  if (S.game === 'drill' && S.drill) { renderDrillComparison(); return; }
  if (S.pro) renderWeakSpots();
}

/* ---- the before/after screen -------------------------------------------
   This is the proof that Pro did something, so it gets room. */
function renderDrillComparison() {
  const box = $('#r-locked');
  if (!box) return;

  const targeted = S.drill.targeted || [];
  const attempts = S.attempts || [];

  // This session's performance on each targeted bucket.
  const now = new Map();
  for (const a of attempts) {
    if (!a.op) continue;
    const problem = S.drill.problems.find(p => p.op === a.op && p.a === a.a && p.b === a.b);
    const band = problem?.band;
    if (band == null) continue;
    const k = `${a.op}:${band}`;
    const cur = now.get(k) || { seen: 0, correct: 0, times: [] };
    cur.seen++;
    if (a.isCorrect) cur.correct++;
    cur.times.push(a.elapsedMs);
    now.set(k, cur);
  }

  const rows = targeted.map(t => {
    const cur = now.get(`${t.op}:${t.band}`);
    if (!cur || !cur.seen) return null;
    const after = cur.correct / cur.seen;
    const before = typeof t.accuracy === 'number' ? t.accuracy : null;
    return {
      label: t.label,
      before, after,
      delta: before === null ? null : after - before,
      seen: cur.seen,
      medianAfter: median(cur.times),
      medianBefore: t.medianMs ?? null
    };
  }).filter(Boolean);

  const improved = rows.filter(r => r.delta !== null && r.delta > 0.02).length;
  const held = rows.filter(r => r.delta !== null && Math.abs(r.delta) <= 0.02).length;

  const headline = rows.length === 0
    ? 'Drill complete.'
    : improved > 0
      ? `You improved on ${improved} of your ${rows.length} weak spot${rows.length === 1 ? '' : 's'}.`
      : held === rows.length
        ? 'You held your ground on every targeted bucket.'
        : 'A harder set than usual — these are your weak spots, after all.';

  box.innerHTML =
    '<div class="lk-h">Before / after <span class="tag">Drill</span></div>'
    + '<div class="drill-headline">' + esc(headline) + '</div>'
    + (rows.length
      ? '<div class="ba-table">'
        + '<div class="ba-head"><span>Bucket</span><span>Before</span><span>After</span><span>Δ</span></div>'
        + rows.map(r => {
          const cls = r.delta === null ? '' : r.delta > 0.02 ? ' up' : r.delta < -0.02 ? ' down' : ' flat';
          const deltaTxt = r.delta === null ? '—' : (r.delta >= 0 ? '+' : '') + Math.round(r.delta * 100) + ' pts';
          return '<div class="ba-row' + cls + '">'
            + '<span class="ba-label">' + esc(r.label) + '</span>'
            + '<span>' + pct(r.before) + '</span>'
            + '<span>' + pct(r.after) + '</span>'
            + '<span class="ba-delta">' + deltaTxt + '</span>'
            + '</div>'
            + '<div class="ba-sub">' + r.seen + ' in this drill'
            + (r.medianBefore ? ' · ' + (r.medianAfter / 1000).toFixed(1) + 's vs ' + (r.medianBefore / 1000).toFixed(1) + 's before' : '')
            + '</div>';
        }).join('')
        + '</div>'
      : '<div class="lk-p">Not enough answers in this drill to compare. Finish the full set and the comparison fills in.</div>')
    + '<div class="lk-p" style="margin-top:10px;">"Before" is your accuracy on these buckets over your last 400 answers, measured before the drill started.</div>'
    + '<button class="lk-cta" id="weak-drill-btn">Drill again →</button>';

  track('drill_end', {
    drillId: S.drill.drillId,
    solved: S.solved,
    correct: S.correct,
    buckets: rows.length,
    improved
  });
}

/* ---- the Pro weak-spot report ------------------------------------------- */
async function renderWeakSpots() {
  const body = $('#weak-body');
  if (!body) return;

  try {
    const r = await api.get('/api/weakspots');

    if (r.sampleTooSmall) {
      body.innerHTML = '<div class="lk-p">Play about '
        + Math.max(1, Math.ceil((r.attemptsNeeded || 40) / 8))
        + ' more rounds and this fills in. There are '
        + (r.overall?.attemptsAnalysed ?? 0)
        + ' answers on record so far — enough for a scoreboard, not enough to tell you something true about your maths.</div>';
      return;
    }

    if (!r.buckets?.length) {
      body.innerHTML = '<div class="lk-p">No bucket has enough attempts to rank yet. Keep playing.</div>';
      return;
    }

    const top = r.buckets.slice(0, 5);
    body.innerHTML =
      '<div class="ws-list">'
      + top.map(b => {
        const acc = Math.round(b.accuracy * 100);
        const slow = b.medianMs > b.targetMs;
        return '<div class="ws-row' + (b.mastered ? ' mastered' : '') + '">'
          + '<span class="ws-label">' + esc(b.label) + (b.mastered ? ' <span class="ws-tag">mastered</span>' : '') + '</span>'
          + '<span class="ws-nums">'
          + '<b class="' + (acc < 80 ? 'bad' : acc < 92 ? 'mid' : 'good') + '">' + acc + '%</b>'
          + '<span class="' + (slow ? 'bad' : '') + '">' + (b.medianMs / 1000).toFixed(1) + 's</span>'
          + (b.trend && b.trend !== 'steady' ? '<span class="ws-trend ' + b.trend + '">' + (b.trend === 'improving' ? '↑' : '↓') + '</span>' : '')
          + '</span></div>'
          + '<div class="ws-bar"><i style="width:' + Math.round(b.weakness * 100) + '%"></i></div>';
      }).join('')
      + '</div>'
      + '<div class="lk-p" style="margin-top:9px;">Your last '
      + (r.overall?.attemptsAnalysed ?? 0) + ' answers. The bar is how much this bucket is costing you — accuracy weighted against how confident the sample makes us, plus how far over pace you are.</div>'
      + '<button class="lk-cta" id="weak-drill-btn">Drill these →</button>';
  } catch (e) {
    if (e.code === 'pro_required') return;   // the free teaser is already rendered
    body.innerHTML = '<div class="lk-p">Couldn’t load your report just now.</div>';
  }
}

/* ============================================================ helpers */
const pct = v => v === null || v === undefined ? '—' : Math.round(v * 100) + '%';

function median(list) {
  if (!list || !list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
