/**
 * Recover the missing receipt links on credit-purchase rows.
 *
 *   npm run backfill:receipts                  # DRY RUN
 *   npm run backfill:receipts -- --apply
 *   npm run backfill:receipts -- --user 7 --apply
 *
 * Why this exists, and why backfill-billing-transactions.ts does not cover it:
 * that script walks INVOICES, and a credit top-up has none. It is a Checkout
 * Session in `payment` mode, so its receipt hangs off the charge behind the
 * payment intent. The webhook that records the purchase never fetched it — the
 * payload carries `payment_intent` as a bare id — so every credit_purchase row
 * written before that fix has receipt_url NULL while Stripe has had the link
 * the whole time.
 *
 * The visible symptom is an Account Activity CSV whose Receipt column is empty
 * on exactly the rows a customer wants to expense.
 *
 * Safe to re-run: it only ever fills a NULL, and only from Stripe's own record
 * of the session this row already names. A row whose session has genuinely no
 * receipt (an unpaid or expired session) is left alone and counted, not retried
 * into an error.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';
import { receiptUrlFromSession, CHECKOUT_RECEIPT_EXPAND } from '../services/billing/transactions.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
});

interface Summary {
  rowsScanned: number;
  recoverable: number;
  written: number;
  noReceiptAtStripe: number;
  notASession: number;
  errors: number;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userArgIndex = process.argv.indexOf('--user');
  const onlyUser = userArgIndex >= 0 ? Number(process.argv[userArgIndex + 1]) : null;

  console.log(apply
    ? '⚠️  APPLY MODE — receipt_url will be written.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply.\n');

  const s: Summary = {
    rowsScanned: 0, recoverable: 0, written: 0,
    noReceiptAtStripe: 0, notASession: 0, errors: 0,
  };

  // Only rows that are actually missing one. Filling a NULL is the entire
  // operation — an existing receipt_url is never overwritten.
  const rows = onlyUser
    ? await sql`
        SELECT id, user_id, description, provider_object_id, occurred_at
        FROM billing_transactions
        WHERE type = 'credit_purchase' AND receipt_url IS NULL AND user_id = ${onlyUser}
        ORDER BY occurred_at DESC`
    : await sql`
        SELECT id, user_id, description, provider_object_id, occurred_at
        FROM billing_transactions
        WHERE type = 'credit_purchase' AND receipt_url IS NULL
        ORDER BY occurred_at DESC`;

  for (const row of rows) {
    s.rowsScanned++;
    const sessionId: string | null = row.provider_object_id;

    // Rows recorded from something other than a Checkout Session have no
    // session to read. Counted rather than treated as a failure.
    if (!sessionId || !sessionId.startsWith('cs_')) {
      s.notASession++;
      continue;
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: CHECKOUT_RECEIPT_EXPAND,
      });
      const receiptUrl = receiptUrlFromSession(session);

      if (!receiptUrl) {
        s.noReceiptAtStripe++;
        continue;
      }

      s.recoverable++;
      console.log(`  ${apply ? '✎' : '·'} user ${row.user_id} · ${row.description}`);

      if (apply) {
        // Guarded on IS NULL a second time so a concurrent webhook writing the
        // real receipt cannot be clobbered by this slower path.
        const updated = await sql`
          UPDATE billing_transactions
          SET receipt_url = ${receiptUrl}
          WHERE id = ${row.id} AND receipt_url IS NULL
          RETURNING id`;
        if (updated.length > 0) s.written++;
      }
    } catch (err: any) {
      s.errors++;
      console.error(`  ! row ${row.id} (session ${sessionId}): ${err?.message ?? err}`);
    }
  }

  console.log('\n── Summary ─────────────────────────────────────────');
  console.log(`credit_purchase rows missing a receipt : ${s.rowsScanned}`);
  console.log(`  …recoverable from Stripe             : ${s.recoverable}`);
  if (apply) {
    console.log(`  …written                             : ${s.written}`);
  }
  if (s.noReceiptAtStripe) console.log(`  …no receipt at Stripe (unpaid?)      : ${s.noReceiptAtStripe}`);
  if (s.notASession) console.log(`  …not a Checkout Session              : ${s.notASession}`);
  if (s.errors) console.log(`Errors                                 : ${s.errors}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
