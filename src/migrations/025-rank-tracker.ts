/**
 * Migration 025 — rank tracker (what we told people to write, and whether it worked)
 *
 *   npm run migrate:rank-tracker      (needs DATABASE_URL, same as the server)
 *
 * WHY THIS EXISTS
 * The Keyword Finder's whole promise is "write this and you will rank". Nothing in the system
 * checked whether that ever came true. These two tables close the loop: a target is a keyword we
 * are watching for one domain, and the history is every position we have seen for it.
 *
 * WHY HISTORY IS APPEND-ONLY
 * A single current position is nearly worthless — "position 14" means nothing without "it was 31
 * last month". Every check is kept, so the tracker can answer the only question that matters:
 * is this moving, and since when. Rows are small and checks are weekly, so growth is slow.
 *
 * A position of NULL means "not found in the results we looked at", which is different from
 * position 100. The same rule as everywhere else in this feature: never store a guess as a fact.
 *
 * ROW LEVEL SECURITY
 * As with 022: only the server touches these over its direct Postgres connection as the table
 * owner, which RLS does not apply to. Enabling RLS with no policies closes them to Supabase's
 * public REST API, where the anon key would otherwise read or poison them.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS keyword_rank_targets (
  id             BIGSERIAL   PRIMARY KEY,
  domain         TEXT        NOT NULL,
  keyword        TEXT        NOT NULL,
  location_code  INTEGER     NOT NULL DEFAULT 2840,
  language_code  TEXT        NOT NULL DEFAULT 'en',
  label          TEXT,
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  UNIQUE (domain, keyword, location_code, language_code)
);

CREATE INDEX IF NOT EXISTS keyword_rank_targets_due_idx
  ON keyword_rank_targets (active, last_checked_at);

CREATE TABLE IF NOT EXISTS keyword_rank_history (
  id                 BIGSERIAL   PRIMARY KEY,
  target_id          BIGINT      NOT NULL REFERENCES keyword_rank_targets(id) ON DELETE CASCADE,
  checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL means "not found on the page we looked at", which is not the same as a bad position.
  position           INTEGER     CHECK (position IS NULL OR position > 0),
  ranking_url        TEXT,
  serp_organic_count INTEGER,
  shopping_units     INTEGER,
  ugc_results        INTEGER,
  cost_usd           NUMERIC(10, 6)
);

CREATE INDEX IF NOT EXISTS keyword_rank_history_target_idx
  ON keyword_rank_history (target_id, checked_at DESC);

ALTER TABLE keyword_rank_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_rank_history ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations (id) VALUES ('025-rank-tracker') ON CONFLICT (id) DO NOTHING;
`;

/** Reverses 025. Dropping these loses the rank history, which cannot be refetched from anywhere. */
export const DOWN_SQL = `
DROP TABLE IF EXISTS keyword_rank_history;
DROP TABLE IF EXISTS keyword_rank_targets;
DELETE FROM schema_migrations WHERE id = '025-rank-tracker';
`;

export async function up(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('025-rank-tracker');
if (invokedDirectly) {
  up()
    .then(async () => {
      console.log('✅ Migration 025 applied: keyword_rank_targets and keyword_rank_history created (or already existed).');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 025 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
