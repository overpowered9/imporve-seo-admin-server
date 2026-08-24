/**
 * Put a credit batch inside the expiry warning window, so the warnings can be seen.
 *
 *   npm run seed:expiring -- --user 36 --days 5
 *   npm run seed:expiring -- --user 36 --days 5 --source purchased
 *   npm run seed:expiring -- --user 36 --remove
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The expiry warnings — the bell notification, both banners and the red row in
 * the balance breakdown — only appear when a batch of credits is within 14 days
 * of lapsing. Across every account the soonest expiry is roughly two months
 * out, so the whole feature correctly renders nothing and cannot be reviewed by
 * looking at the app.
 *
 * This grants a small, clearly-labelled lot with a near expiry date, and can
 * take it away again. It is a development convenience, not an operational tool:
 * it writes credits a customer did not pay for, so every lot it creates is
 * tagged with SEED_REASON and --remove deletes exactly those and nothing else.
 *
 * Safe with the email trigger: credit-expiry emails are gated behind
 * ISEO_CREDIT_EXPIRY_EMAILS_ENABLED (default off), so seeding cannot cause a
 * placeholder email to reach anyone.
 */
import sql from '../data/db.js';
import { grantCreditLot, syncBalanceCache } from '../models/user.models.js';

/** The tag that makes a seeded lot identifiable, and therefore removable. */
const SEED_REASON = 'DEV SEED: expiring-credits demo';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const userId = Number(arg('user'));
  const remove = process.argv.includes('--remove');
  const days = Number(arg('days') ?? 5);
  const source = (arg('source') ?? 'plan') as 'plan' | 'purchased';
  const credits = Number(arg('credits') ?? 25);

  if (!Number.isInteger(userId) || userId <= 0) {
    console.error('Usage: npm run seed:expiring -- --user <id> [--days 5] [--source plan|purchased] [--credits 25]');
    console.error('       npm run seed:expiring -- --user <id> --remove');
    process.exit(1);
  }

  if (remove) {
    const gone = await sql`
      DELETE FROM credit_lots
      WHERE user_id = ${userId} AND reason = ${SEED_REASON}
      RETURNING id, remaining
    `;
    // The balance cache is derived from the lots, so it has to be recomputed —
    // otherwise the panel keeps showing credits that no longer exist. Through
    // the model's own syncBalanceCache, which is the single legal writer.
    await syncBalanceCache(sql, userId);
    console.log(gone.length > 0
      ? `− removed ${gone.length} seeded lot(s) from user ${userId}`
      : `nothing to remove for user ${userId}`);
    await sql.end();
    return;
  }

  if (!['plan', 'purchased'].includes(source)) {
    console.error(`--source must be 'plan' or 'purchased', got '${source}'`);
    process.exit(1);
  }
  if (!Number.isFinite(days) || days < 0 || days > 60) {
    console.error('--days must be between 0 and 60 (the warning window is 14)');
    process.exit(1);
  }

  const [user] = await sql`SELECT id, email FROM users WHERE id = ${userId}`;
  if (!user) {
    console.error(`No user ${userId}`);
    process.exit(1);
  }

  // Through grantCreditLot, not a raw INSERT: it is the sanctioned entry point
  // and it syncs the balance cache in the same transaction. Writing credit_lots
  // and credit_balances by hand is exactly what credit-writers.test.ts forbids,
  // and it caught this script doing it.
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await grantCreditLot(userId, source, credits, { reason: SEED_REASON, expiresAt });

  const on = expiresAt.toISOString().slice(0, 10);
  console.log(`+ granted ${credits} ${source} credits to user ${userId} (${(user as any).email})`);
  console.log(`  expires ${on} — ${days} day(s) away${days <= 14 ? ' → inside the 14-day warning window' : ''}`);
  console.log('\nReload the CMS: the bell, both banners and the red breakdown row should appear.');
  console.log(`Undo with:  npm run seed:expiring -- --user ${userId} --remove`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Seed failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
