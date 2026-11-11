/**
 * Migration 022 — keyword data cache (DataForSEO Labs metrics and related keywords)
 *
 *   npm run migrate:keyword-data-cache      (needs DATABASE_URL, same as the server)
 *
 * WHY THIS EXISTS
 * Every DataForSEO call costs money, and the same keyword is looked up again and again: by the
 * plugin's keyword tool (POST /generate/keywords/metrics), by the v3 prefetch, and by the Title and
 * Planner steps. Search volume moves slowly, so a fetched keyword is kept for 30 days
 * (config/keyword-data.config.ts) and served from here first. Two tables, because the two facets
 * are filled by different calls: a bulk metrics request fills keyword_metrics_cache only, while a
 * prefetch also fills keyword_related_cache for its seed.
 *
 * KEY: (keyword lower-cased and trimmed, location_code, language_code) — see normalizeKeyword().
 * TTL: expires_at; reads filter on it, so an expired row is simply a miss until it is refreshed.
 *
 * SAFE TO DEPLOY THE CODE FIRST
 * Until these tables exist the cache fails OPEN: every read is a miss, every write is skipped, and
 * each logs `[keyword-data] cache unavailable`. Keyword data still works; it just pays DataForSEO
 * each time.
 *
 * ROW LEVEL SECURITY
 * Only the server reads or writes these tables, over its direct Postgres connection as the table
 * owner, which RLS does not apply to. Enabling RLS with no policies closes them to Supabase's
 * public REST API, where the anon key would otherwise be able to read or poison the cache.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS keyword_metrics_cache (
  keyword            TEXT        NOT NULL,
  location_code      INTEGER     NOT NULL,
  language_code      TEXT        NOT NULL,
  search_volume      INTEGER,
  keyword_difficulty INTEGER     CHECK (keyword_difficulty IS NULL OR (keyword_difficulty BETWEEN 0 AND 100)),
  intent             TEXT,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (keyword, location_code, language_code)
);

CREATE INDEX IF NOT EXISTS keyword_metrics_cache_expires_idx ON keyword_metrics_cache (expires_at);

ALTER TABLE keyword_metrics_cache ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS keyword_related_cache (
  seed               TEXT        NOT NULL,
  location_code      INTEGER     NOT NULL,
  language_code      TEXT        NOT NULL,
  related            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (seed, location_code, language_code)
);

CREATE INDEX IF NOT EXISTS keyword_related_cache_expires_idx ON keyword_related_cache (expires_at);

ALTER TABLE keyword_related_cache ENABLE ROW LEVEL SECURITY;
`;

export async function up(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('022-keyword-data-cache');
if (invokedDirectly) {
  up()
    .then(async () => {
      console.log('✅ Migration 022 applied: keyword_metrics_cache and keyword_related_cache created (or already existed).');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 022 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
