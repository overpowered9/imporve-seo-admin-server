/**
 * What a plan is called on Stripe's own pages.
 *
 * Stripe Checkout titles a subscription "Subscribe to <product name>" and prints
 * the product description under the price; invoices and receipt emails use the
 * same name. Every plan price used to hang off ONE shared product, "ImproveSEO
 * Subscription" / "Subsciption For improve seo", so a customer choosing Grow saw
 * neither the plan they picked nor what it gives them. QA asked for:
 *
 *   Subscribe to the Grow plan
 *   $9.50 per month
 *   You will receive 220 credits per month, which equals about N pieces of
 *   local SEO content with AI image.
 *
 * ── "Grow plan", NOT "the Grow plan" ────────────────────────────────────────
 * Stripe supplies "Subscribe to" itself, and the product name is also the line
 * item on every invoice and receipt, where "1 × the Grow plan" reads as a typo.
 *
 * The caller passes the grant and piece count from credits.config
 * (grantForPlanSlug, piecesForCredits) — the same figures the CMS plan cards
 * show — so the Stripe copy cannot quote a different number. Kept pure, rather
 * than importing that fail-closed config here, so it tests without the ISEO_*
 * environment. Re-running migration 021 after a grant or price change rewrites
 * the copy on Stripe.
 */
import { planLabel } from './descriptions.js';

export interface PlanProductCopy {
  name: string;
  description: string;
}

export const planProductCopy = (plan: {
  slug: string;
  name?: string | null;
  /** Monthly credit grant for the plan. */
  credits: number;
  /** piecesForCredits(credits). */
  pieces: number;
}): PlanProductCopy => {
  // The slug is stable and mapped to the name customers know; a slug with no
  // mapping comes back as itself, and then the plan's own name reads better.
  const fromSlug = planLabel(plan.slug);
  const label = (fromSlug !== plan.slug ? fromSlug : planLabel(plan.name)) || plan.slug;
  const { credits, pieces } = plan;
  return {
    name: `${label} plan`,
    description:
      `You will receive ${credits.toLocaleString('en-US')} credits per month, which equals about`
      + ` ${pieces} piece${pieces === 1 ? '' : 's'} of local SEO content with AI image.`,
  };
};
