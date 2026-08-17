/**
 * Keep subscription_plans.{image,content,keyword}_credits in step with the env grants.
 *
 * Those three columns are no longer the source of truth — ISEO_GRANT_<SLUG> is (see
 * config/credits.config.ts). But they are still READ in places that would be disruptive to change
 * at the same time as the pool collapse:
 *
 *   - Stripe checkout/session descriptions (routes/stripe.routes.ts) render "N content credits"
 *     into text a customer sees on their card statement flow;
 *   - the CMS and admin frontend join on them to show plan comparison tables.
 *
 * Rather than rewrite all of that at once, the columns become DERIVED: this runs at boot and
 * writes the env grant into all three, so anything still reading them sees the real number. Each
 * remaining read site is commented as read-only.
 *
 * Writing the same value into all three is deliberate — there is one pool now, so "content
 * credits" and "image credits" are the same balance seen from different labels. It keeps legacy
 * displays truthful (they show what the user actually has) rather than showing a third of it.
 *
 * Best-effort: a failure here must not stop the server booting. Prices still come from env, which
 * is already loaded and validated; only the legacy display columns would be stale.
 */
import sql from '../../data/db.js';
import { grantForPlanSlug } from '../../config/credits.config.js';

export async function syncPlanCreditColumns(): Promise<number> {
  const plans = (await sql`
    SELECT id, slug FROM subscription_plans
  `) as unknown as Array<{ id: number; slug: string }>;

  let updated = 0;
  for (const plan of plans) {
    const grant = grantForPlanSlug(plan.slug);
    await sql`
      UPDATE subscription_plans
      SET image_credits   = ${grant},
          content_credits = ${grant},
          keyword_credits = ${grant}
      WHERE id = ${plan.id}
    `;
    updated += 1;
  }
  return updated;
}

/** Boot hook. Never throws — logs and moves on. */
export async function startPlanCreditSync(): Promise<void> {
  try {
    const n = await syncPlanCreditColumns();
    console.log(`💳 Synced env credit grants into ${n} subscription plan row(s).`);
  } catch (err) {
    console.error(
      '⚠️  Plan credit column sync failed — legacy *_credits columns may be stale. ' +
        'Pricing is unaffected (env is the source of truth).',
      err,
    );
  }
}
