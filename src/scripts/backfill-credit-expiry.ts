/**
 * Collapse credit lots onto one expiry date per batch.
 *
 *   npm run backfill:credit-expiry              # DRY RUN
 *   npm run backfill:credit-expiry -- --apply
 *   npm run backfill:credit-expiry -- --user 36 --apply
 *
 * Two rules, both newly enforced at write time, applied here to the rows that
 * predate them:
 *
 *  1. PURCHASED — buying credits renews the 12-month clock on everything the
 *     customer has bought. Existing accounts have a lot per purchase, each with
 *     its own date, so the balance panel cannot state one honest "expiring"
 *     date for the purchased balance. Aligns every live purchased lot to the
 *     latest expiry among them (i.e. the most recent purchase).
 *
 *  2. PLAN — plan credits belong to a billing CYCLE and should lapse with it.
 *     A grant made part-way through a cycle used to expire two months from that
 *     moment rather than with the cycle, so one cycle could hold several expiry
 *     dates days apart. Aligns every live plan lot granted within the current
 *     cycle to the latest expiry among that cycle's lots.
 *
 * BOTH ONLY EVER EXTEND an expiry — the target is the maximum of the dates
 * already present, so no lot is ever shortened and no customer can lose credits
 * to this script. That is what makes it safe to re-run: the second pass finds
 * every lot already at the maximum and writes nothing.
 *
 * Dry run is the default. It reads real customer balances, and the per-user
 * diff it prints is the evidence to check before a real run.
 */
import sql from '../data/db.js';

interface Summary {
  usersScanned: number;
  purchasedUsers: number;
  purchasedLots: number;
  planUsers: number;
  planLots: number;
  errors: number;
}

/** A lot as this script needs to see it. */
interface Lot {
  id: string;
  user_id: number;
  source: 'plan' | 'purchased';
  remaining: number;
  expires_at: Date;
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

async function main() {
  const apply = process.argv.includes('--apply');
  const userArgIndex = process.argv.indexOf('--user');
  const onlyUser = userArgIndex >= 0 ? Number(process.argv[userArgIndex + 1]) : null;

  console.log(apply
    ? '⚠️  APPLY MODE — credit_lots.expires_at will be written.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply.\n');

  const s: Summary = {
    usersScanned: 0, purchasedUsers: 0, purchasedLots: 0, planUsers: 0, planLots: 0, errors: 0,
  };

  // Every user holding live credits. cycle_started_at comes along for the plan
  // rule; it is null for accounts that predate the balance cache, in which case
  // the plan pass treats every live plan lot as one cycle.
  const users = onlyUser
    ? await sql`
        SELECT DISTINCT l.user_id,
               (SELECT cycle_started_at FROM credit_balances
                 WHERE user_id = l.user_id AND credit_type = 'iseo') AS cycle_started_at
        FROM credit_lots l
        WHERE l.remaining > 0 AND l.expires_at > NOW() AND l.user_id = ${onlyUser}`
    : await sql`
        SELECT DISTINCT l.user_id,
               (SELECT cycle_started_at FROM credit_balances
                 WHERE user_id = l.user_id AND credit_type = 'iseo') AS cycle_started_at
        FROM credit_lots l
        WHERE l.remaining > 0 AND l.expires_at > NOW()
        ORDER BY l.user_id`;

  for (const row of users as any[]) {
    const userId = Number(row.user_id);
    const cycleStart: Date | null = row.cycle_started_at ?? null;
    s.usersScanned++;

    try {
      const lots = (await sql`
        SELECT id, user_id, source, remaining, expires_at
        FROM   credit_lots
        WHERE  user_id = ${userId} AND remaining > 0 AND expires_at > NOW()
        ORDER  BY expires_at
      `) as unknown as Lot[];

      // ── 1. Purchased: one date for the lot of them ──
      const purchased = lots.filter((l) => l.source === 'purchased');
      const purchasedDates = new Set(purchased.map((l) => day(l.expires_at)));
      if (purchased.length > 1 && purchasedDates.size > 1) {
        const target = purchased
          .reduce((a, b) => (new Date(a.expires_at) > new Date(b.expires_at) ? a : b))
          .expires_at;
        console.log(
          `  ${apply ? '✎' : '·'} user ${userId} · purchased: ${purchased.length} lots, `
          + `${[...purchasedDates].sort().join(' / ')} → ${day(target)}`,
        );
        s.purchasedUsers++;
        s.purchasedLots += purchased.length;
        if (apply) {
          await sql`
            UPDATE credit_lots SET expires_at = ${target}, updated_at = NOW()
            WHERE  user_id = ${userId} AND source = 'purchased'
              AND  remaining > 0 AND expires_at > NOW()
              AND  expires_at < ${target}
          `;
        }
      }

      // ── 2. Plan: one date per cycle ──
      // Restricted to lots granted in the CURRENT cycle. An older cycle's lots
      // are a separate batch with their own legitimate date, and folding them
      // together would erase the very distinction the panel is meant to show.
      const planThisCycle = cycleStart
        ? (await sql`
            SELECT id, user_id, source, remaining, expires_at
            FROM   credit_lots
            WHERE  user_id = ${userId} AND source = 'plan'
              AND  remaining > 0 AND expires_at > NOW()
              AND  granted_at >= ${cycleStart}
            ORDER  BY expires_at
          `) as unknown as Lot[]
        : lots.filter((l) => l.source === 'plan');

      const planDates = new Set(planThisCycle.map((l) => day(l.expires_at)));
      if (planThisCycle.length > 1 && planDates.size > 1) {
        const target = planThisCycle
          .reduce((a, b) => (new Date(a.expires_at) > new Date(b.expires_at) ? a : b))
          .expires_at;
        console.log(
          `  ${apply ? '✎' : '·'} user ${userId} · plan (this cycle): ${planThisCycle.length} lots, `
          + `${[...planDates].sort().join(' / ')} → ${day(target)}`,
        );
        s.planUsers++;
        s.planLots += planThisCycle.length;
        if (apply) {
          await sql`
            UPDATE credit_lots SET expires_at = ${target}, updated_at = NOW()
            WHERE  id = ANY(${planThisCycle.map((l) => l.id)})
              AND  expires_at < ${target}
          `;
        }
      }
    } catch (err: any) {
      s.errors++;
      console.error(`  ! user ${userId}: ${err?.message ?? err}`);
    }
  }

  console.log('\n── Summary ─────────────────────────────────────────');
  console.log(`Users holding live credits             : ${s.usersScanned}`);
  console.log(`Purchased batches needing one date     : ${s.purchasedUsers} user(s), ${s.purchasedLots} lot(s)`);
  console.log(`Plan batches needing one date per cycle: ${s.planUsers} user(s), ${s.planLots} lot(s)`);
  if (!apply && (s.purchasedUsers || s.planUsers)) {
    console.log('\nRe-run with --apply to write these.');
  }
  if (s.errors) console.log(`Errors                                 : ${s.errors}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
