/**
 * Durable email outbox.  (BILL-006, reused by BILL-007 and BILL-008)
 *
 * ── WHY AN OUTBOX AND NOT AN INLINE SEND ────────────────────────────────────
 * BILL-006 requires that emails are dispatched from a queue, retried with
 * backoff, dead-lettered with an alert, and that a failed send never fails or
 * rolls back the billing operation.
 *
 * The previous code sent inline from the request path, wrapped in a try/catch
 * that swallowed everything. That satisfies "never fails the billing
 * operation" by making a failed receipt indistinguishable from a sent one:
 * there was no record, no retry, and no way to answer "did this user get their
 * receipt?" — the exact question the ticket names.
 *
 * Postgres rather than Redis + a job library, because the billing state we are
 * reacting to is already in this database. Enqueueing in the same place means
 * a job cannot exist for a transaction that rolled back, and it adds no new
 * production infrastructure to run for a volume this product will not reach for
 * years.
 *
 * ── IDEMPOTENCY IS THE UNIQUE INDEX ─────────────────────────────────────────
 * UNIQUE (template, event_key). `event_key` is the billing event id, so a
 * retried webhook, a duplicated provider event and a manual replay all collide
 * on insert and become no-ops. That is why enqueue() can be called
 * unconditionally from anywhere in the billing path — no caller has to reason
 * about whether it already ran.
 *
 * ── TRANSACTIONAL vs LIFECYCLE ──────────────────────────────────────────────
 * Stored on the row, and the sender branches on it. A billing receipt must NOT
 * be suppressible by a marketing preference; a re-engagement email MUST be.
 * Getting that backwards is a compliance failure in both directions, so the
 * classification travels with the job rather than being inferred later from a
 * template name.
 */
import type { SqlLike } from './payment-methods.js';

export type EmailCategory = 'transactional' | 'lifecycle';

export interface EnqueueInput {
  userId: number | null;
  recipient: string;
  template: string;
  category?: EmailCategory;
  /** The event this email is FOR. With `template`, the idempotency key. */
  eventKey: string;
  /**
   * Everything the template needs, captured NOW from the billing event.
   * The renderer must never reconstruct amounts or dates from live state, or a
   * receipt can drift from what was actually charged.
   */
  payload: Record<string, unknown>;
}

export interface EmailJob {
  id: number;
  user_id: number | null;
  recipient: string;
  template: string;
  category: EmailCategory;
  event_key: string;
  attempts: number;
  payload: Record<string, unknown>;
}

/** Give up after this many attempts and dead-letter with an alert. */
export const MAX_ATTEMPTS = 6;

/**
 * Backoff schedule, in seconds: ~1m, 5m, 25m, 2h, 10h, capped at 24h.
 *
 * Exponential with a cap rather than unbounded: a provider outage lasting a day
 * should still deliver the receipt when it ends, not schedule the retry for
 * next week.
 */
export const backoffSeconds = (attempt: number): number =>
  Math.min(60 * Math.pow(5, Math.max(0, attempt - 1)), 24 * 60 * 60);

/**
 * Queue an email. Idempotent on (template, eventKey).
 *
 * Returns whether this call created the job. Never throws: an outbox write must
 * not be able to fail a billing operation that has already completed.
 */
export async function enqueueEmail(
  sql: SqlLike,
  input: EnqueueInput,
): Promise<{ enqueued: boolean; duplicate: boolean }> {
  const { userId, recipient, template, category = 'transactional', eventKey, payload } = input;

  if (!recipient) {
    console.warn(`[email-outbox] refusing to queue ${template} for user ${userId}: no recipient`);
    return { enqueued: false, duplicate: false };
  }

  try {
    const rows = await sql`
      INSERT INTO email_sends (user_id, recipient, template, category, event_key, payload)
      VALUES (${userId}, ${recipient}, ${template}, ${category}, ${eventKey}, ${JSON.stringify(payload)})
      ON CONFLICT (template, event_key) DO NOTHING
      RETURNING id
    `;
    const enqueued = rows.length > 0;
    if (!enqueued) {
      console.log(`[email-outbox] ${template}/${eventKey} already queued — not sending twice.`);
    }
    return { enqueued, duplicate: !enqueued };
  } catch (err) {
    console.error(`[email-outbox] could not queue ${template} for user ${userId}:`, err);
    return { enqueued: false, duplicate: false };
  }
}

/**
 * Coerce a payload read back from the database into a plain object.
 *
 * WHY THIS EXISTS: a customer received a receipt reading "Welcome to undefined
 * / Charged today undefined". Every value in that payload is produced by a
 * helper that cannot return undefined — formatCents() always returns a string,
 * firstNameOf() falls back to 'there' — so the keys were not missing when the
 * job was queued. They went missing on the way back out of Postgres, where the
 * payload arrived as a JSON *string* rather than an object, and every property
 * access on a string is undefined.
 *
 * The two ways that happens are a `payload` column that is TEXT rather than
 * JSONB (CREATE TABLE IF NOT EXISTS in migration 007 leaves a pre-existing
 * table's column types alone), and a value stored as a jsonb string scalar
 * instead of a jsonb object. Both look identical here, and both are fixed by
 * the same three lines, so this normalises rather than assuming which.
 *
 * Deliberately total: anything that is not an object after parsing becomes {},
 * so a corrupt row renders as a detectably-empty email that the worker's
 * placeholder guard will refuse to send — instead of throwing inside the
 * renderer and being retried six times for a fault no retry can fix.
 */
export function normalizePayload(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Claim due jobs for this worker.
 *
 * FOR UPDATE SKIP LOCKED is what makes several workers (or several instances of
 * one) safe to run at once: each claims a disjoint set instead of fighting over
 * the head of the queue. Without SKIP LOCKED, a second worker blocks on the
 * first's rows and the queue effectively serialises.
 *
 * Marking 'sending' inside the same transaction as the claim means a crashed
 * worker leaves rows visibly stuck rather than silently re-sent.
 */
export async function claimDueEmails(sql: SqlLike, limit = 25): Promise<EmailJob[]> {
  return sql.begin(async (tx: any) => {
    const rows = await tx`
      SELECT id, user_id, recipient, template, category, event_key, attempts, payload
      FROM   email_sends
      WHERE  status IN ('pending', 'failed')
        AND  next_attempt_at <= NOW()
      ORDER  BY next_attempt_at, id
      LIMIT  ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];

    const ids = rows.map((r: any) => r.id);
    await tx`
      UPDATE email_sends
      SET    status = 'sending', attempts = attempts + 1, updated_at = NOW()
      WHERE  id = ANY(${ids})
    `;
    // Normalised HERE rather than in the worker so that every consumer of a
    // claimed job — the worker, the drain CLI, any future replay tool — gets an
    // object, and none of them has to remember to parse.
    return rows.map((r: any) => ({ ...r, payload: normalizePayload(r.payload) })) as EmailJob[];
  });
}

/** Record a successful send. */
export async function markSent(sql: SqlLike, jobId: number, providerMessageId?: string | null): Promise<void> {
  await sql`
    UPDATE email_sends
    SET    status = 'sent', sent_at = NOW(), updated_at = NOW(),
           provider_message_id = ${providerMessageId ?? null}, last_error = NULL
    WHERE  id = ${jobId}
  `;
}

/**
 * Record a failure, scheduling the next attempt or dead-lettering.
 *
 * Dead-lettering logs at error level with the identifying detail, because a
 * receipt that will now never arrive is something a human has to know about —
 * BILL-006 requires the alert.
 */
export async function markFailed(
  sql: SqlLike,
  job: EmailJob,
  error: string,
): Promise<{ deadLettered: boolean }> {
  const deadLettered = job.attempts >= MAX_ATTEMPTS;

  if (deadLettered) {
    await sql`
      UPDATE email_sends
      SET    status = 'dead_letter', last_error = ${error}, updated_at = NOW()
      WHERE  id = ${job.id}
    `;
    console.error(
      `🚨 [email-outbox] DEAD LETTER after ${job.attempts} attempts — ` +
      `template=${job.template} event=${job.event_key} user=${job.user_id} ` +
      `recipient=${job.recipient}. This email will NOT be delivered. Last error: ${error}`,
    );
  } else {
    const delay = backoffSeconds(job.attempts);
    await sql`
      UPDATE email_sends
      SET    status = 'failed', last_error = ${error},
             next_attempt_at = NOW() + (${delay} || ' seconds')::interval,
             updated_at = NOW()
      WHERE  id = ${job.id}
    `;
    console.warn(
      `[email-outbox] send failed (attempt ${job.attempts}/${MAX_ATTEMPTS}) for ` +
      `${job.template}/${job.event_key}; retrying in ${delay}s. ${error}`,
    );
  }
  return { deadLettered };
}

/** Mark a job suppressed — a deliberate non-send, distinct from a failure. */
export async function markSuppressed(sql: SqlLike, jobId: number, reason: string): Promise<void> {
  await sql`
    UPDATE email_sends
    SET    status = 'suppressed', last_error = ${reason}, updated_at = NOW()
    WHERE  id = ${jobId}
  `;
}

export interface SuppressionState {
  email_hard_bounced_at?: Date | string | null;
  marketing_opt_out_at?: Date | string | null;
  is_internal?: boolean | null;
  deleted_at?: Date | string | null;
  status?: string | null;
}

/**
 * Should this job be sent, given the recipient's state?
 *
 * The transactional/lifecycle asymmetry is the whole point, and it runs both
 * ways:
 *
 *   • A hard bounce suppresses EVERYTHING, receipts included. Continuing to
 *     send to a dead address damages deliverability for every other customer,
 *     and the receipt will not arrive regardless.
 *   • A marketing opt-out suppresses ONLY lifecycle mail. Honouring it for a
 *     billing receipt would mean charging someone and refusing to tell them.
 *   • Closed and internal accounts get no lifecycle mail; a closed account may
 *     still legitimately receive a final receipt or refund notice.
 */
export function suppressionReason(
  user: SuppressionState | null | undefined,
  category: EmailCategory,
): string | null {
  if (!user) return null;

  if (user.email_hard_bounced_at) return 'recipient address hard-bounced';

  if (category === 'lifecycle') {
    if (user.marketing_opt_out_at) return 'user unsubscribed from lifecycle email';
    if (user.is_internal) return 'internal/test account';
    if (user.deleted_at) return 'account deleted';
    if (String(user.status || '').toLowerCase() === 'closed') return 'account closed';
  }

  return null;
}
