/**
 * BILL-005 backfill — stale cancellation flags and orphaned schedules.
 *
 *   npm run backfill:cancellation-flags            # DRY RUN
 *   npm run backfill:cancellation-flags -- --apply
 *
 * Two repairs, because the ticket names two failures and only one of them is
 * visible:
 *
 *  1. VISIBLE — accounts carrying cancel_at_period_end alongside a
 *     subscription Stripe considers active and not cancelling. These are the
 *     users staring at a "Cancellation Scheduled" banner that means nothing.
 *  2. SILENT — accounts with an orphaned subscription SCHEDULE at Stripe. No
 *     banner, no symptom, and at some future date the subscription cancels
 *     itself. This is the one worth running the script for.
 *
 * It also reports the INVERSE divergence — Stripe is cancelling and we are not
 * — but does NOT auto-correct it. Clearing a flag the customer never set is
 * safe; silently deciding a customer meant to cancel is not. Those are listed
 * for a human.
 *
 * Dry run is the default.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';
import { diffSubscriptionState, releaseOrphanedSchedules } from '../services/billing/subscription-state.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
});

const PAGE_SIZE = 100;

interface Finding {
  userId: number;
  email: string;
  kind: 'stale_flag' | 'orphaned_schedule' | 'provider_cancelling_we_are_not';
  detail: string;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply
    ? '⚠️  APPLY MODE — stale flags will be cleared and orphaned schedules released.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply.\n');

  const findings: Finding[] = [];
  let scanned = 0;
  let errors = 0;
  let afterId = 0;

  for (;;) {
    const rows = await sql`
      SELECT s.user_id, u.email,
             s.status, s.cancel_at_period_end, s.next_billing_date,
             s.stripe_subscription_id, s.stripe_customer_id
      FROM   subscriptions s
      JOIN   users u ON u.id = s.user_id
      WHERE  s.stripe_subscription_id IS NOT NULL
        AND  s.user_id > ${afterId}
      ORDER  BY s.user_id
      LIMIT  ${PAGE_SIZE}
    `;
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].user_id;

    for (const row of rows as any[]) {
      scanned++;
      try {
        const providerSub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);

        // 1 & 3 — compare what we believe against the provider.
        const diffs = diffSubscriptionState(row, providerSub as any);
        const flagDiff = diffs.find((d) => d.field === 'cancel_at_period_end');

        if (flagDiff && flagDiff.local === true && flagDiff.provider === false) {
          findings.push({
            userId: row.user_id, email: row.email, kind: 'stale_flag',
            detail: 'We show a scheduled cancellation; Stripe does not. Banner is wrong.',
          });
          if (apply) {
            await sql`
              UPDATE subscriptions
              SET    cancel_at_period_end = FALSE, cancelled_at = NULL
              WHERE  user_id = ${row.user_id}
            `;
          }
        } else if (flagDiff && flagDiff.local === false && flagDiff.provider === true) {
          // Reported, never auto-corrected: deciding on a customer's behalf
          // that they meant to cancel is not a repair.
          findings.push({
            userId: row.user_id, email: row.email, kind: 'provider_cancelling_we_are_not',
            detail: 'Stripe WILL cancel this subscription but we show no banner. Needs a human.',
          });
        }

        // 2 — the silent one. Only meaningful for subscriptions that are NOT
        // supposed to be cancelling; a schedule on a genuine cancellation is
        // doing its job.
        if (row.stripe_customer_id && !providerSub.cancel_at_period_end) {
          const schedules = await stripe.subscriptionSchedules.list({ customer: row.stripe_customer_id });
          const live = (schedules.data ?? []).filter(
            (sc: any) => !['released', 'canceled', 'completed'].includes(sc.status),
          );
          if (live.length > 0) {
            findings.push({
              userId: row.user_id, email: row.email, kind: 'orphaned_schedule',
              detail: `${live.length} live schedule(s) [${live.map((s: any) => s.id).join(', ')}] — future unexpected cancellation.`,
            });
            if (apply) await releaseOrphanedSchedules(stripe, row.stripe_customer_id);
          }
        }
      } catch (err: any) {
        errors++;
        console.error(`  ! user ${row.user_id} (${row.email}): ${err?.message ?? err}`);
      }
    }
  }

  console.log('── Summary ─────────────────────────────────────────');
  console.log(`Subscriptions scanned : ${scanned}`);
  console.log(`Findings              : ${findings.length}`);
  if (errors) console.log(`Errors                : ${errors}`);

  const byKind = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});
  for (const [kind, count] of Object.entries(byKind)) {
    console.log(`  ${count} × ${kind}`);
  }

  if (findings.length > 0) {
    console.log('\n user | kind                            | detail');
    console.log('------+---------------------------------+--------');
    for (const f of findings) {
      console.log(` ${String(f.userId).padStart(4)} | ${f.kind.padEnd(31)} | ${f.detail}`);
    }
  }

  const needsHuman = byKind['provider_cancelling_we_are_not'] ?? 0;
  if (needsHuman > 0) {
    console.log(
      `\n⚠️  ${needsHuman} account(s) will be cancelled by Stripe without our UI saying so. ` +
      'These are NOT auto-corrected — decide deliberately whether each customer meant to cancel.',
    );
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
