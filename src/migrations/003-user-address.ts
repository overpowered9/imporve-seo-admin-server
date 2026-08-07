/**
 * Migration 003 — user address (task3.md 4.2)
 *
 *   npm run migrate:address      (needs DATABASE_URL, same as the server)
 *
 * The business needs each user's address for internal tax purposes.
 *
 * WHY DISCRETE COLUMNS RATHER THAN A JSON BLOB
 * Tax treatment is decided by COUNTRY and often by state/province, so those two
 * have to be queryable and indexable — a JSONB blob would push every future tax
 * report into a full scan plus application-side parsing. Discrete columns also
 * let the database enforce that country is a 2-letter code.
 *
 * PII NOTE
 * These columns hold personal data. They sit on `users` alongside name and
 * email, so they inherit exactly the same access path, backup policy and
 * deletion behaviour as the personal data already stored there — no new
 * exposure surface. They are deliberately NOT returned by any public/plugin
 * endpoint (see users.routes.ts: only the authenticated profile read exposes
 * them), and must never be written to logs or analytics.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS address_line1       TEXT,
  ADD COLUMN IF NOT EXISTS address_line2       TEXT,
  ADD COLUMN IF NOT EXISTS address_city        TEXT,
  ADD COLUMN IF NOT EXISTS address_state       TEXT,
  ADD COLUMN IF NOT EXISTS address_postal_code TEXT,
  -- ISO 3166-1 alpha-2. Stored uppercase; the CHECK keeps free text out of a
  -- column that tax logic will branch on.
  ADD COLUMN IF NOT EXISTS address_country     CHAR(2),
  ADD COLUMN IF NOT EXISTS address_updated_at  TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_address_country_format'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_address_country_format
      CHECK (address_country IS NULL OR address_country ~ '^[A-Z]{2}$');
  END IF;
END $$;

-- Tax reporting groups by jurisdiction; this keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_users_address_country ON users (address_country);
`;

export async function up(): Promise<{ withAddress: number; total: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT COUNT(*) FILTER (WHERE address_line1 IS NOT NULL)::int AS with_address,
           COUNT(*)::int AS total
    FROM   users
  `;
  const r = (rows as any[])[0] || { with_address: 0, total: 0 };
  return { withAddress: Number(r.with_address), total: Number(r.total) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('003-user-address');
if (invokedDirectly) {
  up()
    .then(async ({ withAddress, total }) => {
      console.log(`✅ Migration 003 applied. ${withAddress}/${total} user(s) have an address on file.`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 003 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
