/**
 * Migration 018 — index on websites.domain
 *
 *   npm run migrate:websites-domain-index      (needs DATABASE_URL, same as the server)
 *
 * WHY THIS EXISTS
 * touchWebsiteConnection now runs a same-domain, cross-account lookup every
 * time it actually stamps a connection (see user.models.ts) — up to once per
 * 5 minutes per active site, across the whole fleet — to supersede any OTHER
 * account's stale row for the same domain. `websites.domain` has never had an
 * index, so that query was a sequential scan on a table every plugin request
 * touches. This is a direct prerequisite of that fix, not a separate
 * optimisation.
 *
 * `CREATE INDEX IF NOT EXISTS`, not `CONCURRENTLY` — this table is nowhere
 * near the size where a brief write-lock while it builds would be noticeable.
 * If `websites` ever grows large enough for that to matter, CONCURRENTLY
 * would need to run outside a transaction via sql.unsafe with its own
 * connection, not through this runner.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_websites_domain ON websites (domain);
`;

export async function up(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('018-websites-domain-index');
if (invokedDirectly) {
  up()
    .then(async () => {
      console.log('✅ Migration 018 applied: idx_websites_domain created (or already existed).');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 018 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
