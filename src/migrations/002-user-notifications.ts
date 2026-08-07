/**
 * Migration 002 — user_notifications
 *
 *   npm run migrate:notifications      (needs DATABASE_URL, same as the server)
 *
 * Backs the double-send guard for the scheduled notification emails
 * (credits.md round 2, bugs 16 and 17).
 *
 * WHY A TABLE RATHER THAN MORE COLUMNS ON `users`
 * The existing trial drip guards itself with one `*_sent_at` column per email
 * (welcome_email_sent_at, …). That works because each of those fires EXACTLY
 * ONCE per account, ever. These two do not:
 *
 *   • credit-expiry fires once PER BILLING CYCLE — forever
 *   • inactivity fires once PER INACTIVITY WINDOW — repeatedly, if the user
 *     lapses again after coming back
 *
 * A single timestamp column cannot express "already sent for THIS cycle", so a
 * column-per-email would either spam on every scheduler pass or send only once
 * and then go quiet permanently. `dedupe_key` carries the occurrence — the
 * cycle start for expiry, the inactivity-window start for inactivity — and the
 * UNIQUE constraint makes the claim atomic under concurrent schedulers, the
 * same at-most-once property the trial drip relies on.
 *
 * The table is generic, so future notifications need no further DDL.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS user_notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL,
  kind        TEXT        NOT NULL,
  -- Identifies the OCCURRENCE this notice covers (e.g. the cycle start), so the
  -- same kind can legitimately be sent again for a later occurrence.
  dedupe_key  TEXT        NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_notifications_unique UNIQUE (user_id, kind, dedupe_key)
);

-- "When did we last send this kind to this user?" — the inactivity job's
-- cooldown check, and the lookup behind any future notification history.
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_kind_sent
  ON user_notifications (user_id, kind, sent_at DESC);
`;

export async function up(): Promise<{ existing: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`SELECT COUNT(*)::int AS n FROM user_notifications`;
  return { existing: Number((rows as any[])[0]?.n ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('002-user-notifications');
if (invokedDirectly) {
  up()
    .then(async ({ existing }) => {
      console.log(`✅ Migration 002 applied. user_notifications holds ${existing} row(s).`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 002 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
