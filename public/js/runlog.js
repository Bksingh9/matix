import { S } from './state.js';
import { K, sget, sset } from './store.js';
import { track } from './analytics.js';
import * as api from './api.js';

/* Collects attempts during a run and ships them at the end.
 *
 * A run played on a train has to survive the tunnel. Failed posts go into a
 * durable queue and are retried on the next app open, the next successful
 * post, and whenever the browser says it is back online. */

const MAX_QUEUE = 40;
const MAX_ATTEMPTS_PER_RUN = 500;

/* ---- collection ---------------------------------------------------------- */

/* Called by the engine after every answered problem. Registered as a sink so
   the engine has no dependency on the network layer. */
export function recordAttempt(problem, result) {
  if (!S.attempts) S.attempts = [];
  if (S.attempts.length >= MAX_ATTEMPTS_PER_RUN) return;

  const kind = problem.kind === 'recall' ? 'recall' : problem.kind;
  S.attempts.push({
    kind,
    // Recall has no operation. Sending '+' would inflate the addition bucket
    // and quietly corrupt the weak-spot report.
    op: problem.op ?? null,
    a: numOrNull(problem.a),
    b: numOrNull(problem.b),
    answer: numOrNull(problem.answer),
    given: result.timedOut ? null : numOrNull(result.given),
    isCorrect: !!result.correct,
    timedOut: !!result.timedOut,
    elapsedMs: Math.max(0, Math.round(result.elapsedMs || 0)),
    difficulty: problem.difficulty || currentDifficulty()
  });
}

function currentDifficulty() {
  if (S.isDaily) return 'medium';
  if (S.game === 'drill') return 'mixed';
  return S.difficulty || 'medium';
}

const numOrNull = x => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* ---- submission ---------------------------------------------------------- */

/* Called by the engine at the end of a run. Never throws and never blocks the
   results screen: a failed upload is a queued upload, not a lost run. */
export async function submitRun({ acc, durationMs }) {
  if (!S.authed) return { queued: false, reason: 'anonymous' };

  const payload = {
    game: S.isDaily ? 'daily' : S.game,
    difficulty: currentDifficulty(),
    score: S.score,
    solved: S.solved,
    correct: S.correct,
    wrong: S.wrong,
    bestStreak: S.bestStreak,
    durationMs: Math.max(0, Math.round(durationMs || 0)),
    isDaily: !!S.isDaily,
    dailyDate: S.isDaily ? new Date().toISOString().slice(0, 10) : null,
    drillId: S.drill?.drillId ?? null,
    clientTs: new Date().toISOString(),
    grid: S.isDaily ? (S.meter.dailyGrid || '') : undefined,
    attempts: (S.attempts || []).slice(0, MAX_ATTEMPTS_PER_RUN)
  };

  return send(payload);
}

async function send(payload) {
  try {
    const r = await api.post('/api/runs', payload);
    flush();               // a working connection: drain anything queued
    return { sent: true, runId: r?.runId ?? null };
  } catch (e) {
    // A rejected payload is a bug, not a network problem — queueing it would
    // retry a 400 forever. Only transport and server faults are worth keeping.
    if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
      if (e.code === 'daily_already_submitted') return { sent: false, reason: 'duplicate_daily' };
      console.warn('[runlog] run rejected, not queued:', e.code);
      track('run_rejected', { code: e.code });
      return { sent: false, reason: e.code };
    }
    await enqueue(payload);
    return { sent: false, queued: true };
  }
}

/* ---- durable queue ------------------------------------------------------- */

async function enqueue(payload) {
  const q = (await sget(K.queue)) || [];
  q.push({ at: Date.now(), payload });
  // Drop the oldest first: recent history is what the weakness engine reads,
  // and an unbounded queue eventually fills the storage quota.
  await sset(K.queue, q.slice(-MAX_QUEUE));
  track('run_queued', { size: Math.min(q.length, MAX_QUEUE) });
}

let flushing = false;

/* Drains the queue oldest-first. Stops at the first transport failure so the
   ordering is preserved and we don't hammer a server that is down. */
export async function flush() {
  if (flushing || !S.authed) return { flushed: 0 };
  flushing = true;
  try {
    let q = (await sget(K.queue)) || [];
    if (!q.length) return { flushed: 0 };

    let sent = 0;
    while (q.length) {
      const item = q[0];
      try {
        await api.post('/api/runs', item.payload);
        sent++;
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          // Permanently unacceptable: drop it rather than blocking the queue
          // behind a payload that will never be accepted.
          console.warn('[runlog] dropping unacceptable queued run:', e.code);
        } else {
          break;   // still offline; keep the rest for later
        }
      }
      q = q.slice(1);
      await sset(K.queue, q);
    }
    if (sent) track('run_queue_flushed', { count: sent });
    return { flushed: sent, remaining: q.length };
  } finally {
    flushing = false;
  }
}

export async function queueSize() {
  const q = (await sget(K.queue)) || [];
  return q.length;
}

/* Retry whenever connectivity returns, and once on startup. */
export function initRunLog() {
  window.addEventListener('online', () => { flush(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
}
