/**
 * BILL-001 backfill — accounts with a saved card but no default.
 *
 *   npm run backfill:payment-defaults            # DRY RUN, changes nothing
 *   npm run backfill:payment-defaults -- --apply # actually writes
 *
 * WHY IT IS NEEDED
 * The promotion fix only helps from the moment it ships. Every account that
 * already added a card while the old webhook-only path was in force may be
 * sitting in the broken state right now: cards attached, no default, upgrade
 * refused. Those accounts do not heal on their own — nothing re-runs for them
 * until they next hit a payment-methods read.
 *
 * Migration 006 also introduced the local columns EMPTY, so even accounts whose
 * Stripe default is perfectly fine have no local record until something writes
 * one. This fills both gaps in one pass.
 *
 * IDEMPOTENT BY CONSTRUCTION
 * It calls the same ensureDefaultPaymentMethod the application uses, which is a
 * no-op when both sides already agree. Running it twice does nothing the second
 * time; running it while the app is serving traffic is safe, because the same
 * row lock serialises them.
 *
 * DRY RUN IS THE DEFAULT, deliberately. This script talks to the live payment
 * provider on behalf of real customers; making the safe mode the one you get by
 * forgetting a flag is the only sensible default.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';
import {
  ensureDefaultPaymentMethod,
  chooseDefaultPaymentMethod,
} from '../services/billing/payment-methods.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
});

const PAGE_SIZE = 100;

interface Finding {
  userId: number;
  email: string;
  customerId: string;
  cards: number;
  stripeDefault: string | null;
  localDefault: string | null;
  wouldSet: string | null;
  reason: string;
}

const readStripeDefaultId = (customer: any): string | null => {
  const existing = customer?.invoice_settings?.default_payment_method;
  if (!existing) return null;
  return typeof existing === 'string' ? existing : existing.id ?? null;
};

async function scan(apply: boolean): Promise<{ findings: Finding[]; scanned: number; errors: number }> {
  const findings: Finding[] = [];
  let scanned = 0;
  let errors = 0;
  let afterId = 0;

  // Paged by id rather than OFFSET: an OFFSET walk over a table that is being
  // written to skips and repeats rows.
  for (;;) {
    const users = await sql`
      SELECT id, email, stripe_customer_id, default_payment_method_id
      FROM   users
      WHERE  stripe_customer_id IS NOT NULL
        AND  id > ${afterId}
      ORDER  BY id
      LIMIT  ${PAGE_SIZE}
    `;
    if (users.length === 0) break;
    afterId = users[users.length - 1].id;

    for (const user of users as any[]) {
      scanned++;
      try {
        const [customer, cardList] = await Promise.all([
          stripe.customers.retrieve(user.stripe_customer_id),
          stripe.paymentMethods.list({ customer: user.stripe_customer_id, type: 'card' }),
        ]);
        const attached = (cardList as any).data ?? [];
        const stripeDefault = readStripeDefaultId(customer);
        const localDefault = user.default_payment_method_id ?? null;

        const stripeDefaultAttached = !!stripeDefault && attached.some((pm: any) => pm.id === stripeDefault);
        const localMatchesStripe = !!localDefault && localDefault === stripeDefault;

        // Healthy: Stripe has a default, it points at a live card, and we agree.
        if (stripeDefaultAttached && localMatchesStripe) continue;

        // Nothing to do for a customer with no cards and no stale local record.
        if (attached.length === 0 && !localDefault) continue;

        const chosen = chooseDefaultPaymentMethod({
          attached,
          stripeDefaultId: stripeDefault,
          localDefaultId: localDefault,
        });

        const reason =
          attached.length === 0 ? 'local default points at a card that is no longer attached'
            : !stripeDefault ? 'cards on file but no default at the provider'
              : !stripeDefaultAttached ? 'provider default points at a detached card'
                : 'provider default not recorded locally';

        findings.push({
          userId: user.id,
          email: user.email,
          customerId: user.stripe_customer_id,
          cards: attached.length,
          stripeDefault,
          localDefault,
          wouldSet: chosen?.id ?? null,
          reason,
        });

        if (apply) {
          await ensureDefaultPaymentMethod({ sql, stripe }, user.id, user.stripe_customer_id);
        }
      } catch (err: any) {
        errors++;
        // One unreachable customer must not abort a backfill of thousands.
        console.error(`  ! user ${user.id} (${user.email}): ${err?.message ?? err}`);
      }
    }
  }

  return { findings, scanned, errors };
}

async function main() {
  const apply = process.argv.includes('--apply');

  console.log(apply
    ? '⚠️  APPLY MODE — this will write to Stripe and to the database.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply to make these changes.\n');

  const { findings, scanned, errors } = await scan(apply);

  console.log(`Scanned ${scanned} account(s) with a Stripe customer.`);
  console.log(`${findings.length} would be changed${apply ? ' (and were)' : ''}.`);
  if (errors) console.log(`${errors} account(s) could not be checked — see errors above.`);

  if (findings.length > 0) {
    console.log('\n user | cards | provider default | local default | would set | reason');
    console.log('------+-------+------------------+---------------+-----------+--------');
    for (const f of findings) {
      console.log(
        ` ${String(f.userId).padStart(4)} | ${String(f.cards).padStart(5)} | ` +
        `${(f.stripeDefault ?? '—').padEnd(16)} | ${(f.localDefault ?? '—').padEnd(13)} | ` +
        `${(f.wouldSet ?? '—').padEnd(9)} | ${f.reason}`,
      );
    }
  }

  // Grouped counts make the summary readable when the list is long.
  const byReason = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.reason] = (acc[f.reason] ?? 0) + 1;
    return acc;
  }, {});
  if (Object.keys(byReason).length > 0) {
    console.log('\nBy reason:');
    for (const [reason, count] of Object.entries(byReason)) console.log(`  ${count} × ${reason}`);
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
