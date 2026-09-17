/**
 * Migration 021 — one Stripe product per plan, named after the plan
 *
 *   npm run migrate:plan-stripe-products   (needs DATABASE_URL, STRIPE_SECRET_KEY
 *                                           and the ISEO_* credit config)
 *
 * WHY
 * Checkout titles a subscription "Subscribe to <product name>". Every plan price
 * — Grow, Optimize and Scale, monthly and yearly — was created under ONE product,
 * "ImproveSEO Subscription", so choosing Grow showed "Subscribe to ImproveSEO
 * Subscription / Subsciption For improve seo". QA asked for the plan's name and
 * what it gives. See services/billing/plan-product.ts for the copy.
 *
 * WHY NEW PRICES, NOT A RENAME
 * A price's product cannot be changed after creation, and renaming the shared
 * product can only give all three plans the same name. So each plan gets its
 * own product, and new monthly/yearly prices on it with the SAME amount and
 * interval. subscription_plans then points at the new prices, so every new
 * Checkout, subscribe-to-plan and change-plan uses them.
 *
 * EXISTING SUBSCRIBERS ARE UNTOUCHED
 * Their subscriptions keep billing on the old prices, which stay ACTIVE — an
 * archived price still bills, but nothing here needs to archive it. The old ids
 * are kept in `legacy_stripe_price_ids`, so a lookup from a subscription's price
 * to its plan (nameChangeGroups) still recognises them. Their next plan change
 * moves them onto the new prices like anyone else.
 *
 * IDEMPOTENT, AND RE-RUNNABLE ON PURPOSE
 * A plan whose monthly price already sits on its own product (product metadata
 * plan_slug matches) only has that product's name and description refreshed —
 * so after a change to the credit grants or the cost table, running this again
 * brings the "about N pieces" text on Stripe back in line. A product created by
 * an interrupted earlier run is found by metadata and reused, not duplicated.
 *
 * Only the ALTER below is plain SQL. The rest needs Stripe, so pasting
 * MIGRATION_SQL alone is harmless but does not change what Checkout shows.
 */
import sql from '../data/db.js';
import Stripe from 'stripe';
import { grantForPlanSlug, piecesForCredits } from '../config/credits.config.js';
import { planProductCopy } from '../services/billing/plan-product.js';

export const MIGRATION_SQL = `
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS legacy_stripe_price_ids TEXT[] NOT NULL DEFAULT '{}';
`;

export interface MigrationResult {
  productsCreated: number;
  productsRefreshed: number;
  pricesCreated: number;
}

type PlanRow = {
  id: number;
  slug: string;
  name: string;
  stripe_price_id: string | null;
  stripe_price_id_yearly: string | null;
};

const productIdOf = (price: Stripe.Price): string =>
  typeof price.product === 'string' ? price.product : price.product.id;

/** A copy of `source` on `productId`: same amount, currency and billing interval. */
const clonePrice = (stripe: Stripe, source: Stripe.Price, productId: string, plan: PlanRow) => {
  if (!source.recurring || source.unit_amount == null) {
    throw new Error(`${plan.name}: price ${source.id} is not a fixed recurring price; not cloned.`);
  }
  return stripe.prices.create({
    product: productId,
    currency: source.currency,
    unit_amount: source.unit_amount,
    recurring: {
      interval: source.recurring.interval,
      interval_count: source.recurring.interval_count,
    },
    ...(source.tax_behavior ? { tax_behavior: source.tax_behavior } : {}),
    nickname: source.nickname ?? undefined,
    metadata: {
      plan_id: String(plan.id),
      plan_slug: plan.slug,
      interval: source.recurring.interval,
      replaces_price: source.id,
    },
  });
};

export async function up(): Promise<MigrationResult> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2025-10-29.clover' });

  await sql.unsafe(MIGRATION_SQL);

  const plans = (await sql`
    SELECT id, slug, name, stripe_price_id, stripe_price_id_yearly
    FROM   subscription_plans
    WHERE  price_cents > 0
    ORDER  BY price_cents
  `) as unknown as PlanRow[];

  const result: MigrationResult = { productsCreated: 0, productsRefreshed: 0, pricesCreated: 0 };

  for (const plan of plans) {
    if (!plan.stripe_price_id) {
      console.warn(`⚠️  ${plan.name} has no monthly Stripe price; skipped.`);
      continue;
    }

    const credits = grantForPlanSlug(plan.slug);
    const copy = planProductCopy({
      slug: plan.slug, name: plan.name, credits, pieces: piecesForCredits(credits),
    });

    const monthly = await stripe.prices.retrieve(plan.stripe_price_id, { expand: ['product'] });
    const currentProduct = monthly.product as Stripe.Product;

    // Already on its own product: refresh the copy and stop.
    if (currentProduct.metadata?.plan_slug === plan.slug) {
      await stripe.products.update(currentProduct.id, copy);
      result.productsRefreshed += 1;
      console.log(`✅ ${copy.name}: product ${currentProduct.id} copy refreshed`);
      continue;
    }

    // Reuse a product an interrupted run already created for this plan.
    const existing = (await stripe.products.list({ active: true, limit: 100 })).data
      .find((p) => p.metadata?.plan_slug === plan.slug);
    const product = existing
      ? await stripe.products.update(existing.id, copy)
      : await stripe.products.create({
        ...copy,
        metadata: { plan_id: String(plan.id), plan_slug: plan.slug },
      });
    if (!existing) result.productsCreated += 1;

    const newMonthly = await clonePrice(stripe, monthly, product.id, plan);
    result.pricesCreated += 1;

    let newYearlyId: string | null = plan.stripe_price_id_yearly;
    if (plan.stripe_price_id_yearly) {
      const yearly = await stripe.prices.retrieve(plan.stripe_price_id_yearly);
      if (productIdOf(yearly) === product.id) {
        newYearlyId = yearly.id;
      } else {
        newYearlyId = (await clonePrice(stripe, yearly, product.id, plan)).id;
        result.pricesCreated += 1;
      }
    }

    const retired = [plan.stripe_price_id, plan.stripe_price_id_yearly]
      .filter((id): id is string => !!id && id !== newMonthly.id && id !== newYearlyId);

    await sql`
      UPDATE subscription_plans
      SET    stripe_price_id         = ${newMonthly.id},
             stripe_price_id_yearly  = ${newYearlyId},
             legacy_stripe_price_ids = (
               SELECT ARRAY(SELECT DISTINCT unnest(legacy_stripe_price_ids || ${retired}::text[]))
             )
      WHERE  id = ${plan.id}
    `;

    console.log(
      `✅ ${copy.name}: product ${product.id}, monthly ${newMonthly.id}`
      + (newYearlyId ? `, yearly ${newYearlyId}` : '')
      + ` (old prices kept for existing subscribers: ${retired.join(', ') || 'none'})`,
    );
  }

  return result;
}

if (process.argv[1] && process.argv[1].includes('021-plan-stripe-products')) {
  up()
    .then((r) => { console.log('✅ Migration 021 complete:', r); process.exit(0); })
    .catch((e) => { console.error('❌ Migration 021 failed:', e); process.exit(1); });
}
