/**
 * Migration 004 — billing_transactions  (BILL-004)
 *
 *   npm run migrate:billing-transactions      (needs DATABASE_URL)
 *
 * The canonical record of every billable event.
 *
 * WHY A TABLE, WHEN WE COULD KEEP DERIVING IT
 * "Recent Transactions" was previously assembled at read time by merging live
 * Stripe invoices with `credit_transactions`. That reads fine until you ask the
 * questions a billing history has to answer:
 *
 *   • What did we charge this user on 3 May? — needs Stripe to be reachable.
 *   • Did this webhook already produce a row? — unanswerable; there is no row.
 *   • Why does the total differ from the dashboard? — no stored figure to compare.
 *
 * Deriving also means a credit purchase and its invoice are two unrelated
 * objects that happen to sort next to each other, rather than one event.
 *
 * IDEMPOTENCY IS THE POINT OF `provider_event_id`
 * Stripe retries webhooks. The unique index below is what makes a retry a
 * no-op instead of a duplicate row, and it is why the writer can be called from
 * BOTH the synchronous request path and the webhook without coordination:
 * whichever arrives first inserts, the second conflicts and updates in place.
 *
 * MONEY
 * `amount_cents` is an integer in the smallest currency unit, always paired
 * with an explicit `currency`. No floats, and no bare amounts whose currency
 * has to be inferred — the CHECK constraint enforces that pairing.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS billing_transactions (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER     NOT NULL,

  -- What happened. Deliberately a TEXT + CHECK rather than a Postgres enum:
  -- adding a value to an enum needs its own migration and locks, and this list
  -- will grow. To extend, add to the CHECK below in a new migration.
  type               TEXT        NOT NULL,
  -- Human-readable, shown verbatim in the CMS. Written once, never recomputed,
  -- so historical rows keep the wording the user actually saw.
  description        TEXT        NOT NULL,

  -- Money in MINOR UNITS (integer cents). NULL for credit-only events such as a
  -- plan grant, which move credits without moving money.
  amount_cents       BIGINT,
  currency           CHAR(3),
  status             TEXT        NOT NULL DEFAULT 'succeeded',

  -- Provider linkage.
  provider           TEXT        NOT NULL DEFAULT 'stripe',
  -- The id we deduplicate on: a Stripe event id, or a synthetic key for events
  -- we originate ourselves (e.g. 'session:cs_123'). Unique when present.
  provider_event_id  TEXT,
  -- The underlying object: invoice, charge or checkout session id. Not unique —
  -- one invoice can legitimately produce a charge row and a proration row.
  provider_object_id TEXT,
  receipt_url        TEXT,

  -- What it relates to.
  plan_id            INTEGER,
  credit_type        TEXT,
  credit_delta       INTEGER,

  metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT billing_transactions_status_check
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),

  CONSTRAINT billing_transactions_type_check
    CHECK (type IN (
      'credit_purchase',
      'subscription_create',
      'plan_upgrade',
      'plan_downgrade',
      'proration_charge',
      'proration_credit',
      'renewal',
      'refund',
      'payment_failed',
      'credit_expiry',
      'plan_grant'
    )),

  -- An amount is meaningless without a currency, and a currency without an
  -- amount is noise. Enforce the pair.
  CONSTRAINT billing_transactions_money_check
    CHECK ((amount_cents IS NULL AND currency IS NULL)
        OR (amount_cents IS NOT NULL AND currency IS NOT NULL)),

  CONSTRAINT billing_transactions_credit_check
    CHECK ((credit_type IS NULL AND credit_delta IS NULL)
        OR (credit_type IS NOT NULL AND credit_delta IS NOT NULL))
);

-- THE idempotency guarantee. Partial, because rows we originate before a
-- provider id exists legitimately have none, and a plain UNIQUE would collapse
-- all of those into one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_transactions_provider_event
  ON billing_transactions (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- The read path: one user's history, newest first, paginated.
CREATE INDEX IF NOT EXISTS idx_billing_transactions_user_occurred
  ON billing_transactions (user_id, occurred_at DESC, id DESC);

-- Reconciliation: "find the row for this invoice".
CREATE INDEX IF NOT EXISTS idx_billing_transactions_object
  ON billing_transactions (provider_object_id)
  WHERE provider_object_id IS NOT NULL;
`;

export async function up(): Promise<{ existing: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`SELECT COUNT(*)::int AS n FROM billing_transactions`;
  return { existing: Number((rows as any[])[0]?.n ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('004-billing-transactions');
if (invokedDirectly) {
  up()
    .then(async ({ existing }) => {
      console.log(`✅ Migration 004 applied. billing_transactions holds ${existing} row(s).`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 004 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
