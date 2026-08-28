/**
 * Repair next_billing_date against Stripe's real billing period.
 *
 *   npm run backfill:billing-dates            # DRY RUN
 *   npm run backfill:billing-dates -- --apply
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * Five call sites read the period as
 *
 *     (subscription as any).current_period_end || now + 30 * 86400
 *
 * and on API version 2025-10-29.clover that field is not on the Subscription
 * object at all — it moved onto each item. So the left side was always
 * undefined and every stored date became "whenever we last wrote this row, plus
 * thirty days". A calendar month is 31 days, so every active subscription ended
 * up about a day early. Worse, the customer.subscription.updated webhook fires
 * on every plan change, so each upgrade pushed the date another thirty days out
 * from that moment.
 *
 * services/billing/subscription-period fixes the reads. This fixes the rows
 * they already wrote.
 *
 * ── WHY IT IS SAFE ──────────────────────────────────────────────────────────
 * next_billing_date is a DISPLAY and scheduling value on our side — Stripe bills
 * on its own anchor regardless of what we store. So this corrects what customers
 * are shown; it moves no money and changes nothing at the provider.
 *
 * It writes only where Stripe has an unambiguous answer, only where that answer
 * differs from what we hold, and it prints every change before making it. A
 * subscription Stripe cannot tell us the period for is REPORTED, never guessed —
 * guessing is what produced this.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';
import { periodEndOf } from '../services/billing/subscription-period.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
});

/** YYYY-MM-DD in UTC — the session TimeZone the column is stored under. */
const dayOf = (value: Date | string | number): string => {
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return d.toISOString().slice(0, 10);
};

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply
    ? '⚠️  APPLY MODE — next_billing_date will be rewritten from Stripe.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply.\n');

  const rows = await sql`
    SELECT s.user_id, u.email, s.status, s.next_billing_date, s.stripe_subscription_id,
           s.pending_plan_id, s.pending_plan_effective_date
    FROM   subscriptions s
    JOIN   users u ON u.id = s.user_id
    WHERE  s.stripe_subscription_id IS NOT NULL
    ORDER  BY s.user_id
  ` as any[];

  let corrected = 0;
  let alreadyRight = 0;
  let scheduledMoved = 0;
  const unreadable: string[] = [];

  for (const row of rows) {
    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    } catch (err: any) {
      unreadable.push(`user ${row.user_id} (${row.email}): ${err?.message || err}`);
      continue;
    }

    const periodEnd = periodEndOf(subscription);
    if (periodEnd === null) {
      unreadable.push(`user ${row.user_id} (${row.email}): Stripe returned no billing period`);
      continue;
    }

    const stored = row.next_billing_date ? dayOf(row.next_billing_date) : null;
    const actual = dayOf(periodEnd);

    if (stored === actual) {
      alreadyRight += 1;
      continue;
    }

    corrected += 1;
    console.log(
      `user ${String(row.user_id).padStart(4)} ${row.email}` +
      `\n    stored ${stored ?? '(none)'}  →  Stripe ${actual}` +
      `  [${row.status}, ${subscription.id}]`,
    );

    // ── A scheduled downgrade rides on this date ────────────────────────────
    // pending_plan_effective_date is written as a COPY of next_billing_date
    // (see changePlan: `pending_plan_effective_date = next_billing_date`), so
    // moving one without the other would leave a downgrade scheduled a day
    // BEFORE the renewal it is supposed to coincide with — a new bug, created
    // by the fix for the old one.
    //
    // Only when the two currently agree, which is the signal that it was
    // derived rather than set deliberately. A date someone chose for their own
    // reasons is left where it is and reported.
    const scheduled = row.pending_plan_effective_date
      ? dayOf(row.pending_plan_effective_date)
      : null;
    const moveScheduled = row.pending_plan_id != null && scheduled !== null && scheduled === stored;
    if (row.pending_plan_id != null) {
      if (moveScheduled) {
        scheduledMoved += 1;
        console.log(`    scheduled plan change moves with it: ${scheduled} → ${actual}`);
      } else {
        console.log(
          `    ⚠️  pending plan change effective ${scheduled ?? '(none)'} does NOT match the stored ` +
          'billing date — left as it is, check it by hand',
        );
      }
    }

    if (apply) {
      await sql`
        UPDATE subscriptions
        SET    next_billing_date = TO_TIMESTAMP(${periodEnd}::double precision),
               pending_plan_effective_date = ${moveScheduled
                 ? sql`TO_TIMESTAMP(${periodEnd}::double precision)`
                 : sql`pending_plan_effective_date`}
        WHERE  user_id = ${row.user_id}
      `;
    }
  }

  console.log(
    `\n${rows.length} subscription(s) checked — ` +
    `${corrected} ${apply ? 'corrected' : 'to correct'}, ${alreadyRight} already right` +
    (scheduledMoved > 0
      ? `, ${scheduledMoved} scheduled plan change(s) ${apply ? 'moved' : 'to move'} with them.`
      : '.'),
  );

  if (unreadable.length > 0) {
    // Listed for a human rather than patched over. A row we cannot verify keeps
    // the date it has; overwriting it with a computed one is the original bug.
    console.log(`\n⚠️  ${unreadable.length} could not be read and were left alone:`);
    unreadable.forEach((line) => console.log(`    ${line}`));
  }

  if (!apply && corrected > 0) console.log('\nRe-run with --apply to write these.');

  await sql.end();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await sql.end().catch(() => {});
  process.exit(1);
});
