/**
 * Migration 007 — email_sends (+ suppression columns)  (BILL-006, BILL-008)
 *
 *   npm run migrate:email-sends      (needs DATABASE_URL)
 *
 * Two things, because they are one mechanism: a durable outbox for
 * transactional and lifecycle email, and the suppression state that decides
 * whether a queued job is allowed to send.
 *
 * WHY A TABLE AND NOT A JOB LIBRARY
 * BILL-006 requires emails to be dispatched from a queue, retried with backoff,
 * and dead-lettered with an alert — and requires that a failing ESP never rolls
 * back the billing operation. That is a durable outbox. The alternative
 * (Redis + BullMQ) means a new dependency and a new piece of production
 * infrastructure to run, for a volume this product will not reach for years.
 * Postgres already holds the billing state we are reacting to, so enqueueing in
 * the same database is both simpler and stronger: the job cannot be enqueued
 * for a billing event that did not commit.
 *
 * IDEMPOTENCY
 * `UNIQUE (template, event_key)` is the whole guarantee. `event_key` is the
 * billing event id (or a synthetic equivalent), so a retried webhook, a
 * duplicated provider event and a manual replay all collide on insert and
 * become no-ops. This is why the enqueue call can be made unconditionally from
 * anywhere in the billing path without anyone having to reason about whether it
 * already ran.
 *
 * TRANSACTIONAL vs LIFECYCLE
 * `category` is not decoration. A billing receipt must NOT be suppressible by a
 * marketing preference, and a re-engagement email MUST be. Getting that
 * backwards is a compliance failure in both directions, so the classification
 * is stored on the row, and the sender branches on it rather than on the
 * template name.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS email_sends (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         INTEGER,
  recipient       TEXT        NOT NULL,
  template        TEXT        NOT NULL,

  -- 'transactional' is never suppressed by marketing preference; 'lifecycle'
  -- always is. See the note above.
  category        TEXT        NOT NULL DEFAULT 'transactional',

  -- The event this email is FOR. Unique with template: the idempotency key.
  event_key       TEXT        NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'pending',
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT,

  -- Everything the template needs, captured AT ENQUEUE TIME from the billing
  -- event. The renderer never reconstructs amounts or dates from live state,
  -- so a receipt cannot drift from what was actually charged.
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Exponential backoff lives here rather than in a scheduler's memory, so a
  -- worker restart does not reset or lose the retry schedule.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  provider_message_id TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT email_sends_event_unique UNIQUE (template, event_key),
  CONSTRAINT email_sends_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter', 'suppressed')),
  CONSTRAINT email_sends_category_check
    CHECK (category IN ('transactional', 'lifecycle'))
);

-- The worker's claim query: due, not yet done, oldest first.
CREATE INDEX IF NOT EXISTS idx_email_sends_due
  ON email_sends (next_attempt_at, id)
  WHERE status IN ('pending', 'failed');

-- "Did this user get their receipt?" — the support question BILL-006 names.
CREATE INDEX IF NOT EXISTS idx_email_sends_user_created
  ON email_sends (user_id, created_at DESC);

-- The alerting query: anything that gave up.
CREATE INDEX IF NOT EXISTS idx_email_sends_dead_letter
  ON email_sends (created_at DESC)
  WHERE status = 'dead_letter';

-- ── Suppression state (BILL-008) ───────────────────────────────────────────
-- There was no preference store at all, so a lifecycle email had nothing to
-- honour. An unsubscribe link that does not work is worse than no link.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS marketing_opt_out_at  TIMESTAMPTZ,
  -- Hard bounces suppress EVERYTHING, transactional included: continuing to
  -- send to a dead address damages sender reputation for every other customer.
  ADD COLUMN IF NOT EXISTS email_hard_bounced_at TIMESTAMPTZ,
  -- Per-user, unguessable, stable. Used in the List-Unsubscribe header and the
  -- footer link, so unsubscribing never requires being logged in.
  ADD COLUMN IF NOT EXISTS unsubscribe_token     TEXT,
  -- Internal/test accounts, excluded from lifecycle sends.
  ADD COLUMN IF NOT EXISTS is_internal           BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unsubscribe_token
  ON users (unsubscribe_token)
  WHERE unsubscribe_token IS NOT NULL;

-- Backfill a token for every existing user so nobody is left without a working
-- unsubscribe link. gen_random_uuid is core Postgres from 13 onward.
UPDATE users
   SET unsubscribe_token = REPLACE(gen_random_uuid()::text, '-', '')
 WHERE unsubscribe_token IS NULL;
`;

export async function up(): Promise<{ queued: number; tokened: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM email_sends)::int                              AS queued,
      (SELECT COUNT(*) FROM users WHERE unsubscribe_token IS NOT NULL)::int AS tokened
  `;
  const r = (rows as any[])[0] ?? {};
  return { queued: Number(r.queued ?? 0), tokened: Number(r.tokened ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('007-email-sends');
if (invokedDirectly) {
  up()
    .then(async ({ queued, tokened }) => {
      console.log(`✅ Migration 007 applied. email_sends holds ${queued} row(s); ${tokened} user(s) have an unsubscribe token.`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 007 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
