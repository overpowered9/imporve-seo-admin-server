/**
 * Migration 023 — Content v3 session store and per-post history
 *
 *   npm run migrate:content-v3-store      (needs DATABASE_URL, same as the server)
 *   or paste the output of `npm run --silent migrations:print` into the Supabase SQL editor.
 *
 * content_v3_sessions (OPS5, W10, W12, W14, S9, R8)
 *   One row per wizard session: everything the chain produced before Submit, so Regenerate title,
 *   Regenerate Content and Change Image reuse it instead of paying for it again (search data,
 *   titles already shown, research, the plan, owner answers, blueprint picks). Keyed by the
 *   opaque per-wizard key the plugin already mints (#iseo_target_key, migration 010), scoped to
 *   the user AND the website so one site can never read another's session.
 *   Deleted when the user leaves the wizard (W10) and when the post is submitted; abandoned rows
 *   expire after CONTENT_V3_SESSION_TTL_DAYS (default 7) and are purged by the server.
 *
 * content_v3_posts (B4, B9, B12, G6, V11)
 *   One row per generated v3 article: the blueprint picks, the structure fingerprint, the body
 *   headings, the article type, the final proof level and the validator report. The blueprint's
 *   history rules read the site's last 20 rows (no exact repeat of the last 10, no opening or
 *   closing move from the previous 2 of the same type, the 40% spread limit, <recent_headings>).
 *   Rows older than 365 days are purged; only the newest rows per site are ever read.
 *
 * SAFE TO DEPLOY THE CODE FIRST. Until these tables exist the store fails OPEN: reads are misses,
 * writes are skipped and each logs `[content-v3] store unavailable`. The chain still runs; it just
 * recomputes on Regenerate and the blueprint has no history.
 *
 * ROW LEVEL SECURITY. Enabled with no policies, as for migration 022: only the server touches these
 * tables, over its direct connection as the owner.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS content_v3_sessions (
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website_id   INTEGER     NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  session_key  TEXT        NOT NULL CHECK (char_length(session_key) BETWEEN 8 AND 80),
  data         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, website_id, session_key)
);

CREATE INDEX IF NOT EXISTS content_v3_sessions_expires_idx ON content_v3_sessions (expires_at);

ALTER TABLE content_v3_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS content_v3_posts (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website_id    INTEGER     NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  session_key   TEXT,
  bulk_batch    TEXT,
  article_type  TEXT,
  post_size     TEXT,
  proof_level   TEXT,
  picks         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  fingerprint   TEXT,
  headings      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  validator     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS content_v3_posts_site_idx ON content_v3_posts (user_id, website_id, created_at DESC);

ALTER TABLE content_v3_posts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations (id) VALUES ('023-content-v3-store') ON CONFLICT (id) DO NOTHING;
`;

/** Reverses 023: drops the wizard sessions and the per-post history (the blueprint loses its memory). */
export const DOWN_SQL = `
DROP TABLE IF EXISTS content_v3_posts;
DROP TABLE IF EXISTS content_v3_sessions;
DELETE FROM schema_migrations WHERE id = '023-content-v3-store';
`;

export async function up(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('023-content-v3-store');
if (invokedDirectly) {
  up()
    .then(async () => {
      console.log('✅ Migration 023 applied: content_v3_sessions and content_v3_posts created (or already existed).');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 023 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
