/**
 * Migration 009 — users.first_name / users.last_name
 *
 *   npm run migrate:name-parts      (needs DATABASE_URL, same as the server)
 *
 * Client feedback: the profile form "should collect first and last name
 * separately". It collected one "Full Name" string into users.name.
 *
 * WHY STORE BOTH PARTS RATHER THAN SPLIT IN THE UI
 * Two fields that concatenate into a single column are not actually collecting
 * the parts — they are collecting a string and forgetting where the boundary
 * was. Re-opening the form has to GUESS the split again, and it guesses wrong
 * for the common cases: "Mary Jane Watson", "Van Der Berg", any two-word
 * surname. Storing the boundary is the only version that round-trips.
 *
 * WHY `name` STAYS
 * It remains the display string and is kept in sync on every write
 * (updateUserProfileName), so the dozen existing readers — dashboard greeting,
 * avatar initials, support tickets, signup, OAuth sync — keep working untouched.
 * `name` is derived from the parts, never the other way round. If the two ever
 * disagree, the parts win.
 *
 * BACKFILL
 * Existing rows are split on the FIRST space: everything before it is the first
 * name, the remainder is the last name. That is a guess, but it is the same
 * guess the UI would otherwise make on every single load, made once, and from
 * here on the user can correct it and the correction sticks. A single-token
 * name ("Janaki") yields a first name and a NULL last name rather than
 * duplicating the token into both columns.
 *
 * Idempotent — safe to run more than once. The backfill only touches rows where
 * BOTH parts are still NULL, so re-running can never clobber a name a user has
 * since edited.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT;

UPDATE users
   SET first_name = NULLIF(split_part(TRIM(name), ' ', 1), ''),
       -- POSITION returns 0 when there is no space at all; guarding on that is
       -- what stops a one-word name being copied into BOTH columns.
       last_name = CASE
         WHEN POSITION(' ' IN TRIM(name)) = 0 THEN NULL
         ELSE NULLIF(TRIM(SUBSTRING(TRIM(name) FROM POSITION(' ' IN TRIM(name)) + 1)), '')
       END
 WHERE name IS NOT NULL
   AND TRIM(name) <> ''
   AND first_name IS NULL
   AND last_name IS NULL;
`;

export async function up(): Promise<{ withFirstName: number; total: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE first_name IS NOT NULL)::int AS with_first,
      COUNT(*)::int AS total
    FROM users
  `;
  const r = (rows as any[])[0] || {};
  return { withFirstName: Number(r.with_first ?? 0), total: Number(r.total ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('009-user-name-parts');
if (invokedDirectly) {
  up()
    .then(async ({ withFirstName, total }) => {
      console.log(`✅ Migration 009 applied. ${withFirstName}/${total} user(s) have a first name.`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 009 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
