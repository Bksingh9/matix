import { ok, json, methodGuard, readJson, unauthorized, badRequest, serverError, errorRef, clientIp, tooMany } from '../lib/http.js';
import { userFromRequest } from '../lib/auth.js';
import { guard } from '../lib/ratelimit.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { bandOf } from '../lib/weakness.js';
import { resolveEntitlement } from '../lib/entitlement.js';
import { applyRun } from '../lib/progress-store.js';

/* POST /api/runs — persist a finished run and its attempts in one transaction.
 *
 * Attempt rows are the dataset the entire Pro value proposition rests on, so
 * the validation here is about data integrity rather than anti-cheat. Score
 * integrity only starts to matter once there is a public leaderboard; until
 * then, validate the shape and move on. */

const GAMES = new Set(['blitz', 'survival', 'verify', 'operator', 'target', 'recall', 'zen', 'daily', 'drill', 'import']);
const KINDS = new Set(['pad', 'tf', 'ops', 'chips', 'recall']);
const DIFFS = new Set(['easy', 'medium', 'hard', 'expert', 'mixed']);
const MAX_ATTEMPTS = 500;

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  try {
    const user = await userFromRequest(req);
    if (!user) return unauthorized(res);
    if (!(await guard(res, 'runs', user.id, clientIp(req)))) return tooMany(res, 600);

    const body = await readJson(req, 1024 * 1024);
    if (!body || typeof body !== 'object') return badRequest(res, 'bad_body');

    const v = validateRun(body);
    if (v.error) return badRequest(res, v.error, v.detail ? { detail: v.detail } : undefined);

    const attempts = Array.isArray(body.attempts) ? body.attempts : [];
    if (attempts.length > MAX_ATTEMPTS) {
      return badRequest(res, 'too_many_attempts', { max: MAX_ATTEMPTS, got: attempts.length });
    }

    // Shape first: the payload is untrusted, so anything that inspects an
    // attempt must run over normalised rows rather than raw client input.
    // Bands are computed here, never taken from the client — a client bug
    // would otherwise poison the dataset the drill engine reads.
    const rows = attempts.map(a => shapeAttempt(a)).filter(Boolean);

    // Bot/replay signal: log it, don't ban. A human on a good day is fast; a
    // human faster than 120ms on a third of a run is not answering.
    const impossible = rows.filter(a => a.elapsed_ms < 120).length;
    const suspicious = rows.length >= 10 && impossible / rows.length > 0.3;
    if (suspicious) {
      console.warn(`[runs] implausible timing from ${user.id}: ${impossible}/${rows.length} under 120ms`);
    }

    const db = supabaseAdmin();
    const run = v.run;

    // The daily challenge is one attempt per person per day, enforced by a
    // unique index rather than by a read-then-write race.
    if (run.is_daily) {
      const { data: existing } = await db.from('runs')
        .select('id, score')
        .eq('user_id', user.id).eq('daily_date', run.daily_date).eq('is_daily', true)
        .limit(1).maybeSingle();
      if (existing) {
        return json(res, 409, { error: 'daily_already_submitted', runId: existing.id, score: existing.score });
      }
    }

    const { data: runId, error } = await db.rpc('insert_run_with_attempts', {
      p_user_id: user.id,
      p_run: run,
      p_attempts: rows
    });

    if (error) {
      if (error.code === '23505' && run.is_daily) {
        const { data: existing } = await db.from('runs')
          .select('id, score').eq('user_id', user.id).eq('daily_date', run.daily_date).eq('is_daily', true)
          .limit(1).maybeSingle();
        return json(res, 409, { error: 'daily_already_submitted', runId: existing?.id ?? null, score: existing?.score ?? null });
      }
      throw error;
    }

    if (run.is_daily) {
      // Best-effort: a leaderboard row failing must not lose the run itself.
      const { error: dsErr } = await db.from('daily_scores').upsert({
        daily_date: run.daily_date,
        user_id: user.id,
        score: run.score,
        grid: typeof body.grid === 'string' ? body.grid.slice(0, 64) : ''
      }, { onConflict: 'daily_date,user_id' });
      if (dsErr) console.error('[runs] daily_scores upsert failed:', dsErr.message);
    }

    if (run.drill_id) {
      const { error: dErr } = await db.from('drills')
        .update({ completed_at: new Date().toISOString() })
        .eq('id', run.drill_id).eq('user_id', user.id);
      if (dErr) console.error('[runs] drill completion failed:', dErr.message);
    }

    // Progression: XP, level, streak, achievements. The single most important
    // part of the response for retention — it is what the results screen turns
    // into a reason to play again tomorrow.
    //
    // An 'import' backfill is deliberately excluded: awarding a level 20 for
    // migrating local history would hand out every volume achievement at once
    // and make the whole arc meaningless.
    let progress = null;
    if (run.game !== 'import') {
      try {
        const ent = await resolveEntitlement(user.id);
        progress = await applyRun(user.id, run, { attempts: rows, isPro: ent.isPro });
      } catch (e) {
        // A run is worth more than its XP. Persist it either way and log.
        console.error('[runs] progression failed:', e);
      }
    }

    return ok(res, {
      runId, accepted: true, attempts: rows.length,
      ...(progress ? { progress } : {}),
      ...(suspicious ? { flagged: 'timing' } : {})
    });
  } catch (e) {
    const ref = errorRef();
    console.error(`[runs:${ref}]`, e);
    return serverError(res, ref);
  }
}

/* ---- validation ---------------------------------------------------------- */

function validateRun(body) {
  const game = String(body.game || '');
  if (!GAMES.has(game)) return { error: 'bad_game', detail: game };

  const difficulty = String(body.difficulty || 'medium');
  if (!DIFFS.has(difficulty)) return { error: 'bad_difficulty', detail: difficulty };

  // A missing counter is a rejection, not a zero. Silently defaulting would
  // write a run of "0 solved" into the history a paying user is shown, and
  // JSON turns NaN and Infinity into null on the way here, so absent and
  // nonsensical arrive looking identical.
  const num = (x, max) => {
    if (x === null || x === undefined || x === '' || typeof x === 'boolean') return null;
    const n = Math.trunc(Number(x));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };

  const score = num(body.score, 10_000_000);
  const solved = num(body.solved, 100_000);
  const correct = num(body.correct, 100_000);
  const wrong = num(body.wrong, 100_000);
  const bestStreak = num(body.bestStreak, 100_000);
  const durationMs = num(body.durationMs, 24 * 3600 * 1000);

  for (const [k, val] of Object.entries({ score, solved, correct, wrong, bestStreak, durationMs })) {
    if (val === null) return { error: 'bad_number', detail: k };
  }
  if (correct > solved) return { error: 'inconsistent_counts', detail: 'correct > solved' };
  if (bestStreak > solved) return { error: 'inconsistent_counts', detail: 'bestStreak > solved' };

  const isDaily = body.isDaily === true;
  let dailyDate = null;
  if (isDaily) {
    dailyDate = typeof body.dailyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dailyDate)
      ? body.dailyDate
      : new Date().toISOString().slice(0, 10);
  }

  const drillId = body.drillId == null ? null : Math.trunc(Number(body.drillId));
  if (drillId !== null && !Number.isFinite(drillId)) return { error: 'bad_drill_id' };

  return {
    run: {
      game, difficulty, score, solved, correct, wrong,
      best_streak: bestStreak,
      duration_ms: durationMs,
      is_daily: isDaily,
      daily_date: dailyDate,
      drill_id: drillId,
      client_ts: isoOrNull(body.clientTs)
    }
  };
}

function shapeAttempt(a) {
  if (!a || typeof a !== 'object') return null;
  const kind = String(a.kind || '');
  if (!KINDS.has(kind)) return null;

  const op = ['+', '-', '*', '/'].includes(a.op) ? a.op : null;
  const operandA = intOrNull(a.a);
  const operandB = intOrNull(a.b);

  // Attempts with no operation (recall) carry no bucket, so band is a filler
  // value; v_bucket_stats filters them out with `where op is not null`.
  const band = op !== null ? bandOf(op, operandA ?? 0, operandB ?? 0) : 1;

  // Clamp rather than reject: a stopwatch glitch on one problem should not
  // discard a whole run's worth of good data.
  const elapsed = Math.max(0, Math.min(600_000, Math.trunc(Number(a.elapsedMs)) || 0));

  return {
    kind,
    op,
    operand_a: operandA,
    operand_b: operandB,
    answer: intOrNull(a.answer),
    given: a.timedOut === true ? null : intOrNull(a.given),
    is_correct: a.isCorrect === true,
    timed_out: a.timedOut === true,
    elapsed_ms: elapsed,
    difficulty: DIFFS.has(String(a.difficulty)) ? String(a.difficulty) : 'medium',
    band
  };
}

function intOrNull(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Math.trunc(Number(x));
  if (!Number.isFinite(n)) return null;
  // Postgres integer bounds; anything outside is a bug, not a big number.
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

function isoOrNull(s) {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
