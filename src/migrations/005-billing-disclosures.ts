/**
 * Migration 005 — billing_disclosures  (BILL-003)
 *
 *   npm run migrate:billing-disclosures      (needs DATABASE_URL)
 *
 * A record of exactly what a customer was shown before they agreed to be
 * charged, and what they were then actually charged.
 *
 * WHY THIS EXISTS
 * BILL-003 is a consent problem, not a maths problem: the amount was correct,
 * it was simply revealed after the click. Fixing the UI fixes today's charge.
 * It does not let anyone answer, three months later, "what were they told?" —
 * and in a billing dispute that is the only question that matters.
 *
 * So a disclosure row is written when the quote is generated, and closed out
 * when the change is committed. `total_due_cents` versus `charged_cents` on one
 * row is the evidence, and the gap between them is the alarm: BILL-003 requires
 * any difference beyond rounding to be logged at error level, and this is where
 * that comparison gets its two numbers.
 *
 * `disclosure_id` is a UUID handed to the client with the quote and replayed on
 * confirm. It is deliberately NOT the primary key — the client should never see
 * a sequential id, which leaks volume and invites enumeration.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS billing_disclosures (
  id                   BIGSERIAL PRIMARY KEY,
  -- Opaque handle given to the client and replayed on confirm.
  disclosure_id        UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id              INTEGER     NOT NULL,

  from_plan_id         INTEGER,
  to_plan_id           INTEGER     NOT NULL,

  -- ── What the user was shown ──────────────────────────────────────────────
  total_due_cents      BIGINT      NOT NULL,
  currency             CHAR(3)     NOT NULL,
  -- The recurring charge that follows, and when. Both nullable: a downgrade
  -- that only takes effect later has no "then" figure to promise yet.
  next_amount_cents    BIGINT,
  next_billing_date    TIMESTAMPTZ,
  -- Brand and last four ONLY. Never a PAN, never a token that can be replayed.
  payment_method_brand TEXT,
  payment_method_last4 CHAR(4),
  -- The itemised lines, exactly as rendered: [{description, amount_cents}, …].
  line_items           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Unix seconds the quote was priced against, replayed to Stripe on commit so
  -- the quote is binding rather than indicative.
  proration_date       BIGINT,

  -- ── What actually happened ───────────────────────────────────────────────
  confirmed_at         TIMESTAMPTZ,
  charged_cents        BIGINT,
  -- Set when the resulting money movement lands in billing_transactions.
  transaction_id       BIGINT,
  -- True when charged_cents diverged from total_due_cents beyond rounding.
  -- Persisted as well as logged, so "how often does this happen?" is a query
  -- rather than a log search.
  mismatch             BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT billing_disclosures_disclosure_id_unique UNIQUE (disclosure_id)
);

-- "What have we quoted this user, most recent first?" — the audit read.
CREATE INDEX IF NOT EXISTS idx_billing_disclosures_user_created
  ON billing_disclosures (user_id, created_at DESC);

-- The incident query: every quote whose charge did not match.
CREATE INDEX IF NOT EXISTS idx_billing_disclosures_mismatch
  ON billing_disclosures (created_at DESC)
  WHERE mismatch;
`;

export async function up(): Promise<{ existing: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`SELECT COUNT(*)::int AS n FROM billing_disclosures`;
  return { existing: Number((rows as any[])[0]?.n ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('005-billing-disclosures');
if (invokedDirectly) {
  up()
    .then(async ({ existing }) => {
      console.log(`✅ Migration 005 applied. billing_disclosures holds ${existing} row(s).`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 005 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
