/**
 * Migration 020 — website_limit: Grow 3, Optimize 5
 *
 *   npm run migrate:website-limits-v2      (needs DATABASE_URL, same as the server)
 *
 * WHAT THIS CHANGES
 * The product now sells these website allowances:
 *
 *   Basic / free trial   1          (unchanged)
 *   Grow      'basic'    3          (was 2, set by migration 015)
 *   Optimize  'starter'  5          (was 3, set by migration 015)
 *   Scale     'pro'      unlimited  (NULL, unchanged)
 *
 * `website_limit` is ENFORCED — adding a site past it fails in
 * websites.routes.ts, in addUserWebsite, and in the plugin connect flow in
 * auth.routes.ts — and the CMS plan cards and website-limit dialog read the
 * same column. So this one update is what makes the advertised figures true.
 *
 * NO CUSTOMER IS PUT OVER THEIR LIMIT
 * Both limits only go UP, so no account can end up holding more sites than its
 * plan allows as a result of this.
 *
 * KEYED BY SLUG, NOT BY CURRENT VALUE
 * The result is the same however many times it runs, and does not depend on the
 * values it replaces. 'free' keeps 1 and 'pro' keeps NULL; neither is touched.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
UPDATE subscription_plans SET website_limit = 3 WHERE slug = 'basic';
UPDATE subscription_plans SET website_limit = 5 WHERE slug = 'starter';
`;

export async function up(): Promise<{ limits: Array<{ slug: string; website_limit: number | null }> }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT slug, website_limit FROM subscription_plans ORDER BY price_cents
  `;
  return { limits: rows as any };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('020-plan-website-limits-v2');
if (invokedDirectly) {
  up()
    .then(async ({ limits }) => {
      console.log('✅ Migration 020 applied. Website limits are now:');
      for (const l of limits) {
        console.log(`   ${l.slug.padEnd(8)} ${l.website_limit ?? 'unlimited'}`);
      }
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 020 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
