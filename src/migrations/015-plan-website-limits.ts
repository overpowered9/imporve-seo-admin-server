/**
 * Migration 015 — subscription_plans.website_limit for Grow and Optimize
 *
 *   npm run migrate:website-limits      (needs DATABASE_URL, same as the server)
 *
 * WHAT THIS FIXES
 * The plan cards now render the website allowance from `website_limit` instead
 * of printing a literal, because that column is ENFORCED — adding a site past
 * it fails in websites.routes.ts and in the plugin connect flow in
 * auth.routes.ts, both with "Your plan allows N websites."
 *
 * The product spec says Grow connects 2 websites and Optimize 3. The database
 * said 3 and 7. Whichever way that gap is closed, the card and the error
 * message have to agree; this closes it on the database side, as specified.
 *
 * NO CUSTOMER IS PUT OVER THEIR LIMIT
 * Checked before writing this: no account on Grow or Optimize has any websites
 * at all, and every multi-site account is on Pro, which is unlimited. So this
 * cannot strand an existing site above a newly lowered ceiling. Re-check with:
 *
 *   SELECT sp.slug, COUNT(w.id)
 *     FROM users u
 *     JOIN subscription_plans sp ON sp.id = u.plan_id
 *     LEFT JOIN websites w ON w.user_id = u.id AND w.active = true
 *    WHERE sp.slug IN ('basic','starter')
 *    GROUP BY u.id, sp.slug HAVING COUNT(w.id) > 2;
 *
 * Note the enforcement is on ADDING a site, not on holding one, so an account
 * already above the limit would keep its sites and simply be unable to add
 * more. That is the gentle failure, but it is still worth knowing about.
 *
 * KEYED BY SLUG, NOT BY CURRENT VALUE
 * So the result is the same however many times it runs, and so it does not
 * depend on the values it is replacing. 'pro' keeps NULL (unlimited) and 'free'
 * keeps 1; neither is touched.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
UPDATE subscription_plans SET website_limit = 2 WHERE slug = 'basic';
UPDATE subscription_plans SET website_limit = 3 WHERE slug = 'starter';
`;

export async function up(): Promise<{ limits: Array<{ slug: string; website_limit: number | null }> }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT slug, website_limit FROM subscription_plans ORDER BY price_cents
  `;
  return { limits: rows as any };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('015-plan-website-limits');
if (invokedDirectly) {
  up()
    .then(async ({ limits }) => {
      console.log('✅ Migration 015 applied. Website limits are now:');
      for (const l of limits) {
        console.log(`   ${l.slug.padEnd(8)} ${l.website_limit ?? 'unlimited'}`);
      }
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 015 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
