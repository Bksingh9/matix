import { readRaw, json, methodGuard } from '../../lib/http.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import {
  verifySignature, eventId, entitlementPatch, identityHints, KNOWN_EVENTS
} from '../../lib/lemonsqueezy.js';

/* POST /api/webhooks/lemonsqueezy
 *
 * The most important endpoint in the system. Get it wrong and either people
 * pay and get nothing, or they cancel and keep everything.
 *
 * Body parsing is disabled: the HMAC is computed over the raw bytes, and a
 * body that has been parsed and re-stringified will not match. This is the
 * single most common cause of "payments silently don't work".
 */
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  // ---- 1. raw bytes -------------------------------------------------------
  let raw;
  try {
    raw = await readRaw(req, 1024 * 1024);
  } catch (e) {
    console.error('[ls-webhook] unreadable body:', e.message);
    return json(res, 400, { error: 'bad_body' });
  }

  // ---- 2. signature -------------------------------------------------------
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[ls-webhook] LEMONSQUEEZY_WEBHOOK_SECRET is not set — refusing every delivery');
    return json(res, 500, { error: 'not_configured' });
  }
  const sig = req.headers['x-signature'] || req.headers['X-Signature'];
  if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, secret)) {
    // Log and do nothing else. An unsigned request tells us nothing we can
    // trust, including who sent it.
    console.warn('[ls-webhook] signature mismatch, rejecting');
    return json(res, 401, { error: 'bad_signature' });
  }

  // ---- 3. parse (only now that the bytes are trusted) ----------------------
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'bad_json' });
  }

  // Read the event name from the SIGNED body, never from the X-Event-Name
  // header: only the body is covered by the HMAC.
  const eventName = payload?.meta?.event_name || null;
  if (!eventName) return json(res, 400, { error: 'no_event_name' });

  const id = eventId(raw, eventName);
  const db = supabaseAdmin();

  // ---- 4. idempotency -----------------------------------------------------
  // Insert first. A duplicate key means this is a replay, which is not an
  // error — Lemon Squeezy retries, and it must stop retrying.
  const { error: insErr } = await db.from('webhook_events').insert({
    id, event_name: eventName, payload
  });
  if (insErr) {
    if (insErr.code === '23505') {
      return json(res, 200, { ok: true, duplicate: true });
    }
    console.error('[ls-webhook] could not record event:', insErr.message);
    // Fall through and still process: losing a paid event is worse than
    // processing it twice, and every write below is idempotent.
  }

  // ---- 5. process ---------------------------------------------------------
  try {
    const result = await processEvent(db, eventName, payload, id);
    // Always 200 once persisted, even on a soft failure, to stop retry storms.
    // Anything unresolved is flagged in webhook_events for the admin list.
    return json(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error(`[ls-webhook] handling ${eventName} (${id}) failed:`, e);
    await flagUnresolved(db, id, `handler_error: ${e.message}`);
    return json(res, 200, { ok: true, deferred: true });
  }
}

async function processEvent(db, eventName, payload, id) {
  if (!KNOWN_EVENTS.has(eventName)) {
    // Not an error: Lemon Squeezy adds events, and a store may have more
    // enabled than we act on.
    return { ignored: 'unknown_event', event: eventName };
  }

  const hints = identityHints(payload);

  // A test-mode purchase must never grant production Pro. In a test
  // deployment the reverse also holds.
  const prodDeploy = process.env.VERCEL_ENV === 'production';
  if (hints.testMode && prodDeploy) {
    return { ignored: 'test_mode_event_on_production' };
  }

  const patch = entitlementPatch(eventName, payload);
  if (!patch) return { ignored: 'no_entitlement_change', event: eventName };

  if (patch._warning) {
    console.warn(`[ls-webhook] ${eventName} (${id}): ${patch._warning}`);
    delete patch._warning;
  }

  const userId = await resolveUser(db, hints, payload);
  if (!userId) {
    // Never drop a paid event silently — that is a person who gave you money
    // and got nothing. Flag it for the admin list instead.
    await flagUnresolved(db, id,
      `unattributed: user_id=${hints.userId || '-'} customer=${hints.customerId || '-'} email=${hints.email || '-'}`);
    console.error(`[ls-webhook] ${eventName} could not be attributed to a user`, hints);
    return { unresolved: true };
  }

  const { error } = await db.from('entitlements').upsert(
    { user_id: userId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) throw error;

  console.log(`[ls-webhook] ${eventName} → user ${userId}: plan=${patch.plan ?? '(unchanged)'} status=${patch.status ?? '(unchanged)'}`);
  return { applied: true, event: eventName };
}

/* Attribution, most reliable first:
   1. custom_data.user_id — attached by /api/checkout, so it is there whenever
      the purchase started from our own checkout flow.
   2. an existing entitlement row for this Lemon Squeezy customer.
   3. the purchase email against profiles.email.
   Anything else is flagged rather than dropped. */
async function resolveUser(db, hints, payload) {
  if (hints.userId && isUuid(hints.userId)) {
    const { data } = await db.from('profiles').select('id').eq('id', hints.userId).maybeSingle();
    if (data) return data.id;
    // The id looks right but has no profile — a deleted account, or a checkout
    // created against a different environment. Keep looking.
  }

  if (hints.customerId) {
    const { data } = await db.from('entitlements')
      .select('user_id').eq('ls_customer_id', hints.customerId).limit(1).maybeSingle();
    if (data) return data.user_id;
  }

  // A subscription event carries its own id; if we have seen it before, the
  // row already knows who it belongs to.
  const subId = payload?.data?.id != null ? String(payload.data.id) : null;
  if (subId) {
    const { data } = await db.from('entitlements')
      .select('user_id').eq('ls_subscription_id', subId).limit(1).maybeSingle();
    if (data) return data.user_id;
  }

  if (hints.email) {
    const { data } = await db.from('profiles')
      .select('id').eq('email', hints.email.toLowerCase()).limit(1).maybeSingle();
    if (data) return data.id;
  }

  return null;
}

async function flagUnresolved(db, id, note) {
  try {
    await db.from('webhook_events').update({ unresolved: true, resolve_note: note }).eq('id', id);
  } catch (e) {
    console.error('[ls-webhook] could not flag unresolved event:', e.message);
  }
}

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
