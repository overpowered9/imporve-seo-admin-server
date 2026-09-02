/**
 * Migration 017 — the signup-email claim columns, versioned and split in two
 *
 *   npm run migrate:signup-emails      (needs DATABASE_URL, same as the server)
 *
 * WHY THIS EXISTS
 * `confirmation_email_sent_at` is a NEW column that ensureSignupEmails requires:
 * it splits a claim that used to gate two different emails. Without it that
 * function throws on every call and sends nothing, so this migration is a
 * prerequisite for deploying it, not an optimisation.
 *
 * It also versions three columns — welcome/checkin/trial_end_email_sent_at —
 * that were applied BY HAND (commit 5a56246). They are in no migration and
 * absent from print-migrations.ts, mentioned in this repo only in passing by
 * 002's header. A column nothing versions is a column nothing can reason about.
 *
 * ── WHAT THE PRODUCTION DATA ACTUALLY SHOWED ────────────────────────────────
 * Worth recording, because the obvious suspicion was wrong and the next person
 * will have it too. The reported symptom was a Google signup receiving no
 * welcome email, and the natural guess was that the hand-written ALTER TABLE
 * had carried a `DEFAULT NOW()` — which would make every new row born already
 * claimed, and nobody ever eligible.
 *
 * It had not. Measured before this migration was first run:
 *
 *   • none of the three columns had a default;
 *   • 0 of 20 accounts were unclaimed;
 *   • the five oldest accounts have welcome_email_sent_at EXACTLY equal to
 *     created_at — the bulk back-mark from 5a56246;
 *   • every account since carries a 2–14 minute gap, which is the 15-minute
 *     poller doing its job.
 *
 * The old code released the claim unless BOTH sends returned true, so a claim
 * that stuck means Mailgun ACCEPTED both messages. The welcome was sent. Where
 * it went after that is a DELIVERY question — Mailgun logs, spam placement —
 * and no schema change can answer it.
 *
 * What the gaps do prove is the other half of the report: "the confirmation
 * arrived, but late" is the poller interval, exactly. That is fixed in code, by
 * calling ensureSignupEmails on first contact (see users.routes.ts).
 *
 * DROP DEFAULT below is kept as a cheap guard rather than a fix — it is a no-op
 * on these columns today, and it stops a future hand-applied default from
 * silently disabling the whole sequence.
 *
 * ── EVERY EXISTING ROW IS BACK-MARKED, DELIBERATELY ─────────────────────────
 * A new column arrives full of NULLs, and NULL means "due". Without the
 * back-mark, adding confirmation_email_sent_at would queue a confirmation email
 * for the ENTIRE user base on the next pass. So it claims every row that exists
 * at the moment it runs.
 *
 * That includes any account that genuinely missed out, which is why the counts
 * are printed at the end: re-sending is a deliberate act, per account, never a
 * side effect of deploying. To re-send for someone:
 *
 *     UPDATE users
 *        SET welcome_email_sent_at = NULL, confirmation_email_sent_at = NULL
 *      WHERE email = 'someone@example.com';
 *
 * They are picked up within 15 minutes, or immediately on their next visit.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
-- 1. Version the three hand-applied columns. No-ops where they already exist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_email_sent_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS checkin_email_sent_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_end_email_sent_at    TIMESTAMPTZ;

-- 2. Split the signup claim in two, so a failed welcome cannot re-send the
--    confirmation. See ensureSignupEmails.
ALTER TABLE users ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;

-- 3. A claim column must never default. A DEFAULT NOW() here would mark every
--    new account as already-emailed at INSERT time, disabling the sequence
--    silently. None of these carries one today; this keeps it that way.
ALTER TABLE users ALTER COLUMN welcome_email_sent_at      DROP DEFAULT;
ALTER TABLE users ALTER COLUMN checkin_email_sent_at      DROP DEFAULT;
ALTER TABLE users ALTER COLUMN trial_end_email_sent_at    DROP DEFAULT;
ALTER TABLE users ALTER COLUMN confirmation_email_sent_at DROP DEFAULT;

-- 4. Claim every row that exists RIGHT NOW, so dropping the default cannot mail
--    the back catalogue. Un-claim individual accounts by hand to re-send.
UPDATE users SET confirmation_email_sent_at = COALESCE(confirmation_email_sent_at, welcome_email_sent_at, created_at, NOW())
 WHERE confirmation_email_sent_at IS NULL;
UPDATE users SET welcome_email_sent_at = COALESCE(welcome_email_sent_at, created_at, NOW())
 WHERE welcome_email_sent_at IS NULL;
`;

export async function up(): Promise<{
  defaults: Array<{ column_name: string; column_default: string | null }>;
  unclaimed: number;
}> {
  // Read the defaults BEFORE dropping them. Measured as none on the first run;
  // reported anyway, because a default appearing here later is a silent
  // disabling of the whole signup sequence and this is where it would show.
  const before = await sql`
    SELECT column_name, column_default
      FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name IN (
         'welcome_email_sent_at', 'checkin_email_sent_at',
         'trial_end_email_sent_at', 'confirmation_email_sent_at'
       )
     ORDER BY column_name
  `;

  await sql.unsafe(MIGRATION_SQL);

  // Should be zero — proof the back-mark covered everything, so nobody is about
  // to be mailed by surprise on the next scheduler pass.
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM users
     WHERE welcome_email_sent_at IS NULL OR confirmation_email_sent_at IS NULL
  `;

  return {
    defaults: before as any,
    unclaimed: Number((rows as any[])[0]?.n ?? 0),
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('017-signup-email-columns');
if (invokedDirectly) {
  up()
    .then(async ({ defaults, unclaimed }) => {
      console.log('✅ Migration 017 applied.');
      console.log('   Column defaults BEFORE this ran (the diagnosis):');
      if (defaults.length === 0) {
        console.log('     (none of the columns existed — they do now)');
      }
      for (const d of defaults) {
        const verdict = d.column_default ? `⚠️  ${d.column_default}` : 'none — ok';
        console.log(`     ${d.column_name.padEnd(28)} ${verdict}`);
      }
      console.log(`   Accounts still due a signup email: ${unclaimed} (expected 0).`);
      console.log('   To re-send for one account, set its two *_email_sent_at columns to NULL.');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 017 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
