/**
 * Migration 013 — yearly billing alongside monthly
 *
 *   npm run migrate:yearly-plans      (needs DATABASE_URL and STRIPE_SECRET_KEY)
 *
 * WHY TWO COLUMNS AND NOT TWO ROWS
 * A yearly option is the same PLAN billed on a different interval — same credit
 * grant, same features, same slug. Modelling it as a second subscription_plans
 * row would fork every join on plan_id, double the grant table
 * (ISEO_GRANT_BASIC vs ISEO_GRANT_BASIC_YEARLY), and make "is this an upgrade?"
 * compare a monthly price against a yearly one — which is how a customer moving
 * from Grow-monthly to Optimize-yearly gets classified as a downgrade and
 * silently scheduled for the end of the period.
 *
 * One row, two prices. The interval is a property of the SUBSCRIPTION, not of
 * the plan, which is also how Stripe models it.
 *
 * THE DISCOUNT
 * Yearly is priced at (12 - ISEO_YEARLY_FREE_MONTHS) x the monthly price, i.e.
 * the conventional "two months free" by default. It is config, not a literal,
 * because it is a revenue decision that should not need a code change.
 *
 * STRIPE PRICES
 * Created here if absent, against the SAME product as the monthly price, so the
 * two appear as one product with two prices in the dashboard rather than as
 * unrelated line items. Idempotent: a plan that already has a yearly price id
 * is skipped.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';

const YEARLY_FREE_MONTHS = Number(process.env.ISEO_YEARLY_FREE_MONTHS || 2);

export interface MigrationResult {
  columnsAdded: boolean;
  pricesCreated: number;
  skipped: number;
}

export async function up(): Promise<MigrationResult> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2025-10-29.clover' });

  await sql`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price_cents_yearly INTEGER`;
  await sql`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id_yearly TEXT`;

  // Which interval a subscription is actually billed on. Recorded rather than
  // inferred from the price id, so the plan grid can open on the right side of
  // the toggle without a Stripe round trip — and so an annual customer is never
  // shown monthly prices as though that were their plan.
  //
  // Defaults to 'month': every subscription that exists today is monthly, and
  // that is the honest backfill.
  await sql`
    ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'month'
  `;
  await sql`
    ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_interval_check
  `;
  await sql`
    ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_billing_interval_check
    CHECK (billing_interval IN ('month', 'year'))
  `;

  const plans = (await sql`
    SELECT id, slug, name, price_cents, stripe_price_id, stripe_price_id_yearly
    FROM   subscription_plans
    WHERE  price_cents > 0
    ORDER  BY price_cents ASC
  `) as unknown as Array<{
    id: number; slug: string; name: string; price_cents: number;
    stripe_price_id: string | null; stripe_price_id_yearly: string | null;
  }>;

  let created = 0;
  let skipped = 0;

  for (const plan of plans) {
    const yearlyCents = plan.price_cents * (12 - YEARLY_FREE_MONTHS);

    if (plan.stripe_price_id_yearly) {
      // Keep the cents column in step even when the price already exists, so a
      // changed discount is reflected in what we DISPLAY — the Stripe price is
      // immutable once created, so a real price change needs a new price id and
      // is deliberately not something this migration does silently.
      await sql`UPDATE subscription_plans SET price_cents_yearly = ${yearlyCents} WHERE id = ${plan.id}`;
      skipped += 1;
      continue;
    }

    if (!plan.stripe_price_id) {
      console.warn(`⚠️  ${plan.name} has no monthly Stripe price; skipping its yearly price.`);
      skipped += 1;
      continue;
    }

    // Reuse the monthly price's PRODUCT so both intervals belong to one product.
    const monthly = await stripe.prices.retrieve(plan.stripe_price_id);
    const price = await stripe.prices.create({
      product: monthly.product as string,
      currency: monthly.currency,
      unit_amount: yearlyCents,
      recurring: { interval: 'year' },
      nickname: `${plan.name} — yearly`,
      metadata: { plan_id: String(plan.id), plan_slug: plan.slug, interval: 'year' },
    });

    await sql`
      UPDATE subscription_plans
      SET    price_cents_yearly = ${yearlyCents}, stripe_price_id_yearly = ${price.id}
      WHERE  id = ${plan.id}
    `;
    created += 1;
    console.log(`✅ ${plan.name}: yearly ${(yearlyCents / 100).toFixed(2)} → ${price.id}`);
  }

  return { columnsAdded: true, pricesCreated: created, skipped };
}

if (process.argv[1] && process.argv[1].includes('013-yearly-plans')) {
  up()
    .then((r) => { console.log('✅ Migration 013 complete:', r); process.exit(0); })
    .catch((e) => { console.error('❌ Migration 013 failed:', e); process.exit(1); });
}
