/**
 * Report upgrade prorations that were never collected.  READ ONLY.
 *
 *   npm run report:pending-prorations
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * chargeProrationNow created its invoice without
 * `pending_invoice_items_behavior: 'include'`. On API 2025-10-29.clover the
 * default is `exclude`, so every upgrade invoice came back $0, was voided, and
 * was reported as paid — while the proration stayed PENDING on the subscription,
 * to be billed on the next renewal invoice.
 *
 * So for every upgrade made before the fix:
 *   • Stripe still holds a pending proration item on the subscription, and
 *   • our ledger has a `plan_upgrade` row marked `succeeded` for money that did
 *     not move.
 *
 * This lists both, per account, and changes NOTHING. Whether to leave each item
 * for the renewal invoice (it will be collected there) or invoice it now is a
 * decision for a human with the customer's history in front of them.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
});

const PAGE_SIZE = 100;

const subscriptionOf = (item: any): string | null =>
  item?.parent?.subscription_details?.subscription
  ?? (typeof item?.subscription === 'string' ? item.subscription : null);

const money = (cents: number, currency = 'usd') =>
  `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)} ${currency.toUpperCase()}`;

async function main() {
  console.log('🔍 READ ONLY — listing uncollected upgrade prorations. Nothing is written.\n');

  let scanned = 0;
  let affected = 0;
  let errors = 0;
  let totalPendingCents = 0;
  let afterId = 0;

  for (;;) {
    const rows = await sql`
      SELECT s.user_id, u.email, s.stripe_subscription_id, s.stripe_customer_id
      FROM   subscriptions s
      JOIN   users u ON u.id = s.user_id
      WHERE  s.stripe_subscription_id IS NOT NULL
        AND  s.stripe_customer_id IS NOT NULL
        AND  s.user_id > ${afterId}
      ORDER  BY s.user_id
      LIMIT  ${PAGE_SIZE}
    `;
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].user_id;

    for (const row of rows as any[]) {
      scanned++;
      try {
        const pending: any[] = [];
        for await (const item of stripe.invoiceItems.list({
          customer: row.stripe_customer_id,
          pending: true,
          limit: 100,
        })) {
          if ((item as any).proration && subscriptionOf(item) === row.stripe_subscription_id) {
            pending.push(item);
          }
        }
        if (pending.length === 0) continue;

        affected++;
        const netCents = pending.reduce((n, item) => n + (item.amount ?? 0), 0);
        totalPendingCents += netCents;

        // Ledger rows that claim an upgrade was paid while Stripe still holds its
        // proration. Bounded to the earliest pending item so an upgrade from a
        // previous, genuinely-billed period is not listed.
        const since = new Date(
          Math.min(...pending.map((item) => (item.period?.start ?? item.date ?? 0) * 1000)),
        );
        const ledger = await sql`
          SELECT id, description, amount_cents, currency, status, created_at
          FROM   billing_transactions
          WHERE  user_id = ${row.user_id}
            AND  type = 'plan_upgrade'
            AND  status = 'succeeded'
            AND  created_at >= ${since.toISOString()}::timestamptz - INTERVAL '1 day'
          ORDER  BY created_at
        `;

        console.log(`── user ${row.user_id} <${row.email}>  ${row.stripe_subscription_id}`);
        console.log(`   pending proration: ${money(netCents, pending[0].currency)} across ${pending.length} item(s)`);
        for (const item of pending) {
          const at = item.period?.start ? new Date(item.period.start * 1000).toISOString().slice(0, 10) : '?';
          console.log(`     ${at}  ${money(item.amount ?? 0, item.currency)}  ${item.description ?? ''}  (${item.id})`);
        }
        if (ledger.length > 0) {
          console.log('   ledger rows marked succeeded for this period:');
          for (const l of ledger as any[]) {
            console.log(
              `     #${l.id}  ${new Date(l.created_at).toISOString().slice(0, 10)}  `
              + `${money(Number(l.amount_cents ?? 0), l.currency ?? 'usd')}  ${l.description}`,
            );
          }
        }
        console.log('');
      } catch (err: any) {
        errors++;
        console.error(`⚠️ user ${row.user_id}: ${err?.message || err}`);
      }
    }
  }

  console.log('────────────────────────────────────────');
  console.log(`Scanned:  ${scanned} subscription(s)`);
  console.log(`Affected: ${affected} with uncollected upgrade prorations`);
  console.log(`Net pending: ${money(totalPendingCents)}`);
  if (errors) console.log(`Errors:   ${errors} (see above)`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('Report failed:', err);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
});
