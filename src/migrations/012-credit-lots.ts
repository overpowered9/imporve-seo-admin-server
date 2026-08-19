/**
 * Migration 012 — credit LOTS, so credits can expire
 *
 *   npm run migrate:credit-lots      (needs DATABASE_URL, same as the server)
 *
 * ⚠️  Run migration 011 FIRST. This seeds from the ISEO pool row; if the legacy
 *     content/images/keywords rows are still present, 011 has not run and this
 *     will refuse rather than seed half a picture.
 *
 * WHY A NEW TABLE AND NOT TWO MORE COLUMNS
 * The rule is "plan credits expire after two months, purchased after twelve,
 * and always burn the earliest-expiring first". Under a two-month life a user
 * normally holds credits from TWO different monthly grants at once, each with
 * its own expiry date. A single (included_remaining, purchased_remaining) pair
 * cannot express two expiry dates, so "earliest first" would be a claim the
 * schema could not honour — it would silently burn the newer grant half the
 * time and expire credits the customer had already earned the right to spend.
 *
 * One row per grant or purchase is the smallest structure that can be correct.
 *
 * BALANCE IS NOW DERIVED
 * remaining = SUM(remaining) over lots that have not expired. credit_balances
 * stays as a read-through cache maintained inside the same transaction as every
 * lot mutation — never written independently. A second writable copy of a
 * number is exactly how the dashboard came to show 3090 credits against a real
 * balance of 1139.
 *
 * SAFETY
 * One transaction. Idempotent: seeding is skipped for any user who already has
 * lots, so a re-run after a successful pass is a no-op rather than a doubling.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`.
 */
import sql from '../data/db.js';
import {
  PLAN_CREDIT_LIFETIME_MONTHS,
  PURCHASED_CREDIT_LIFETIME_MONTHS,
} from '../config/credits.config.js';

export interface MigrationResult {
  usersSeeded: number;
  planLots: number;
  purchasedLots: number;
  skippedExisting: number;
}

export async function up(): Promise<MigrationResult> {
  return await sql.begin(async (sql) => {
    // ── Guard: 011 must have run ────────────────────────────────────────────
    // Seeding from a half-migrated balance set would bake the wrong numbers
    // into lots, and lots are what the balance is computed from afterwards.
    const legacy = (await sql`
      SELECT count(*)::int AS n FROM credit_balances
      WHERE credit_type IN ('content', 'images', 'keywords')
    `) as unknown as Array<{ n: number }>;
    if (legacy[0].n > 0) {
      throw new Error(
        `Refusing to seed credit lots: ${legacy[0].n} legacy credit_balances row(s) still exist. `
        + 'Run migration 011 (npm run migrate:iseo-credits) first.',
      );
    }

    await sql`
      CREATE TABLE IF NOT EXISTS credit_lots (
        id            BIGSERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        -- Where the credits came from. Drives the lifetime and the UI row they
        -- are counted under; it is NOT a price difference — a credit costs the
        -- same to spend whichever lot it comes from.
        source        TEXT NOT NULL CHECK (source IN ('plan', 'purchased')),

        granted       INTEGER NOT NULL CHECK (granted > 0),
        -- Never negative: the burn is guarded by a WHERE clause, so an
        -- oversell becomes zero rows updated rather than a negative balance.
        remaining     INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= granted),

        granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL,

        plan_id             INTEGER REFERENCES subscription_plans(id),
        -- The Stripe object that paid for a purchased lot, so a top-up can be
        -- traced from the ledger to the credits it produced.
        provider_object_id  TEXT,
        reason        TEXT,

        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // THE hot path: "the user's live lots, earliest expiry first". Partial, so
    // the index stays small as spent lots accumulate.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_credit_lots_fefo
        ON credit_lots (user_id, expires_at, id)
        WHERE remaining > 0
    `;

    // Supports the expiry sweep without scanning spent history.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_credit_lots_expiring
        ON credit_lots (expires_at)
        WHERE remaining > 0
    `;

    // ── Seed from the existing pool ─────────────────────────────────────────
    // Plan credits get the remainder of a normal lifetime from the cycle they
    // were granted in, not a fresh one — seeding must not hand out extra time.
    const rows = (await sql`
      SELECT cb.user_id,
             cb.included_remaining::int  AS included,
             cb.purchased_remaining::int AS purchased,
             cb.cycle_started_at,
             u.plan_id
      FROM   credit_balances cb
      JOIN   users u ON u.id = cb.user_id
      WHERE  cb.credit_type = 'iseo'
        AND  NOT EXISTS (SELECT 1 FROM credit_lots cl WHERE cl.user_id = cb.user_id)
    `) as unknown as Array<{
      user_id: number; included: number; purchased: number;
      cycle_started_at: Date | null; plan_id: number | null;
    }>;

    let planLots = 0;
    let purchasedLots = 0;

    for (const r of rows) {
      if (r.included > 0) {
        await sql`
          INSERT INTO credit_lots (user_id, source, granted, remaining, granted_at, expires_at, plan_id, reason)
          VALUES (
            ${r.user_id}, 'plan', ${r.included}, ${r.included},
            COALESCE(${r.cycle_started_at}, NOW()),
            COALESCE(${r.cycle_started_at}, NOW()) + ${`${PLAN_CREDIT_LIFETIME_MONTHS} months`}::interval,
            ${r.plan_id}, 'Seeded from balance (migration 012)'
          )
        `;
        planLots += 1;
      }
      if (r.purchased > 0) {
        // Purchased credits previously never expired. Dating their lifetime from
        // NOW rather than from an unknown purchase date is the generous reading,
        // and the only one that cannot retroactively expire something a customer
        // paid for before they were ever told it had a life.
        await sql`
          INSERT INTO credit_lots (user_id, source, granted, remaining, granted_at, expires_at, reason)
          VALUES (
            ${r.user_id}, 'purchased', ${r.purchased}, ${r.purchased}, NOW(),
            NOW() + ${`${PURCHASED_CREDIT_LIFETIME_MONTHS} months`}::interval,
            'Seeded from balance (migration 012)'
          )
        `;
        purchasedLots += 1;
      }
    }

    const skipped = (await sql`
      SELECT count(DISTINCT cb.user_id)::int AS n
      FROM credit_balances cb
      WHERE cb.credit_type = 'iseo'
        AND EXISTS (SELECT 1 FROM credit_lots cl WHERE cl.user_id = cb.user_id)
    `) as unknown as Array<{ n: number }>;

    return {
      usersSeeded: rows.length,
      planLots,
      purchasedLots,
      skippedExisting: skipped[0].n,
    };
  });
}

// Allow `tsx src/migrations/012-credit-lots.ts` directly, like the others.
if (process.argv[1] && process.argv[1].includes('012-credit-lots')) {
  up()
    .then((r) => {
      console.log('✅ Migration 012 complete:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('❌ Migration 012 failed:', e);
      process.exit(1);
    });
}
