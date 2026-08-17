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
 * A transient failure here must not stop the server booting — prices come from env, so only the
 * legacy display columns would go stale. The ONE exception is the plan-coverage check below, which
 * is deliberately fatal: see the comment on it.
 */
import sql from '../../data/db.js';
import { grantForPlanSlug, hasExplicitGrant } from '../../config/credits.config.js';

export async function syncPlanCreditColumns(): Promise<number> {
  const plans = (await sql`
    SELECT id, slug, price_cents FROM subscription_plans
  `) as unknown as Array<{ id: number; slug: string; price_cents: number }>;

  // ── Plan-coverage check ──────────────────────────────────────────────────────────────────────
  // grantForPlanSlug() falls back to the FREE grant for an unrecognised slug, which keeps the
  // service up when a plan row appears — but silently under-grants that plan's customers. That is
  // exactly how ISEO_GRANT_{GROW,SCALE,ENTERPRISE} shipped against a database whose slugs were
  // free/basic/starter/pro: only 'free' matched, and every paying customer would have been seeded
  // with the free allotment.
  //
  // A PAID plan with no explicit grant is therefore treated the same way as a missing price:
  // refuse to start. Under-charging a paying customer's allotment is a money bug, and a loud
  // failure at boot is far cheaper than discovering it after a migration has reset balances.
  // Zero-price plans only warn — falling back to the free grant IS correct for them.
  const uncovered = plans.filter((p) => !hasExplicitGrant(p.slug));
  const uncoveredPaid = uncovered.filter((p) => Number(p.price_cents) > 0);

  if (uncoveredPaid.length > 0) {
    const lines = uncoveredPaid
      .map((p) => `  - plan "${p.slug}" (${p.price_cents} cents) needs ISEO_GRANT_${p.slug.toUpperCase()}`)
      .join('\n');
    throw new Error(
      `Paid subscription plan(s) have no ISEO credit grant configured — refusing to start.\n${lines}\n` +
        `Without these, those customers would be seeded with the FREE grant. Add the variable(s) and redeploy.`,
    );
  }

  for (const p of uncovered) {
    console.warn(`⚠️  Plan "${p.slug}" has no ISEO_GRANT_${p.slug.toUpperCase()} — using the free grant (price is 0, so this is expected).`);
  }

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

/**
 * Boot hook. Throws ONLY when a paid plan has no configured grant (see syncPlanCreditColumns);
 * every other failure is logged and tolerated.
 */
export async function startPlanCreditSync(): Promise<void> {
  try {
    const n = await syncPlanCreditColumns();
    console.log(`💳 Synced env credit grants into ${n} subscription plan row(s).`);
  } catch (err) {
    // A coverage failure is deliberate and must reach the caller so boot aborts — swallowing it
    // would defeat the check. Anything else (a transient DB error) only leaves the legacy display
    // columns stale, which must not stop the server: pricing comes from env, not those columns.
    if (err instanceof Error && err.message.includes('no ISEO credit grant configured')) {
      throw err;
    }
    console.error(
      '⚠️  Plan credit column sync failed — legacy *_credits columns may be stale. ' +
        'Pricing is unaffected (env is the source of truth).',
      err,
    );
  }
}
