/**
 * BILL-004 backfill — reconstruct history from the provider.
 *
 *   npm run backfill:transactions            # DRY RUN
 *   npm run backfill:transactions -- --apply
 *   npm run backfill:transactions -- --user 7 --apply
 *
 * The ledger starts empty. Every charge that happened before it existed —
 * including the credit purchase and two upgrades in the ticket's reproduction —
 * is only recorded at Stripe. This walks each customer's invoices and writes
 * the rows that would have been written had the ledger existed at the time.
 *
 * Idempotent because it uses the same writer as the live paths, which upserts
 * on the provider event id. Running it twice writes nothing the second time;
 * running it AFTER the code has been live for a while simply fills the gaps
 * before the deploy and leaves the newer rows alone.
 *
 * Dry run is the default. This reads real customer billing data, and the
 * summary it prints is the evidence the ticket asks for before a real run.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';
import { recordTransaction, transactionsFromInvoice } from '../services/billing/transactions.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
});

const PAGE_SIZE = 50;
/** Invoices to pull per customer. 100 is Stripe's per-page maximum. */
const INVOICE_LIMIT = 100;

interface Summary {
  usersScanned: number;
  usersWithInvoices: number;
  invoicesSeen: number;
  rowsWouldWrite: number;
  rowsWritten: number;
  rowsAlreadyPresent: number;
  errors: number;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userArgIndex = process.argv.indexOf('--user');
  const onlyUser = userArgIndex >= 0 ? Number(process.argv[userArgIndex + 1]) : null;

  console.log(apply
    ? '⚠️  APPLY MODE — rows will be written to billing_transactions.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply.\n');

  const s: Summary = {
    usersScanned: 0, usersWithInvoices: 0, invoicesSeen: 0,
    rowsWouldWrite: 0, rowsWritten: 0, rowsAlreadyPresent: 0, errors: 0,
  };

  const byType: Record<string, number> = {};
  let afterId = onlyUser ? onlyUser - 1 : 0;

  for (;;) {
    const users = onlyUser
      ? await sql`
          SELECT id, email, stripe_customer_id, plan_id
          FROM   users
          WHERE  id = ${onlyUser} AND stripe_customer_id IS NOT NULL
        `
      : await sql`
          SELECT id, email, stripe_customer_id, plan_id
          FROM   users
          WHERE  stripe_customer_id IS NOT NULL AND id > ${afterId}
          ORDER  BY id
          LIMIT  ${PAGE_SIZE}
        `;

    if (users.length === 0) break;
    afterId = users[users.length - 1].id;

    for (const user of users as any[]) {
      s.usersScanned++;
      try {
        const invoices = await stripe.invoices.list({
          customer: user.stripe_customer_id,
          limit: INVOICE_LIMIT,
        });
        if (invoices.data.length > 0) s.usersWithInvoices++;
        s.invoicesSeen += invoices.data.length;

        for (const invoice of invoices.data) {
          const rows = transactionsFromInvoice(invoice, user.id, user.plan_id ?? null);
          for (const row of rows) {
            byType[row.type] = (byType[row.type] ?? 0) + 1;
            s.rowsWouldWrite++;
            if (apply) {
              const result = await recordTransaction(sql, row);
              if (!result.recorded) s.errors++;
              else if (result.duplicate) s.rowsAlreadyPresent++;
              else s.rowsWritten++;
            }
          }
        }
      } catch (err: any) {
        s.errors++;
        console.error(`  ! user ${user.id} (${user.email}): ${err?.message ?? err}`);
      }
    }

    if (onlyUser) break;
  }

  console.log('── Summary ─────────────────────────────────────────');
  console.log(`Users with a Stripe customer scanned : ${s.usersScanned}`);
  console.log(`  …of which had invoices             : ${s.usersWithInvoices}`);
  console.log(`Invoices read                        : ${s.invoicesSeen}`);
  console.log(`Ledger rows ${apply ? 'considered' : 'that WOULD be written'}       : ${s.rowsWouldWrite}`);
  if (apply) {
    console.log(`  …newly written                     : ${s.rowsWritten}`);
    console.log(`  …already present (no-op)           : ${s.rowsAlreadyPresent}`);
  }
  if (s.errors) console.log(`Errors                               : ${s.errors}`);

  if (Object.keys(byType).length > 0) {
    console.log('\nBy type:');
    for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)} × ${type}`);
    }
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
