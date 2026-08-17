/**
 * Migration 011 — collapse the three credit pools into one ISEO Credits pool
 *
 *   npm run migrate:iseo-credits      (needs DATABASE_URL, same as the server)
 *
 * ⚠️  THIS RESETS BALANCES. Announce it before deploying.
 *
 * WHY
 * Credits were three independent pools ('images' | 'content' | 'keywords'), each charged a flat 1
 * per action however much the action actually cost. Real cost varies about 2x across article sizes
 * and again between an article and an image, so a flat charge over-priced small work and
 * under-priced large. One pool plus a per-action deduction table fixes the pricing; this migration
 * moves the data.
 *
 * WHY BALANCES ARE NOT CARRIED OVER
 * There is no honest conversion. The three pools are denominated in different things — one
 * "content credit" bought one article of any size, one "image credit" bought one image — and the
 * new unit is a fraction of both. Any arithmetic mapping old to new would silently enrich some
 * users and rob others, and no rate would be defensible to a customer who asked. Instead every
 * user is seeded to the allotment their CURRENT plan grants, which is the number they would get at
 * their next refill anyway. This was an explicit product decision, not a shortcut.
 *
 * PURCHASED CREDITS ARE THE ONE EXCEPTION
 * Included (plan) credits are reset because they expire each cycle anyway. Purchased credits were
 * paid for separately and do not expire, so discarding them would be taking money. They are summed
 * across the three old rows and carried onto the new row as-is. That is generous in the user's
 * favour (a purchased image credit is worth fewer ISEO credits than a purchased content credit),
 * which is the correct direction to err when handling money.
 *
 * SAFETY
 * Runs in one transaction, so it either fully applies or leaves the old rows untouched. Idempotent:
 * re-running after a successful pass is a no-op because the old rows are gone. Every seeded row
 * gets a credit_transactions entry, so the reset is visible in the ledger rather than appearing as
 * an unexplained balance change.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`.
 */
import sql from '../data/db.js';
import { grantForPlanSlug } from '../config/credits.config.js';

export interface MigrationResult {
  usersSeeded: number;
  purchasedCarried: number;
  oldRowsRemoved: number;
}

export async function up(): Promise<MigrationResult> {
  return await sql.begin(async (sql) => {
    // Every user that currently holds any credit row, with their plan slug and the purchased
    // credits they paid for across the three old pools.
    const rows = (await sql`
      SELECT cb.user_id,
             COALESCE(sp.slug, 'free')                  AS slug,
             COALESCE(SUM(cb.purchased_remaining), 0)::int AS purchased
      FROM credit_balances cb
      LEFT JOIN users u             ON u.id = cb.user_id
      LEFT JOIN subscription_plans sp ON sp.id = u.plan_id
      WHERE cb.credit_type IN ('images', 'content', 'keywords')
      GROUP BY cb.user_id, sp.slug
    `) as unknown as Array<{ user_id: number; slug: string; purchased: number }>;

    let purchasedCarried = 0;

    for (const row of rows) {
      const allotment = grantForPlanSlug(row.slug);
      const purchased = Number(row.purchased) || 0;
      purchasedCarried += purchased;

      await sql`
        INSERT INTO credit_balances
          (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
        VALUES
          (${row.user_id}, 'iseo', ${allotment}, ${allotment}, ${purchased}, NOW())
        ON CONFLICT (user_id, credit_type)
        DO UPDATE SET
          included_remaining  = ${allotment},
          included_allotment  = ${allotment},
          purchased_remaining = ${purchased},
          cycle_started_at    = NOW(),
          updated_at          = NOW()
      `;

      // Ledger entry, so the reset is explainable to a user (and to support) later.
      await sql`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${row.user_id}, 'iseo', ${allotment + purchased},
                'Migration to ISEO Credits: plan allotment reset, purchased credits carried over')
      `;
    }

    const removed = await sql`
      DELETE FROM credit_balances
      WHERE credit_type IN ('images', 'content', 'keywords')
      RETURNING 1
    `;

    return {
      usersSeeded: rows.length,
      purchasedCarried,
      oldRowsRemoved: (removed as unknown as unknown[]).length,
    };
  });
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('011-iseo-credit-pool');
if (invokedDirectly) {
  up()
    .then(async (r) => {
      console.log(
        `✅ Migration 011 applied. ${r.usersSeeded} user(s) seeded to the ISEO pool, ` +
          `${r.purchasedCarried} purchased credit(s) carried over, ${r.oldRowsRemoved} old row(s) removed.`,
      );
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 011 failed (transaction rolled back, old rows intact):', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
