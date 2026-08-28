/**
 * Migration 016 — handle_new_user() stops seeding a credit model we deleted
 *
 *   npm run migrate:signup-credits      (needs DATABASE_URL, same as the server)
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
 * A brand-new account had no spendable credits. Not a display bug: the balance
 * is derived from credit_lots (migration 012) and burnFromLots found none, so
 * every generation would have been refused too.
 *
 * The CMS signs up through supabase.auth.signUp(), so accounts are born inside
 * Supabase Auth, where an AFTER INSERT trigger on auth.users runs this function.
 * It created the public.users row correctly and then seeded credits like this:
 *
 *     INSERT INTO public.credit_balances (user_id, credit_type, ...)
 *     VALUES (new_user_id, 'images',   img, ...),
 *            (new_user_id, 'content',  con, ...),
 *            (new_user_id, 'keywords', kw,  ...);
 *
 * Three credit types that migration 011 collapsed into the single 'iseo' pool.
 * No 'iseo' row, no lot, no transaction — and a hardcoded `img := 10` fallback
 * from a pricing model two migrations old.
 *
 * ── WHY IT SURVIVED MIGRATION 011 ───────────────────────────────────────────
 * Because this function lived ONLY in the database. It was in no migration and
 * no file in either repository, so when the credit model changed in code there
 * was nothing for anyone reading the codebase to update. Putting it under
 * version control is half the point of this migration; the next person to
 * change how credits work will now find it.
 *
 * ── WHY THE TRIGGER DOES NOT GAIN THE CORRECT GRANT ─────────────────────────
 * Because that is what went wrong. Writing the grant in PL/pgSQL puts a SECOND
 * implementation of the credit model somewhere the codebase cannot see, and it
 * would have to duplicate ISEO_GRANT_FREE (a Node env var), the lot lifetime,
 * and syncBalanceCache — three constants free to drift apart exactly as these
 * ones did.
 *
 * The trigger creates the ACCOUNT. Node decides what an account is worth, in
 * initializeUserCredits, which is already the single implementation of that and
 * is already idempotent. ensureSignupGrant (models/user.models.ts) calls it the
 * first time the API resolves the account, which is before anything can be
 * spent — and which also heals every account created while this trigger was
 * live, without a backfill.
 *
 * ── WHAT IS PRESERVED ───────────────────────────────────────────────────────
 * Everything else the function did, verbatim: the users row with email, name
 * from the auth metadata, a generated api_key, the free plan and the 7-day
 * trial window; ON CONFLICT (email) DO NOTHING; and the id recovery for the
 * conflict case, where RETURNING yields nothing.
 *
 * The plan lookup no longer reads image_credits/content_credits/keyword_credits
 * — those columns are derived display copies now (see plan-credit-sync.ts) and
 * nothing here needs them. The `free_plan_id := 4` fallback stays: it is the
 * difference between a signup that works and one that fails outright.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 *
 * Idempotent — CREATE OR REPLACE, safe to run more than once. The trigger
 * itself is not touched; only the function body it calls.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  free_plan_id INT;
  new_user_id INT;
BEGIN
  SELECT id INTO free_plan_id
  FROM public.subscription_plans WHERE slug = 'free' LIMIT 1;
  IF free_plan_id IS NULL THEN free_plan_id := 4; END IF;

  INSERT INTO public.users (email, name, api_key, plan_id, trial_started_at, trial_ends_at)
  VALUES (
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', ''),
    UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 9)),
    free_plan_id,
    NOW(),
    NOW() + INTERVAL '7 days'
  )
  ON CONFLICT (email) DO NOTHING
  RETURNING id INTO new_user_id;

  IF new_user_id IS NULL THEN
    SELECT id INTO new_user_id FROM public.users WHERE email = NEW.email LIMIT 1;
  END IF;

  -- Credits are DELIBERATELY not granted here. See the module note: the pool,
  -- its size and its expiry live in Node (config/credits.config.ts and
  -- models/user.models.ts initializeUserCredits), and ensureSignupGrant hands
  -- them out the first time the API sees this account. This function used to
  -- seed 'images'/'content'/'keywords' rows, which migration 011 made
  -- unspendable, so a new account had a balance it could not use.

  RETURN NEW;
END;
$function$
`;

export async function up(): Promise<{ seedsLegacyTypes: boolean; createsUser: boolean }> {
  await sql.unsafe(MIGRATION_SQL);

  // Read the function back OUT of the database rather than trusting the write:
  // the whole reason this bug lasted is that nobody could see what was really
  // installed there.
  const rows = await sql`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  p.proname = 'handle_new_user' AND n.nspname = 'public'
    LIMIT  1
  `;
  const def = String((rows[0] as any)?.def ?? '');
  // Comments stripped before matching. pg_get_functiondef returns the body
  // VERBATIM, comments included, and the body carries a note explaining what
  // this function stopped doing — a note that necessarily names the three dead
  // credit types. Matching the raw text reports the explanation as the thing it
  // is warning about, which is what this check did on its first real run.
  // Assert about the SQL that RUNS; the prose beside it is not behaviour.
  const executable = def.replace(/--[^\n]*/g, '');
  return {
    seedsLegacyTypes: /'(images|content|keywords)'/.test(executable)
      || /INSERT INTO public\.credit_balances/i.test(executable),
    createsUser: /INSERT INTO public\.users/i.test(executable),
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('016-signup-credit-grant');
if (invokedDirectly) {
  up()
    .then(async ({ seedsLegacyTypes, createsUser }) => {
      if (seedsLegacyTypes || !createsUser) {
        console.error(
          '❌ Migration 016 ran but the installed function is not what was expected ' +
          `(createsUser=${createsUser}, seedsLegacyTypes=${seedsLegacyTypes}). Investigate before signing anyone up.`,
        );
        await sql.end();
        process.exit(1);
      }
      console.log('✅ Migration 016 applied. handle_new_user() now creates the account only —');
      console.log('   credits are granted by ensureSignupGrant on the first API call for it.');
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 016 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
