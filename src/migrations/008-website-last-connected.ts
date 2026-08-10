/**
 * Migration 008 — websites.last_connected_at
 *
 * (Numbered 008, not 004: the in-flight billing branch already reserves
 * 004–007, so reusing 004 would collide the moment the two branches merge.)
 *
 *   npm run migrate:website-connect      (needs DATABASE_URL, same as the server)
 *
 * Gives the CMS a real answer to "is this site connected?".
 *
 * WHAT WAS WRONG
 * The CMS had no connection signal at all, so utils/websiteStatus.js inferred one
 * from `user_generations`: a site counted as connected once it had produced
 * content. That makes a correctly-connected site read "Not Connected" until its
 * first article — which is exactly the client complaint this fixes. `site_code`
 * cannot stand in either: it is minted when the site is ADDED, long before the
 * plugin has been installed, so its presence proves nothing about the plugin.
 *
 * WHY A COLUMN ON `websites` RATHER THAN A NEW TABLE
 * The question is per-site and single-valued — "when did this site last prove it
 * holds valid credentials?" — so there is exactly one row's worth of state per
 * website and no history to keep. A join table would buy nothing and would put a
 * second definition of "connected" in the schema, which is the drift this whole
 * change is trying to remove.
 *
 * WHO WRITES IT
 * validateApiAccess (middleware/apiAuth.middleware.ts), once it has proven BOTH
 * the api_key and the site_code and confirmed the site belongs to that user —
 * i.e. precisely the client's definition of "API Key and site code were
 * successfully saved". Every plugin route goes through that middleware, so the
 * plugin's "Test Server Connection" call (GET /users/status) stamps it too.
 *
 * NULLABLE ON PURPOSE
 * NULL means "this site has never checked in". Backfilling it (say, from the
 * first generation's timestamp) would invent a connection event that never
 * happened; the CMS already ORs this against the generations signal, so existing
 * Active sites keep their status without a backfill.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
ALTER TABLE websites
  ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ;

-- Serves the per-account website list, which is the only read path that cares:
-- it filters by user_id and now surfaces this column alongside it.
CREATE INDEX IF NOT EXISTS idx_websites_user_last_connected
  ON websites (user_id, last_connected_at DESC);
`;

export async function up(): Promise<{ connected: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM websites WHERE last_connected_at IS NOT NULL
  `;
  return { connected: Number((rows as any[])[0]?.n ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('008-website-last-connected');
if (invokedDirectly) {
  up()
    .then(async ({ connected }) => {
      console.log(`✅ Migration 008 applied. ${connected} website(s) have checked in so far.`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 008 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
