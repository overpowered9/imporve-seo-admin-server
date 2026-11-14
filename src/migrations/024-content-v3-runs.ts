/**
 * Migration 024 — Content v3 run ledger, daily quotas, and the migrations record
 *
 *   npm run migrate:content-v3-runs        (needs DATABASE_URL, same as the server)
 *   or paste the output of `npm run --silent migrations:print` into the Supabase SQL editor.
 *   Reverse: `npm run --silent migrations:print -- --down` prints the DOWN statements.
 *
 * content_v3_runs (B-3: credits charged exactly once)
 *   One row per paid article request. Unique per (user, request_id): the plugin sends one id per
 *   click and keeps it until the article reaches the browser, so a retry replays the finished
 *   article instead of buying it again. A partial unique index allows ONE running row per
 *   (user, session): a double click, a second tab or a second server instance gets 409, not a
 *   second charge. A refund that fails is stored as refund_pending and retried by the server.
 *   The row also keeps the step costs and timings for the admin trail. Purged after 90 days.
 *
 * content_v3_quota (B-5: cost exposure)
 *   Per-account daily counters for the free steps (title, town check, approve) and the article.
 *
 * schema_migrations
 *   One row per applied migration (022, 023 and 024 record themselves), so "what is applied here"
 *   has an answer.
 *
 * SAFE TO DEPLOY THE CODE FIRST. Until these tables exist the server logs `runs ledger unavailable`
 * and keeps the in-process lock it used before; quotas are not enforced (logged once).
 *
 * ROW LEVEL SECURITY. Enabled with no policies, as for 022 and 023: only the server touches these.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
`;

export const MIGRATION_SQL = `${SCHEMA_MIGRATIONS_SQL}
CREATE TABLE IF NOT EXISTS content_v3_runs (
  id             BIGSERIAL   PRIMARY KEY,
  user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website_id     INTEGER     REFERENCES websites(id) ON DELETE SET NULL,
  session_key    TEXT        NOT NULL CHECK (char_length(session_key) BETWEEN 8 AND 80),
  request_id     TEXT        NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 120),
  status         TEXT        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'refund_pending', 'refunding', 'refunded')),
  cost           INTEGER     NOT NULL DEFAULT 0,
  action         TEXT,
  variant        TEXT,
  generation_id  BIGINT,
  response       JSONB,
  step_costs     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  timings        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS content_v3_runs_one_running_idx ON content_v3_runs (user_id, session_key) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS content_v3_runs_session_idx ON content_v3_runs (session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS content_v3_runs_refund_idx ON content_v3_runs (updated_at) WHERE status = 'refund_pending';

ALTER TABLE content_v3_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS content_v3_quota (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE    NOT NULL,
  kind     TEXT    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

ALTER TABLE content_v3_quota ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (id) VALUES ('024-content-v3-runs') ON CONFLICT (id) DO NOTHING;
`;

/** Reverses 024 (drops the ledger and quotas; schema_migrations stays, it is shared). */
export const DOWN_SQL = `
DROP TABLE IF EXISTS content_v3_quota;
DROP TABLE IF EXISTS content_v3_runs;
DELETE FROM schema_migrations WHERE id = '024-content-v3-runs';
`;

export async function up(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('024-content-v3-runs');
if (invokedDirectly) {
  up()
    .then(async () => {
      console.log('✅ Migration 024 applied: content_v3_runs, content_v3_quota and schema_migrations created (or already existed).');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 024 failed:', err);
      await sql.end();
      process.exit(1);
    });
}
