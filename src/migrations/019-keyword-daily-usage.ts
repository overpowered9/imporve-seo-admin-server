/**
 * Migration 019 — keyword_daily_usage (daily Keyword Generator allowance)
 *
 *   npm run migrate:keyword-daily-usage      (needs DATABASE_URL, same as the server)
 *
 * WHY THIS EXISTS
 * The Keyword Generator tool has a per-plan daily allowance — Free Trial/Free 10 runs, Grow 20,
 * Optimize and Scale 50 (config/keyword-limits.config.ts). It is enforced by a single conditional
 * upsert (models/keyword-usage.ts) so two clicks landing together cannot both take the last slot,
 * and that needs one row per (user, UTC day) with a key to conflict on. Counting today's
 * user_generations rows instead would be a read-then-write race, on a table with no index on
 * (user_id, type, created_at).
 *
 * SAFE TO DEPLOY THE CODE FIRST
 * Until this table exists the server fails OPEN: keyword runs go through uncapped (still
 * credit-charged) and each one logs `[keyword-allowance]`. Nothing breaks in the gap.
 *
 * ROW LEVEL SECURITY
 * Only the server reads or writes this table, over its direct Postgres connection as the table
 * owner, which RLS does not apply to. Enabling RLS with no policies closes the table to Supabase's
 * public REST API, where the anon key would otherwise be able to read or reset the counters.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS keyword_daily_usage (
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date  DATE        NOT NULL,
  used        INTEGER     NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE keyword_daily_usage ENABLE ROW LEVEL SECURITY;
`;

export async function up(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('019-keyword-daily-usage');
if (invokedDirectly) {
  up()
    .then(async () => {
      console.log('✅ Migration 019 applied: keyword_daily_usage created (or already existed).');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 019 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
