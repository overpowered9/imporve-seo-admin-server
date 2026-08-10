/**
 * Migration 006 — users.default_payment_method_*  (BILL-001)
 *
 *   npm run migrate:payment-default      (needs DATABASE_URL)
 *
 * Gives us a local record of which card is the default.
 *
 * WHY, WHEN STRIPE ALREADY KNOWS
 * BILL-001's acceptance criterion is "set as default in both our DB and the
 * payment provider, in one transaction". Before this migration there was no
 * "our DB" side at all — the default lived exclusively in
 * `customer.invoice_settings.default_payment_method`. That had two consequences
 * the ticket is really about:
 *
 *   1. Every screen that wants to say "we'll charge your Visa ••4242" had to
 *      make a Stripe round trip, so a slow or unreachable Stripe turned into a
 *      blocked upgrade rather than a degraded one.
 *   2. There was nothing to reconcile. "Our DB says X, Stripe says Y" is a bug
 *      you can detect and repair; "Stripe says Y" alone is just a fact you have
 *      to trust.
 *
 * WHAT IS AND IS NOT STORED
 * The payment method ID, brand and last four. Nothing else, ever. A PAN, CVV or
 * expiry-plus-PAN combination must never reach this database; last four and
 * brand are explicitly outside PCI's cardholder-data scope and are what every
 * receipt and confirmation screen needs.
 *
 * Stripe remains the SOURCE OF TRUTH. These columns are a cache with a
 * reconciler (see ensureDefaultPaymentMethod), not a second authority — if the
 * two disagree, Stripe wins and the row is corrected.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_payment_method_id     TEXT,
  ADD COLUMN IF NOT EXISTS default_payment_method_brand  TEXT,
  -- Last four digits only. CHAR(4) rather than TEXT so an accidental attempt to
  -- write a full card number fails loudly at the database instead of silently
  -- persisting cardholder data.
  ADD COLUMN IF NOT EXISTS default_payment_method_last4  CHAR(4),
  ADD COLUMN IF NOT EXISTS default_payment_method_exp_month SMALLINT,
  ADD COLUMN IF NOT EXISTS default_payment_method_exp_year  SMALLINT,
  ADD COLUMN IF NOT EXISTS default_payment_method_set_at TIMESTAMPTZ;

DO $$
BEGIN
  -- Belt and braces on the CHAR(4): four digits, nothing else.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_default_pm_last4_format'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_default_pm_last4_format
      CHECK (default_payment_method_last4 IS NULL
             OR default_payment_method_last4 ~ '^[0-9]{4}$');
  END IF;

  -- A brand or last four without an id is orphaned display data.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_default_pm_consistent'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_default_pm_consistent
      CHECK (default_payment_method_id IS NOT NULL
             OR (default_payment_method_brand IS NULL
                 AND default_payment_method_last4 IS NULL));
  END IF;
END $$;

-- Finds the accounts the BILL-001 backfill has to repair: a Stripe customer
-- exists but we hold no default.
CREATE INDEX IF NOT EXISTS idx_users_missing_default_pm
  ON users (id)
  WHERE stripe_customer_id IS NOT NULL AND default_payment_method_id IS NULL;
`;

export async function up(): Promise<{ withCustomer: number; withDefault: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL)::int          AS with_customer,
      COUNT(*) FILTER (WHERE default_payment_method_id IS NOT NULL)::int   AS with_default
    FROM users
  `;
  const r = (rows as any[])[0] ?? {};
  return { withCustomer: Number(r.with_customer ?? 0), withDefault: Number(r.with_default ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('006-default-payment-method');
if (invokedDirectly) {
  up()
    .then(async ({ withCustomer, withDefault }) => {
      console.log(
        `✅ Migration 006 applied. ${withCustomer} user(s) have a Stripe customer, ` +
        `${withDefault} already have a local default. Run \`npm run backfill:payment-defaults\` next.`,
      );
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 006 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
