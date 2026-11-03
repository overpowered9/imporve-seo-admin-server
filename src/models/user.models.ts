import sql from '../data/db.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import {
  grantForPlanSlug,
  PLAN_CREDIT_LIFETIME_MONTHS,
  PURCHASED_CREDIT_LIFETIME_MONTHS,
} from '../config/credits.config.js';
// The ledger, for the two lifecycle events that happen here rather than in a
// route: the trial starting and the trial ending. No cycle — transactions.ts
// pulls only descriptions.js and a type.
import { recordTransaction } from '../services/billing/transactions.js';
import { describeTrialStarted, describeTrialEnded } from '../services/billing/descriptions.js';
import { TRIAL_DAYS, effectiveTrialEnd, isTrialExpired } from './trial.js';
import { isLiveStatus } from '../services/billing/subscription-state.js';
export interface User {
  id: number;
  email: string;
  // Display string, DERIVED from the two parts below and kept in sync on every
  // profile write. Existing readers (greeting, initials, tickets) use this.
  name?: string;
  // Migration 009. Optional because a database that has not run it yet simply
  // will not return these columns.
  first_name?: string | null;
  last_name?: string | null;
  api_key: string;
  plan_id?: number;
  created_at: Date;
  updated_at: Date;
  password_hash?: string;
  oauth_provider?: string;
  oauth_id?: string;
  avatar_url?: string;
  trial_started_at?: Date | null;
  trial_ends_at?: Date | null;
}

export interface Website {
  id: number;
  user_id: number;
  domain: string;
  site_code: string;
  active: boolean;
  trial_used: boolean;
  deleted_at: Date | null;
  created_at: Date;
  // Last time the plugin authenticated for this site (migration 008). NULL means
  // it has never checked in. Drives the CMS "Active / Not Connected" chip.
  // Optional because a database that has not run migration 008 yet simply will
  // not return the column — see touchWebsiteConnection for the writer.
  last_connected_at?: Date | null;
  /**
   * When the plugin last sent an UNPROMPTED check-in (migration 014).
   *
   * Non-null proves the plugin on this site heartbeats, which is what licenses
   * the CMS to treat silence as a disconnection. NULL means an older build that
   * only calls us when it has work — see utils/websiteStatus.js in the CMS.
   */
  heartbeat_at?: Date | null;
}

export interface CreditBalance {
  id: number;
  user_id: number;
  credit_type: CreditType;
  /** Plan-included credits remaining; reset to included_allotment each billing cycle. */
  included_remaining: number;
  /** Purchased (top-up) credits remaining; persist across cycles, never wiped by refills. */
  purchased_remaining: number;
  /** Snapshot of the plan allotment at the last refill — used for "X of Y used" displays. */
  included_allotment: number;
  /** When included_remaining was last reset — used for "resets in N days". */
  cycle_started_at: Date;
  /** Effective balance = included_remaining + purchased_remaining (generated column). */
  amount: number;
  updated_at: Date;
}

/**
 * ISEO Credits — ONE pool.
 *
 * Was three independent pools ('images' | 'content' | 'keywords'), each charged a flat 1 credit
 * per action regardless of what the action actually cost us. Real cost varies roughly 2x across
 * article sizes and again between an article and an image, so a flat charge over-priced small work
 * and under-priced large. A single pool with a per-action deduction table (config/credits.config.ts,
 * priced by services/credit-pricing.ts) replaces it.
 *
 * These two symbols are the seam every credit path already funnels through, so collapsing them
 * collapses the whole model: the loops below now run once instead of three times, and their
 * transaction, ledger and proration behaviour is unchanged.
 *
 * See migrations/011-iseo-credit-pool.ts. Per-type balances are NOT carried over.
 */
export type CreditType = 'iseo';
export const ISEO_CREDIT_TYPE: CreditType = 'iseo';
const CREDIT_TYPES: CreditType[] = [ISEO_CREDIT_TYPE];

/**
 * The trial-window rules now live in ./trial.js so they can be unit-tested
 * without opening a database connection. Re-exported here because this is the
 * address every caller already knows them by.
 */
export { TRIAL_DAYS, effectiveTrialEnd, isTrialExpired };

/**
 * Credits a plan grants per billing cycle.
 *
 * Now sourced from env (ISEO_GRANT_<SLUG>) rather than the subscription_plans.*_credits columns.
 * Those columns still exist and are kept in sync by the boot-time sync so Stripe checkout
 * descriptions and CMS joins keep working, but they are DERIVED — env is the source of truth, and
 * there is no runtime path that can change a grant.
 *
 * `creditType` is retained in the signature purely so the call sites keep reading naturally now
 * that CREDIT_TYPES has one member; there is only one pool to allot.
 */
const planAllotment = (plan: any, _creditType: CreditType): number => {
  return grantForPlanSlug(plan?.slug);
};

// Add these interfaces to existing ones
export interface SubscriptionPlan {
  id: number;
  slug: string;
  name: string;
  image_credits: number;
  content_credits: number;
  keyword_credits: number;
  website_limit: number | null;
  scheduled_publishing: boolean;
  course_access: boolean;
  price_cents: number;
}



export const findUserByEmail = async (email: string): Promise<User | null> => {
  const result = await sql`
    SELECT * FROM users WHERE email = ${email} LIMIT 1
  `;
  return (result[0] as User) || null;
};

export const generateApiKey = (): string => {
  // Generate 9-digit unique code
  return crypto.randomBytes(5).toString('hex').substring(0, 9).toUpperCase();
};

export const generateSiteCode = (): string => {
  // Generate 4-digit unique code
  return crypto.randomBytes(2).toString('hex').substring(0, 4).toUpperCase();
};



export const createUser = async (userData: {
  email: string;
  name: string;
  api_key: string;
  plan_id: number;
  password: string;
}): Promise<User> => {
  // Hash password
  const password_hash = await bcrypt.hash(userData.password, 10);
  
  const result = await sql`
    INSERT INTO users (email, name, api_key, plan_id, password_hash)
    VALUES (${userData.email}, ${userData.name}, ${userData.api_key}, ${userData.plan_id}, ${password_hash})
    RETURNING id, email, name, api_key, plan_id, created_at, updated_at
  `;
  
  return result[0] as User;
};

export const validatePassword = async (password: string, hash: string): Promise<boolean> => {
  return await bcrypt.compare(password, hash);
};

export const setPasswordHash = async (userId: number, password: string): Promise<void> => {
  const hash = await bcrypt.hash(password, 10);
  await sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE id = ${userId}`;
};

export const initializeUserCredits = async (user_id: number, plan_id?: number): Promise<void> => {
  // If no plan_id provided, use FREE plan
  let resolvedPlanId: number;
  
  if (!plan_id) {
    const freePlan = await sql`
      SELECT * FROM subscription_plans WHERE slug = 'free' LIMIT 1
    `;
    if (freePlan.length > 0) {
      resolvedPlanId = freePlan[0].id as number;
    } else {
      throw new Error('FREE plan not configured in database');
    }
  } else {
    resolvedPlanId = plan_id;
  }
  
  // Get plan details
  const plan = await sql`
    SELECT * FROM subscription_plans WHERE id = ${resolvedPlanId} LIMIT 1
  `;
  
  if (!plan[0]) throw new Error('Invalid plan');
  
  const planData = plan[0] as SubscriptionPlan;

  // Seed the single ISEO pool with the plan's env-configured grant. Was three rows, one per
  // legacy type, read from planData.*_credits — those columns are derived now (see
  // plan-credit-sync.ts) and the rows they seeded no longer exist after migration 011, so
  // inserting them would leave a new signup with no spendable balance at all.
  const allotment = grantForPlanSlug(planData.slug);

  // ── The grant is a LOT, not a balance row ────────────────────────────────
  // This wrote credit_balances alone, which stopped being enough the moment the
  // spendable balance started being derived from credit_lots: a brand-new
  // account got a cached figure it could not spend a single credit of. Not just
  // a display bug — burnFromLots finds no lots, so every generation is refused.
  //
  // Guarded on "has this user any lots yet", so a retried signup does not hand
  // out the allotment twice.
  //
  // ── WHY THE ADVISORY LOCK, NOT JUST THE CHECK ───────────────────────────
  // Under the default READ COMMITTED isolation, "check then insert" is not
  // idempotent under concurrency: two calls for the same user can both run
  // the SELECT below before either commits its INSERT, both see no lots, and
  // both grant — which is exactly how a Free Trial account ended up with 300
  // credits instead of 100 (three concurrent grants of the same lot). This
  // was NOT a rare edge case: ensureSignupGrant calls this on every
  // /users/by-email request for an unprovisioned account, and a fresh
  // signup's first page load routinely fires several of those at once.
  //
  // pg_advisory_xact_lock serializes concurrent calls for the SAME user_id —
  // transaction-scoped, so it releases itself on commit or rollback with no
  // separate unlock step. The second caller blocks here, then (after the
  // first commits) re-runs the "existing" check below and correctly finds
  // the row already there, skipping its own insert. This is the only call
  // site that needs it: every path that can grant credits (direct signup,
  // and ensureSignupGrant from every /users/by-email hit) funnels through
  // this one transaction.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${user_id})`;

    const existing = (await tx`
      SELECT 1 FROM credit_lots WHERE user_id = ${user_id} LIMIT 1
    `) as unknown as unknown[];

    await tx`
      INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
      VALUES (${user_id}, ${ISEO_CREDIT_TYPE}, 0, ${allotment}, 0, NOW())
      ON CONFLICT (user_id, credit_type) DO UPDATE SET included_allotment = ${allotment}
    `;

    if (existing.length === 0 && allotment > 0) {
      await tx`
        INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, plan_id, reason)
        VALUES (${user_id}, 'plan', ${allotment}, ${allotment},
                NOW() + ${`${PLAN_CREDIT_LIFETIME_MONTHS} months`}::interval,
                ${resolvedPlanId}, 'Account created')
      `;
      await tx`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${user_id}, ${ISEO_CREDIT_TYPE}, ${allotment}, 'Account created')
      `;
    }

    await syncBalanceCache(tx, user_id);
  });

  // ONLY create subscription record for PAID plans
  // Free tier users have NO subscription
  if (planData.price_cents > 0) {
    const startDate = new Date();
    const nextBilling = new Date();
    nextBilling.setMonth(nextBilling.getMonth() + 1);
    
    await sql`
      INSERT INTO subscriptions (user_id, plan_id, start_date, next_billing_date, status)
      VALUES (${user_id}, ${resolvedPlanId}, ${startDate.toISOString().split('T')[0]}, ${nextBilling.toISOString().split('T')[0]}, 'active')
    `;
  }
  // Free tier: No subscription record is created
};

/**
 * Grant the signup credits to an account that never received them.
 *
 * ── WHY A NEW ACCOUNT COULD HAVE NONE ───────────────────────────────────────
 * The CMS signs up through supabase.auth.signUp(), so accounts are born inside
 * Supabase Auth and the public.users row is written by a database trigger
 * (handle_new_user — now tracked in migrations/016). Email signup then confirms
 * by link, so the API is not touched at all until the first sign-in, and
 * initializeUserCredits above — the only correct implementation of the grant —
 * was never reached by either signup route: /auth/register is not what the CMS
 * calls, and /auth/oauth finds the trigger-created row and takes its "existing
 * user" branch.
 *
 * So this is called where the API first resolves an account. It is the
 * PROVISIONING step that had no home, not a repair job, though it repairs the
 * accounts created while the old trigger was live as a side effect — which is
 * why no backfill is needed for them.
 *
 * ── THE GUARD IS NARROW ON PURPOSE ──────────────────────────────────────────
 * It fires only for an account with NO credit lots AND no subscription row:
 * unambiguously a new free account that was never provisioned. A PAYING account
 * with no lots is a different failure — a refill that did not run, a webhook
 * that was lost — and quietly handing it the free grant would paper over it and
 * under-credit the customer. That case is left alone for a human.
 *
 * Cheap in the common case: one indexed existence check, then nothing.
 * This function's OWN check-then-provision here is not race-safe under
 * concurrent calls — and does not need to be. initializeUserCredits holds a
 * per-user advisory lock around its actual grant, which is the real,
 * sufficient guard: two overlapping calls both reach `provision`, but only
 * one of them ends up inserting a lot (see its comment for why this exact
 * gap — a plain "check, then insert" — used to let a Free Trial account be
 * granted 100 credits two or three times over).
 *
 * Never throws. Reading an account must not fail because a grant could not be
 * written; the failure is logged and the next request tries again.
 */
export const ensureSignupGrant = async (
  user: { id: number; plan_id?: number | null },
  // The seam the billing services already use (see proration.ts, which takes
  // its client the same way): production callers pass nothing, and the guard —
  // the part with the judgement in it — becomes testable without a database.
  deps: {
    db?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
    provision?: (userId: number, planId?: number) => Promise<void>;
  } = {},
): Promise<boolean> => {
  const db = deps.db ?? sql;
  const provision = deps.provision ?? initializeUserCredits;
  try {
    const rows = await db`
      SELECT EXISTS (SELECT 1 FROM credit_lots   WHERE user_id = ${user.id}) AS has_lots,
             EXISTS (SELECT 1 FROM subscriptions WHERE user_id = ${user.id}) AS has_subscription
    `;
    const { has_lots: hasLots, has_subscription: hasSubscription } = (rows[0] ?? {}) as any;
    if (hasLots || hasSubscription) return false;

    await provision(user.id, user.plan_id ?? undefined);
    console.log(`💳 Provisioned signup credits for user ${user.id} (none had been granted).`);
    return true;
  } catch (err) {
    console.error(`⚠️ Could not provision signup credits for user ${user.id}:`, err);
    return false;
  }
};

/**
 * Does this account have a password? Drives `has_password` on /users/by-email,
 * which decides whether Settings asks for the current password or offers to
 * set a first one.
 *
 * ── WHY password_hash ALONE WAS WRONG ───────────────────────────────────────
 * It was `!!user.password_hash`. Only /auth/signup (plugin) and
 * /auth/set-password write that column. A WEB email signup goes through
 * supabase.auth.signUp(); the users row comes from the handle_new_user trigger
 * and password_hash stays NULL. Every such account was told "You don't have a
 * password yet" and was not asked for its current password before changing it.
 *
 * The password those accounts sign in with lives in Supabase Auth, so that is
 * checked too: a non-empty auth.users.encrypted_password. It is empty for a
 * Google-only account, which is still correctly reported as having none.
 *
 * Returns null when the lookup fails. Unknown must never read as false: the CMS
 * treats anything but false as "has a password" and keeps the check.
 */
export const hasPasswordCredential = async (
  user: { id: number; email: string; password_hash?: string | null },
  deps: {
    db?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
  } = {},
): Promise<boolean | null> => {
  if (user.password_hash) return true;
  const db = deps.db ?? sql;
  try {
    // bool_or across rows: auth.users is not unique on email for SSO accounts.
    const rows = await db`
      SELECT COALESCE(bool_or(encrypted_password IS NOT NULL AND encrypted_password <> ''), false) AS has_password
      FROM auth.users
      WHERE lower(email) = lower(${user.email})
    `;
    return !!(rows[0] as any)?.has_password;
  } catch (err) {
    console.error(`⚠️ Could not read the auth password state for user ${user.id}:`, err);
    return null;
  }
};

export const getUserWithPlan = async (user_id: number) => {
  const result = await sql`
    SELECT 
      u.*,
      sp.name as plan_name,
      sp.slug as plan_slug,
      sp.website_limit,
      sp.scheduled_publishing,
      sp.course_access
    FROM users u
    LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
    WHERE u.id = ${user_id}
    LIMIT 1
  `;
  
  return result[0] || null;
};

// Update user name
export const updateUserName = async (user_id: number, name: string): Promise<User | null> => {
  const result = await sql`
    UPDATE users SET name = ${name}, updated_at = NOW()
    WHERE id = ${user_id}
    RETURNING id, email, name, api_key, plan_id, created_at, updated_at
  `;
  return (result[0] as User) || null;
};

/**
 * Does this user have a billing address we could put on an invoice?
 *
 * Client decision: a billing address is mandatory, and without one the user
 * cannot make a purchase. Enforced HERE rather than only in the CMS, because a
 * button that is merely hidden is not an enforcement — the endpoint is what
 * actually takes the money.
 *
 * "Has an address" uses the SAME three-column test as GET /users/address
 * (line1 + city + country). Anything looser would let a half-filled row through
 * and produce exactly the unusable invoice this is meant to prevent.
 *
 * ── FAILS OPEN, DELIBERATELY ────────────────────────────────────────────────
 * Postgres 42703 means migration 003 has not run, so no user CAN have an
 * address. Returning false there would block every purchase for every customer
 * the moment this deploys ahead of the migration. An un-migrated database is
 * our problem, not a reason to refuse someone's money, so the gate is skipped
 * and the purchase proceeds.
 */
export const hasBillingAddress = async (user_id: number): Promise<boolean> => {
  try {
    const rows = await sql`
      SELECT address_line1, address_city, address_country
      FROM users WHERE id = ${user_id} LIMIT 1
    `;
    const r = (rows as any[])[0];
    if (!r) return false;
    return !!(r.address_line1 && r.address_city && r.address_country);
  } catch (error: any) {
    if (error?.code === '42703') {
      console.warn('users address columns missing — migration 003 has not run; skipping the billing-address gate.');
      return true;
    }
    throw error;
  }
};
/**
 * Write the address Stripe collected back onto our user row.
 *
 * Stripe is the owner now: it collects at checkout and lets the user edit in
 * the billing portal, which is what allowed the signup field, the dashboard
 * reminder and the pre-purchase gate to be removed. This keeps OUR copy in
 * step, because plenty of things still read it — GET /users/address, the
 * Settings card, and anything that puts an address on our own paperwork.
 *
 * A cache, not a second source of truth. Nothing here is authoritative: if it
 * is stale, the fix is another webhook, and Stripe's copy is the one that goes
 * on the invoice.
 *
 * Partial addresses are IGNORED rather than written. The three-column test
 * (line1 + city + country) is the same one hasBillingAddress and
 * GET /users/address use, and half-writing over a complete address would turn
 * a good record into an unusable one — the exact failure the old gate existed
 * to prevent.
 */
export const syncAddressFromStripe = async (
  user_id: number,
  address: {
    line1?: string | null; line2?: string | null; city?: string | null;
    state?: string | null; postal_code?: string | null; country?: string | null;
  } | null | undefined,
): Promise<boolean> => {
  if (!address?.line1 || !address?.city || !address?.country) return false;

  try {
    await sql`
      UPDATE users
      SET    address_line1       = ${address.line1},
             address_line2       = ${address.line2 ?? null},
             address_city        = ${address.city},
             address_state       = ${address.state ?? null},
             address_postal_code = ${address.postal_code ?? null},
             address_country     = ${address.country},
             address_updated_at  = NOW()
      WHERE  id = ${user_id}
    `;
    return true;
  } catch (error: any) {
    // Migration 003 has not run. Same reasoning as hasBillingAddress: an
    // un-migrated database is our problem, and it must not turn a completed
    // payment into a failed webhook that Stripe then retries forever.
    if (error?.code === '42703') {
      console.warn('users address columns missing — migration 003 has not run; skipping the Stripe address sync.');
      return false;
    }
    console.error(`Could not sync the Stripe address for user ${user_id}:`, error);
    return false;
  }
};


/**
 * Compose the display string from the parts. ONE definition, so `name` can
 * never drift from first_name/last_name depending on which caller wrote it.
 */
export const composeDisplayName = (first?: string | null, last?: string | null): string =>
  [first, last].map(p => (p ?? '').trim()).filter(Boolean).join(' ');

/**
 * Update the profile name, storing the parts AND the composed display string.
 *
 * `name` is deliberately written from the parts rather than accepted separately:
 * it is a derived field (migration 009), and every existing reader — dashboard
 * greeting, avatar initials, tickets — goes on reading it untouched.
 *
 * PRE-MIGRATION TOLERANCE
 * If migration 009 has not run, the first statement fails with Postgres 42703
 * and we fall back to writing `name` alone. Saving your profile must not become
 * a hard deploy-ordering dependency — the user still gets their name saved, just
 * without the parts, and the next write after the migration stores them.
 */
export const updateUserProfileName = async (
  user_id: number,
  first_name: string,
  last_name: string
): Promise<User | null> => {
  const name = composeDisplayName(first_name, last_name);
  const first = first_name.trim() || null;
  const last = last_name.trim() || null;

  try {
    const result = await sql`
      UPDATE users
      SET name = ${name}, first_name = ${first}, last_name = ${last}, updated_at = NOW()
      WHERE id = ${user_id}
      RETURNING id, email, name, first_name, last_name, api_key, plan_id, created_at, updated_at
    `;
    return (result[0] as User) || null;
  } catch (error: any) {
    if (error?.code !== '42703') throw error;
    console.warn('users.first_name/last_name missing — migration 009 has not run; saving name only.');
    return updateUserName(user_id, name);
  }
};

// Regenerate API key
export const regenerateApiKey = async (user_id: number): Promise<string> => {
  const newKey = generateApiKey();
  await sql`
    UPDATE users SET api_key = ${newKey}, updated_at = NOW()
    WHERE id = ${user_id}
  `;
  return newKey;
};

// User operations
export const findUserByApiKey = async (api_key: string): Promise<User | null> => {
  const result = await sql`
    SELECT * FROM users WHERE api_key = ${api_key} LIMIT 1
  `;
  return (result[0] as User) || null;
};

export const findWebsiteByCode = async (site_code: string, user_id: number): Promise<Website | null> => {
  const result = await sql`
    SELECT * FROM websites 
    WHERE site_code = ${site_code} AND user_id = ${user_id} AND active = true
    LIMIT 1
  `;
  return (result[0] as Website) || null;
};

/**
 * Bring credit_balances back in line with the live lots before it is read.
 *
 * ── WHY A READ HAS TO DO THIS ──────────────────────────────────────────────
 * credit_balances is a cache of the live lots (see syncBalanceCache), but it is
 * only re-derived when a lot is WRITTEN. A lot that simply reaches its
 * expires_at changes nothing in the database, so the cache kept counting it:
 * the only thing that zeroes lapsed lots is the expiry sweep, and that runs
 * inside the lifecycle-email scheduler, which is off in production.
 *
 * Reported by QA as a Scale account whose Settings card read "Total credits
 * remaining 1,251" above a breakdown of a single 120-credit row: a lapsed
 * 1,131-credit plan lot was still in the cache (the total, the "≈ N pieces"
 * line, the plugin's pre-checks) but not in the lots (the breakdown, and
 * burnFromLots — so 120 was all the account could actually spend).
 *
 * Same live-lot filter as syncBalanceCache / getLiveBalance / burnFromLots, so
 * every reader agrees with what can be spent. It writes only when the cache is
 * actually stale (an ordinary read is one UPDATE matching no row), never
 * creates a row (provisioning stays with the grant paths), and never touches
 * included_allotment / cycle_started_at. A failure here is logged and the
 * caller reads the cache as before — a read must not start failing because
 * the refresh did.
 */
export const refreshBalanceCache = async (user_id: number): Promise<void> => {
  try {
    await sql`
      UPDATE credit_balances cb
      SET    included_remaining  = live.plan,
             purchased_remaining = live.purchased,
             updated_at          = NOW()
      FROM (
        SELECT COALESCE(SUM(remaining) FILTER (WHERE source = 'plan'), 0)::int      AS plan,
               COALESCE(SUM(remaining) FILTER (WHERE source = 'purchased'), 0)::int AS purchased
        FROM   credit_lots
        WHERE  user_id = ${user_id} AND remaining > 0 AND expires_at > NOW()
      ) live
      WHERE  cb.user_id = ${user_id}
        AND  cb.credit_type = ${ISEO_CREDIT_TYPE}
        AND  (cb.included_remaining IS DISTINCT FROM live.plan
              OR cb.purchased_remaining IS DISTINCT FROM live.purchased)
    `;
  } catch (err) {
    console.error(`⚠️ Could not refresh the credit balance cache for user ${user_id} (reading the cached value):`, err);
  }
};

export const getUserCreditBalance = async (user_id: number, credit_type: string): Promise<number> => {
  await refreshBalanceCache(user_id);
  const result = await sql`
    SELECT amount FROM credit_balances 
    WHERE user_id = ${user_id} AND credit_type = ${credit_type}
    LIMIT 1
  `;
  return result[0]?.amount || 0;
};

export const getUserCreditBalances = async (user_id: number): Promise<CreditBalance[]> => {
  await refreshBalanceCache(user_id);
  const result = await sql`
    SELECT * FROM credit_balances
    WHERE user_id = ${user_id}
    ORDER BY credit_type
  `;
  return result as unknown as CreditBalance[];
};

/**
 * Reset the PLAN (included) credits to the plan allotment for all credit types and
 * stamp a new cycle. Purchased credits are intentionally left untouched.
 *
 * Called on subscription creation and on every successful monthly invoice. Idempotent.
 *
 * Returns how many credits were granted, for the same reason
 * upgradeIncludedCredits does: the caller has to tell the customer the real
 * figure — Account Activity's "Subscription started" row showed no credits at
 * all, because the only way to fill that column was to re-derive the allotment
 * beside the call and hope the two agreed.
 */
export const refillPlanCredits = async (user_id: number, plan: any, reason = 'Plan credits refill'): Promise<number> => {
  let granted = 0;
  await sql.begin(async sql => {
    for (const creditType of CREDIT_TYPES) {
      const allotment = planAllotment(plan, creditType);

      // ── The refill no longer WIPES the previous cycle's credits ────────────
      // It used to set included_remaining = allotment, which meant last
      // month's unused plan credits vanished the instant the new grant landed.
      // Under a two-month life they are still the customer's to spend, so the
      // new grant is an additional LOT and the old one lives out its term.
      // Whichever expires first is spent first; see burnFromLots.
      const granted_lot = (await sql`
        INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, plan_id, reason)
        VALUES (${user_id}, 'plan', ${allotment}, ${allotment},
                NOW() + ${`${PLAN_CREDIT_LIFETIME_MONTHS} months`}::interval,
                ${plan?.id ?? null}, ${reason})
        RETURNING expires_at
      `) as unknown as Array<{ expires_at: Date }>;

      // ── Buying a plan absorbs what the free trial left ────────────────────
      // The trial's grant is a lot like any other, minted by the FREE plan. On
      // subscribing, the customer holds two plan balances that differ in
      // nothing they can see or act on — same source, same rules, both
      // spendable — so the card showed "Plan credits 600" above "Plan credits
      // 100" and invited the question of what the difference was. There is
      // none: the answer is one balance.
      //
      // The trial lot is moved onto THIS plan and carried out to this cycle's
      // expiry, which is the merge — the breakdown groups by (source, free or
      // paid, day), so matching all three is what makes them one row.
      //
      // GREATEST, never a plain assignment: the new expiry is later than the
      // trial's in every ordinary case, but a lot must never come out of this
      // with LESS life than it had. If that ever happened the two would stay
      // separate rows, which is the harmless half of the trade.
      //
      // Scoped to the FREE plan's own lots. A previous PAID cycle's lot is not
      // swept up: those expire on their own cycle's schedule, which is the
      // whole of "plan credits stay usable for two billing cycles".
      //
      // Only when this grant is itself a paid plan's — a free plan refilling
      // its own grant would otherwise extend the trial indefinitely.
      if (plan?.id && plan?.slug !== 'free' && granted_lot[0]?.expires_at) {
        await sql`
          UPDATE credit_lots cl
          SET    plan_id    = ${plan.id},
                 expires_at = GREATEST(cl.expires_at, ${granted_lot[0].expires_at}::timestamptz),
                 updated_at = NOW()
          FROM   subscription_plans sp
          WHERE  sp.id = cl.plan_id
            AND  sp.slug = 'free'
            AND  cl.user_id = ${user_id}
            AND  cl.source = 'plan'
            AND  cl.remaining > 0
            AND  cl.expires_at > NOW()
        `;
      }

      // included_allotment stays the plan's headline number (what a cycle
      // grants), which is what the usage bar and the upgrade bump compare
      // against; the spendable figure is re-derived from the lots.
      await sql`
        INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
        VALUES (${user_id}, ${creditType}, ${allotment}, ${allotment}, 0, NOW())
        ON CONFLICT (user_id, credit_type)
        DO UPDATE SET
          included_allotment = ${allotment},
          cycle_started_at   = NOW(),
          updated_at         = NOW()
      `;
      await syncBalanceCache(sql, user_id);

      await sql`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${user_id}, ${creditType}, ${allotment}, ${reason})
      `;

      granted += allotment;
    }
  });
  return granted;
};

/**
 * Add PURCHASED (top-up) credits to a single credit type. These persist across billing
 * cycles and are never wiped by a refill. Upserts so it works even if no row exists yet.
 */
export const addPurchasedCredits = async (
  user_id: number,
  credit_type: CreditType,
  quantity: number,
  reason = 'Credit purchase'
): Promise<void> => {
  await sql.begin(async sql => {
    // A purchase is its own lot on the 12-month lifetime, so two top-ups bought
    // months apart expire months apart rather than sharing one date.
    await sql`
      INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, reason)
      VALUES (${user_id}, 'purchased', ${quantity}, ${quantity},
              NOW() + ${`${PURCHASED_CREDIT_LIFETIME_MONTHS} months`}::interval, ${reason})
    `;

    // ── Every purchase renews the clock on ALL purchased credits ─────────────
    //
    // Product rule: purchased credits are valid for 12 months from the date of
    // purchase, and buying more resets that 12 months for the whole purchased
    // balance. Previously each top-up was an island with its own expiry, so a
    // regular customer accumulated a row of near-identical dates and the panel
    // could not state one honest "expiring" date for what they had bought.
    //
    // Only LIVE lots. The sweep zeroes `remaining` on lapse, so a wider
    // predicate would revive nothing — it would only rewrite dead rows and lose
    // the record of when they actually died.
    //
    // This can only ever EXTEND an expiry: the new date is 12 months out and
    // every existing live lot expires sooner than that by definition.
    await sql`
      UPDATE credit_lots
      SET    expires_at = NOW() + ${`${PURCHASED_CREDIT_LIFETIME_MONTHS} months`}::interval,
             updated_at = NOW()
      WHERE  user_id = ${user_id}
        AND  source = 'purchased'
        AND  remaining > 0
        AND  expires_at > NOW()
    `;
    await sql`
      INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
      VALUES (${user_id}, ${credit_type}, 0, 0, 0, NOW())
      ON CONFLICT (user_id, credit_type) DO NOTHING
    `;
    await syncBalanceCache(sql, user_id);
    await sql`
      INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
      VALUES (${user_id}, ${credit_type}, ${quantity}, ${reason})
    `;
  });
};

/**
 * Apply an immediate plan upgrade: raise the included allotment to the new plan and grant
 * the positive difference to the user's included balance right now (prorated upgrade bump).
 * Purchased credits are untouched.
 */
/**
 * Raise the included allotment to a new (higher) plan and grant the difference.
 *
 * @param prorationFactor  Fraction of the billing period still unused, 0..1.
 *   Defaults to 1 (grant the whole difference).
 *
 * ── Why the grant is prorated but the allotment is not (bug 5) ──────────────
 * These are two different numbers and conflating them is the trap:
 *
 *   included_allotment  = what the plan is WORTH PER CYCLE. Always the new
 *                         plan's full figure, so the next monthly refill (and
 *                         every "X of Y used" display) is correct.
 *   included_remaining  = what the user can spend RIGHT NOW. Upgrading with
 *                         four days left in the cycle should not hand over a
 *                         full month of extra credits for four days of paid
 *                         time — the customer was only charged a prorated
 *                         amount for those days, so they receive a matching
 *                         prorated share of the credit difference.
 *
 * Granting the full difference mid-cycle is an arbitrage: upgrade on the last
 * day of the cycle, pay a day's proration, collect a month of credits, then
 * downgrade. The proration factor closes that.
 */
/**
 * The expiry shared by THIS cycle's plan credits, or null when the cycle has none.
 *
 * ── WHY PLAN EXPIRY IS ANCHORED TO THE CYCLE ────────────────────────────────
 * Every grant used to set `expires_at = NOW() + PLAN_CREDIT_LIFETIME_MONTHS`,
 * which is right for a refill (a refill IS the start of a cycle) and wrong for
 * anything granted part-way through one. An upgrade on day 3 minted credits
 * expiring three days after the cycle's own — so a single billing cycle could
 * hold two or three plan expiry dates, days apart, for no reason the customer
 * could see. Production had exactly that: one account with three plan lots
 * across two expiry dates, all from the same cycle.
 *
 * It also made the product's own promise unverifiable. "Plan credits stay
 * usable for two billing cycles" is a statement about CYCLES, and credits that
 * expire on a grant-relative date do not honour it — they drift.
 *
 * Anchoring means a cycle has exactly one plan expiry, so a user can hold at
 * most two, which is what lets the balance panel say "last cycle" and "this
 * cycle" and be literally correct rather than approximately so.
 *
 * Returns null when this cycle has granted nothing yet, so callers fall back to
 * minting a fresh expiry rather than writing null into a NOT NULL column.
 */
async function currentCyclePlanExpiry(tx: any, user_id: number): Promise<Date | null> {
  const rows = await tx`
    SELECT MAX(l.expires_at) AS expires_at
    FROM   credit_lots l
    WHERE  l.user_id = ${user_id}
      AND  l.source = 'plan'
      AND  l.remaining > 0
      AND  l.expires_at > NOW()
      -- Granted during the current cycle. cycle_started_at is stamped by every
      -- refill, so this is the boundary the rest of the system already uses.
      AND  l.granted_at >= COALESCE(
             (SELECT cycle_started_at FROM credit_balances
               WHERE user_id = ${user_id} AND credit_type = ${ISEO_CREDIT_TYPE}),
             l.granted_at)
  `;
  return (rows[0] as any)?.expires_at ?? null;
}

export const upgradeIncludedCredits = async (
  user_id: number,
  newPlan: any,
  reason = 'Plan upgrade',
  prorationFactor: number = 1,
  /**
   * The plan the user is coming FROM.
   *
   * Passed in rather than looked up, because changePlan writes users.plan_id to
   * the NEW plan before calling this — so reading the current plan here would
   * compare the new plan against itself and grant a difference of zero. The
   * caller is the only one that still knows the previous plan by this point.
   */
  previousPlanSlug?: string | null,
  // Returns the credits actually granted, so the confirmation shown to the
  // customer can state the real figure instead of a second, independently
  // computed guess at it. Previously this returned void and the success message
  // could only say "Credits have been added" without saying how many.
): Promise<number> => {
  // Guard the factor — a bad cycle date must never invert or inflate a grant.
  const factor = Number.isFinite(prorationFactor)
    ? Math.min(1, Math.max(0, prorationFactor))
    : 1;

  let totalGranted = 0;

  await sql.begin(async sql => {
    for (const creditType of CREDIT_TYPES) {
      const newAllotment = planAllotment(newPlan, creditType);

      // From the PLAN, not from credit_balances.included_allotment — see
      // previewUpgradeCreditGrant for why that cached column cannot be trusted
      // to decide money. Both functions must read the same source, or the
      // figure disclosed before the upgrade stops matching the one granted
      // after it.
      const oldAllotment = previousPlanSlug ? grantForPlanSlug(previousPlanSlug) : 0;
      const fullDifference = Math.max(0, newAllotment - oldAllotment);

      // OLD (always the full difference, regardless of when in the cycle):
      // const bump = Math.max(0, newAllotment - oldAllotment);
      //
      // The arithmetic moved to creditBumpFor so that the confirmation dialog
      // can state this number BEFORE the upgrade and be certain it matches what
      // is granted after it. Two copies of a rounding rule is two answers.
      const bump = creditBumpFor(fullDifference, factor);
      totalGranted += bump;

      // The upgrade difference is its own plan lot, but it EXPIRES WITH THE
      // CYCLE IT BELONGS TO rather than two months from this instant. The
      // comment here used to say "mid-cycle extra credits should not outlive
      // the cycle's own" while the code did precisely that — see
      // currentCyclePlanExpiry. Falls back to a fresh expiry when the cycle has
      // granted nothing yet, which is the case for an upgrade off the free tier.
      if (bump > 0) {
        const cycleExpiry = await currentCyclePlanExpiry(sql, user_id);
        await sql`
          INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, plan_id, reason)
          VALUES (${user_id}, 'plan', ${bump}, ${bump},
                  COALESCE(
                    ${cycleExpiry}::timestamptz,
                    NOW() + ${`${PLAN_CREDIT_LIFETIME_MONTHS} months`}::interval
                  ),
                  ${newPlan?.id ?? null}, ${reason})
        `;
      }
      await sql`
        INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
        VALUES (${user_id}, ${creditType}, 0, ${newAllotment}, 0, NOW())
        ON CONFLICT (user_id, credit_type)
        DO UPDATE SET
          included_allotment = ${newAllotment},
          updated_at = NOW()
      `;
      await syncBalanceCache(sql, user_id);
      if (bump > 0) {
        // Record what was actually granted AND why it differs from the headline
        // plan difference, so support can explain a bill without re-deriving it.
        const detail = factor < 1
          ? `${reason} (prorated: ${bump} of ${fullDifference} for the remainder of the billing period)`
          : reason;
        await sql`
          INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
          VALUES (${user_id}, ${creditType}, ${bump}, ${detail})
        `;
      }
    }
  });


  return totalGranted;
};

/**
 * Fraction of the current billing period still unused, as 0..1.
 *
 * Falls back to 1 (treat as a full period) whenever the dates are missing or
 * nonsensical — an upgrade must never silently grant nothing because a
 * timestamp was null.
 */
export const remainingCycleFraction = (
  cycleStart: Date | string | null | undefined,
  cycleEnd: Date | string | null | undefined
): number => {
  if (!cycleStart || !cycleEnd) return 1;
  const start = new Date(cycleStart).getTime();
  const end = new Date(cycleEnd).getTime();
  const now = Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  if (now >= end) return 0;
  if (now <= start) return 1;
  return (end - now) / (end - start);
};

/**
 * How many credits an upgrade adds today, given the whole-cycle difference and
 * how much of the cycle is left.
 *
 * Extracted so the DISCLOSURE and the GRANT run the same line of code. The
 * confirmation dialog now states this figure before the customer agrees, and a
 * second implementation of the rounding rule is a second answer that can
 * disagree with the first — the same reason no money figure in this codebase is
 * computed twice.
 *
 * Rounds rather than floors so a genuine upgrade never grants 0 credits near
 * the end of a cycle; a paid upgrade should always give something.
 */
export const creditBumpFor = (fullDifference: number, prorationFactor: number): number => {
  // Guard the factor — a bad cycle date must never invert or inflate a grant.
  const factor = Number.isFinite(prorationFactor)
    ? Math.min(1, Math.max(0, prorationFactor))
    : 1;
  return fullDifference > 0 ? Math.max(1, Math.round(fullDifference * factor)) : 0;
};

/**
 * Is the prorated credit grant switched on?
 *
 * ── FLAG: BILLING_PRORATED_CREDITS_ENABLED ─────────────────────────────────
 * Prorating changes how many credits a paying customer receives, so it stays
 * OFF until verified against a real billing cycle. Off = the previous behaviour
 * exactly: the full plan difference, granted regardless of cycle position.
 *
 * Read through ONE function so the preview and the commit cannot end up on
 * opposite sides of the flag — which would have the dialog promise a prorated
 * figure while the grant handed out the full one, or vice versa.
 */
export const proratedCreditsEnabled = (): boolean =>
  String(process.env.BILLING_PRORATED_CREDITS_ENABLED || '').toLowerCase() === 'true';

/** What an upgrade will do to the credit balance. */
export interface UpgradeCreditGrant {
  /** Credits added to the balance today. */
  granted_now: number;
  /** What a full cycle's difference would have been. */
  full_difference: number;
  /** Monthly allotment after the change. */
  new_allotment: number;
  /** Monthly allotment before it. */
  previous_allotment: number;
  /** True when granted_now was scaled down for the part-cycle. */
  prorated: boolean;
}

/**
 * Work out what changePlan WOULD grant, without granting anything.
 *
 * The read-only twin of the grant inside upgradeIncludedCredits, sharing its
 * allotment lookup, its proration factor and its rounding. Exists so BILL-003's
 * "tell them before you charge them" extends to what they RECEIVE, not just
 * what they pay: an upgrade that costs a prorated $8.40 and quietly grants a
 * prorated share of the credits was disclosing half the transaction.
 */
export const previewUpgradeCreditGrant = async (
  user_id: number,
  newPlan: any,
  cycleEnd: Date | string | null | undefined,
): Promise<UpgradeCreditGrant> => {
  const creditType = ISEO_CREDIT_TYPE;
  const newAllotment = planAllotment(newPlan, creditType);

  const rows = await sql`
    SELECT cb.cycle_started_at, sp.slug AS current_plan_slug
    FROM   credit_balances cb
    LEFT   JOIN users u ON u.id = cb.user_id
    LEFT   JOIN subscription_plans sp ON sp.id = u.plan_id
    WHERE  cb.user_id = ${user_id} AND cb.credit_type = ${creditType}
    LIMIT  1
  `;

  // ── Measured against the PLAN, not against a cached column ────────────────
  // This used to read credit_balances.included_allotment. That column is a
  // cached copy of the plan's grant, and it drifts: user 1 was on Pro with the
  // column reading 0, so an upgrade preview offered the FULL 1150 rather than
  // the difference. Stale in the other direction it under-grants, which is how
  // a grow→optimize→scale sequence appeared to count only the last step.
  //
  // grantForPlanSlug is the same function the monthly refill uses to decide the
  // allotment in the first place, so the difference is now derived from the
  // same source of truth as the grant it is a difference of.
  const previousAllotment = rows[0]?.current_plan_slug
    ? grantForPlanSlug(rows[0].current_plan_slug)
    : 0;
  const fullDifference = Math.max(0, newAllotment - previousAllotment);

  const factor = proratedCreditsEnabled()
    ? remainingCycleFraction(rows[0]?.cycle_started_at, cycleEnd)
    : 1;

  const grantedNow = creditBumpFor(fullDifference, factor);

  return {
    granted_now: grantedNow,
    full_difference: fullDifference,
    new_allotment: newAllotment,
    previous_allotment: previousAllotment,
    // Only claim proration when it actually reduced the grant — a mid-cycle
    // upgrade at factor 1.0, or one where rounding lands on the full figure,
    // must not be labelled "prorated" when nothing was taken off.
    prorated: grantedNow < fullDifference,
  };
};

/**
 * Suspend access by zeroing the PLAN (included) credits only — e.g. on a failed renewal
 * or a bad subscription status. Purchased credits are preserved (the user paid for them).
 */
export const suspendPlanCredits = async (
  user_id: number,
  reason = 'Subscription suspended',
  options: {
    /**
     * Checked INSIDE the transaction, before anything is voided; returning
     * false voids nothing. For a caller whose decision can go stale between
     * reading the account and writing to it — see reconcileTrialCredits.
     */
    onlyIf?: (tx: any) => Promise<boolean>;
  } = {},
): Promise<boolean> => {
  // Resolves to whether the suspension ran (false only when `onlyIf` refused).
  return sql.begin(async sql => {
    if (options.onlyIf && !(await options.onlyIf(sql))) return false;

    // ── Void the LOTS, not the cache ──────────────────────────────────────
    // This zeroed credit_balances.included_remaining and nothing else. Once the
    // balance became derived, that stopped suspending anything at all: the next
    // read re-computed the cache from the untouched lots and the credits came
    // straight back.
    //
    // The consequence was silent and ongoing — reconcileTrialCredits calls this
    // on trial expiry, so expired trials carried on generating. Nobody reports
    // a bug that gives them more than they paid for.
    //
    // Purchased lots are deliberately untouched: the user paid for those
    // separately, and suspension is about the PLAN's allotment.
    const lots = (await sql`
      SELECT id, remaining FROM credit_lots
      WHERE user_id = ${user_id} AND source = 'plan' AND remaining > 0
      FOR UPDATE
    `) as unknown as Array<{ id: number; remaining: number }>;

    const voided = lots.reduce((n, l) => n + Number(l.remaining), 0);

    if (lots.length > 0) {
      await sql`
        UPDATE credit_lots SET remaining = 0, updated_at = NOW()
        WHERE id = ANY(${lots.map((l) => l.id)})
      `;
    }

    await syncBalanceCache(sql, user_id);

    if (voided > 0) {
      await sql`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${user_id}, ${ISEO_CREDIT_TYPE}, ${-voided}, ${reason})
      `;
    }

    return true;
  });
};

/** Is this a free ($0) plan? A missing/unknown plan is treated as free (fail-safe). */
export const isFreePlanId = async (plan_id?: number | null): Promise<boolean> => {
  if (!plan_id) return true;
  const rows = await sql`SELECT price_cents FROM subscription_plans WHERE id = ${plan_id} LIMIT 1`;
  return !rows[0] || Number(rows[0].price_cents) === 0;
};

/**
 * Is this account STILL on the free tier with no paid subscription running?
 * Read inside the suspension's transaction, with the user row locked.
 *
 * ── WHY reconcileTrialCredits CANNOT TRUST ITS OWN ARGUMENT ─────────────────
 * It is handed a user row loaded at the START of a request. Coming back from
 * Stripe, the CMS fires /users/by-email, /users/credits and friends while
 * /verify-session (or the subscription webhook) is activating the new plan.
 * A request that loaded the account a moment earlier still holds the free
 * plan_id, sees the freshly granted Grow lot as "trial credits left", voids
 * it, and writes "Free trial ended — moved to Basic plan" — onto a customer
 * who has just paid for Grow. QA saw exactly that row.
 *
 * ── WHY THE LOCK MAKES IT SAFE ──────────────────────────────────────────────
 * activateSubscriptionInDb writes the subscriptions row, then UPDATE users,
 * then refills plan credits. Holding the users row FOR UPDATE here means:
 *   • activation already updated users → this reads the paid plan and refuses;
 *   • it had not → its UPDATE waits for this commit, so the refill lands AFTER
 *     the trial credits are voided, never before.
 * The live-subscription check covers the window between its two writes.
 *
 * Same "free" rule as isFreePlanId: no plan, an unknown plan, or a $0 plan.
 */
const stillOnFreeTierLocked = async (tx: any, user_id: number): Promise<boolean> => {
  const rows = await tx`
    SELECT sp.price_cents
    FROM users u
    LEFT JOIN subscription_plans sp ON sp.id = u.plan_id
    WHERE u.id = ${user_id}
    FOR UPDATE OF u
  `;
  if (rows.length === 0) return false;
  const price = rows[0].price_cents;
  if (price !== null && price !== undefined && Number(price) !== 0) return false;

  const subs = await tx`SELECT status FROM subscriptions WHERE user_id = ${user_id}`;
  return !subs.some((s: { status: string | null }) => isLiveStatus(s.status));
};

/**
 * Reconcile a user's credits against their trial state. When a free-plan account's trial has
 * expired, void the PLAN (trial) credits so every READ reflects the truth immediately — not
 * only after a generation attempt. Purchased top-ups are always preserved (the user paid).
 *
 * Idempotent and cheap to call on hot read paths: it only writes when there is something left
 * to void, so repeated status polls after the first reconcile are read-only.
 *
 * Returns true when the account is a free-plan user whose trial has expired (i.e. plan credits
 * are now void), so callers can surface a `trial_expired` flag without recomputing it.
 */
export const reconcileTrialCredits = async (
  user: { id: number; plan_id?: number | null; trial_ends_at?: Date | null; created_at?: Date | null }
): Promise<boolean> => {
  if (!isTrialExpired(user)) return false;
  if (!(await isFreePlanId(user.plan_id))) return false;
  const pending = await sql`
    SELECT 1 FROM credit_balances
    WHERE user_id = ${user.id} AND included_remaining > 0
    LIMIT 1
  `;
  if (pending.length > 0) {
    // Re-checked under a lock rather than trusted from `user`, which was loaded
    // when the request began — see stillOnFreeTierLocked for the race this
    // closes: a just-paid Grow grant voided, and "Free trial ended" written onto
    // an account that had subscribed.
    const suspended = await suspendPlanCredits(user.id, 'Trial expired', {
      onlyIf: (tx) => stillOnFreeTierLocked(tx, user.id),
    });
    // It subscribed after this request read it: paying, not an expired trial.
    // Nothing voided, and no activity row.
    if (!suspended) return false;

    // Written HERE, inside the one-time suspension, not beside the `return true`
    // below. This function runs on every authenticated plugin request and keeps
    // returning true for the whole life of an expired-trial account; only this
    // branch happens once, because it is what drives included_remaining to 0.
    //
    // The event id still pins it to the trial's own end date, so a re-entry
    // (say, credits granted and expired again) upserts rather than duplicating.
    try {
      await recordTransaction(sql, {
        userId: user.id,
        type: 'plan_downgrade',
        description: describeTrialEnded(),
        amountCents: null,
        status: 'succeeded',
        providerEventId: `trial_ended:${user.id}:${effectiveTrialEnd(user)?.toISOString() ?? 'na'}`,
      });
    } catch (err) {
      console.warn('Could not record the trial-ended activity row (non-fatal):', err);
    }
  }
  return true;
};

export const getUserSubscription = async (user_id: number) => {
  const result = await sql`
    SELECT 
      s.*,
      sp.name as plan_name,
      sp.slug as plan_slug,
      sp.price_cents as plan_price,
      sp.image_credits as plan_image_credits,
      sp.content_credits as plan_content_credits,
      sp.keyword_credits as plan_keyword_credits,
      sp.scheduled_publishing,
      sp.course_access,
      pending_sp.name as pending_plan_name,
      pending_sp.slug as pending_plan_slug
    FROM subscriptions s
    LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
    LEFT JOIN subscription_plans pending_sp ON s.pending_plan_id = pending_sp.id
    WHERE s.user_id = ${user_id}
    ORDER BY s.created_at DESC
    LIMIT 1
  `;
  return result[0] || null;
};

// Get all available subscription plans
export const getAllSubscriptionPlans = async () => {
  const result = await sql`
    SELECT * FROM subscription_plans
    ORDER BY price_cents ASC
  `;
  return result;
};

// Change subscription plan (upgrade/downgrade)
/**
 * Move a user between plans.
 *
 * Returns how many credits the change granted, so the caller can tell the
 * customer the actual number. It used to return nothing, which is why the
 * upgrade confirmation could only manage the vague "Credits have been added to
 * your account" — the route had no way to know how many.
 */
export const changePlan = async (
  user_id: number, 
  new_plan_id: number, 
  immediate: boolean = true
): Promise<{ creditsGranted: number }> => {
  let creditsGranted = 0;
  const currentSub = await getUserSubscription(user_id);
  
  if (!currentSub) {
    throw new Error('No active subscription found');
  }

  // Captured BEFORE the transaction below writes users.plan_id to the new plan.
  // After that write, nothing else in this function can still say what the user
  // was upgrading FROM, and the credit difference depends on it.
  const previousPlanSlug: string | null = currentSub.plan_slug ?? null;

  if (immediate) {
    // UPGRADE: Immediate effect + raise included allotment / grant the difference now.
    await sql.begin(async sql => {
      // Update subscription.
      //
      // BUG 10 — clear any scheduled cancellation. Choosing a new plan is an
      // unambiguous "I am staying", so leaving cancel_at_period_end set is
      // simply wrong data, and it is what kept the CMS's "Cancellation
      // Scheduled" banner on screen after a resubscribe. Also clears
      // pending_plan_id, since an immediate change supersedes any downgrade
      // that was queued for the end of the period.
      //
      // OLD:
      //   UPDATE subscriptions
      //   SET previous_plan_id = plan_id, plan_id = ${new_plan_id}
      //   WHERE user_id = ${user_id}
      await sql`
        UPDATE subscriptions
        SET
          previous_plan_id = plan_id,
          plan_id = ${new_plan_id},
          status = 'active',
          cancel_at_period_end = FALSE,
          pending_plan_id = NULL,
          pending_plan_effective_date = NULL
        WHERE user_id = ${user_id}
      `;

      // Also update user's plan_id for consistency
      await sql`
        UPDATE users
        SET plan_id = ${new_plan_id}
        WHERE id = ${user_id}
      `;
    });

    // Raise the included allotment to the new plan and grant the upgrade
    // difference, PRORATED to the unused part of the current cycle so the
    // credits granted match the prorated amount actually charged (bug 5).
    // Purchased (top-up) credits are preserved. Runs in its own transaction.
    const newPlan = await sql`SELECT * FROM subscription_plans WHERE id = ${new_plan_id}`;
    if (newPlan.length > 0) {
      const cycleRows = await sql`
        SELECT cycle_started_at FROM credit_balances
        WHERE user_id = ${user_id}
        ORDER BY cycle_started_at DESC
        LIMIT 1
      `;
      // The flag is read through proratedCreditsEnabled() so this path and the
      // preview that quoted the customer cannot land on opposite sides of it.
      const factor = proratedCreditsEnabled()
        ? remainingCycleFraction(cycleRows[0]?.cycle_started_at, currentSub.next_billing_date)
        : 1;
      creditsGranted = await upgradeIncludedCredits(
        user_id, newPlan[0], 'Plan upgrade credit bonus', factor, previousPlanSlug,
      );
    }
  } else {
    // DOWNGRADE: Schedule for next billing date.
    //
    // cancel_at_period_end is cleared here for the same reason the upgrade
    // branch clears it: choosing a plan to move TO is a statement that the
    // customer is staying. Leaving it set produced a subscription that was
    // simultaneously "changing to Grow next month" and "ending next month" —
    // contradictory data that the CMS then had to render, and the state real
    // accounts were found sitting in.
    //
    // OLD (pending_plan_id and status only):
    //   SET pending_plan_id = …, pending_plan_effective_date = …, status = …
    await sql`
      UPDATE subscriptions
      SET
        pending_plan_id = ${new_plan_id},
        pending_plan_effective_date = next_billing_date,
        status = 'pending_downgrade',
        cancel_at_period_end = FALSE
      WHERE user_id = ${user_id}
    `;
  }

  return { creditsGranted };
};

// Pause subscription
export const pauseSubscription = async (user_id: number, stripe_subscription_id: string) => {
  await sql`
    UPDATE subscriptions
    SET 
      status = 'paused',
      pause_requested_at = NOW()
    WHERE user_id = ${user_id} AND stripe_subscription_id = ${stripe_subscription_id}
  `;
};

// Resume subscription
export const resumeSubscription = async (user_id: number) => {
  await sql`
    UPDATE subscriptions
    SET 
      status = 'active',
      pause_requested_at = NULL
    WHERE user_id = ${user_id}
  `;
};

// Cancel subscription (at period end)
export const cancelSubscription = async (user_id: number) => {
  await sql`
    UPDATE subscriptions
    SET 
      cancel_at_period_end = TRUE,
      cancelled_at = NOW()
    WHERE user_id = ${user_id}
  `;
};

export const getUserAnalytics = async (user_id: number) => {
  const result = await sql`
    SELECT 
      COUNT(*) as total_generations,
      COUNT(CASE WHEN status = 'success' THEN 1 END) as successful_generations,
      COUNT(CASE WHEN status = 'error' THEN 1 END) as failed_generations,
      COUNT(CASE WHEN created_at >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 END) as this_month,
      CASE 
        WHEN COUNT(*) > 0 THEN 
          ROUND((COUNT(CASE WHEN status = 'success' THEN 1 END) * 100.0 / COUNT(*)), 1)
        ELSE 0 
      END as success_rate
    FROM user_generations 
    WHERE user_id = ${user_id}
  `;
  
  const analytics = result[0] || {
    total_generations: 0,
    successful_generations: 0,
    failed_generations: 0,
    this_month: 0,
    success_rate: 0
  };
  
  return {
    totalGenerations: parseInt(analytics.total_generations),
    successfulGenerations: parseInt(analytics.successful_generations),
    failedGenerations: parseInt(analytics.failed_generations),
    thisMonth: parseInt(analytics.this_month),
    successRate: parseFloat(analytics.success_rate)
  };
};

export const getUserGenerations = async (user_id: number, options: { limit?: number; offset?: number } = {}) => {
  const { limit = 10, offset = 0 } = options;
  
  const result = await sql`
    SELECT * FROM user_generations 
    WHERE user_id = ${user_id}
    ORDER BY created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  
  return result;
};

export const getUserWebsiteStats = async (user_id: number) => {
  const result = await sql`
    SELECT 
      w.id,
      w.domain,
      w.site_code,
      COUNT(ug.id) as total_generations,
      COUNT(CASE WHEN ug.status = 'success' THEN 1 END) as successful_generations,
      CASE 
        WHEN COUNT(ug.id) > 0 THEN 
          ROUND((COUNT(CASE WHEN ug.status = 'success' THEN 1 END) * 100.0 / COUNT(ug.id)), 1)
        ELSE 0 
      END as success_rate,
      MAX(ug.created_at) as last_activity
    FROM websites w
    LEFT JOIN user_generations ug ON w.id = ug.website_id
    WHERE w.user_id = ${user_id} AND w.active = true
    GROUP BY w.id, w.domain, w.site_code
    ORDER BY w.created_at DESC
  `;
  
  return result.map((row: any) => ({
    ...row,
    totalGenerations: parseInt(row.total_generations),
    successfulGenerations: parseInt(row.successful_generations),
    successRate: parseFloat(row.success_rate)
  }));
};

export const deductCredits = async (
  user_id: number, 
  credit_type: string, 
  amount: number, 
  reason: string,
  website_id?: number,
  generation_id?: number
) => {
  await sql.begin(async sql => {
    // Earliest-expiring lot first — see burnFromLots for why bucket order is no
    // longer the same thing as expiry order.
    //
    // Unlike reserveCredits this path does not refuse when short: it is the
    // legacy settle-after-work caller, and failing here would mean work already
    // done and not paid for. burnFromLots spends what it can and the shortfall
    // is visible in the ledger.
    await burnFromLots(sql, user_id, amount);
    await syncBalanceCache(sql, user_id);

    // Log transaction with website_id and generation_id
    await sql`
      INSERT INTO credit_transactions (user_id, credit_type, delta, reason, website_id, generation_id)
      VALUES (
        ${user_id},
        ${credit_type},
        ${-amount},
        ${reason},
        ${website_id || null},
        ${generation_id || null}
      )
    `;
  });
};
/**
 * Outcome of a credit reservation. `ok: false` means the user could not afford the action and
 * NOTHING was debited — the caller must return 402 and must not call the model.
 */
export interface ReserveResult {
  ok: boolean;
  included_remaining: number;
  purchased_remaining: number;
}

/** What a user actually holds, by lot, after expiry is applied. */
export interface LiveBalance {
  total: number;
  plan: number;
  purchased: number;
  /** The soonest expiry among live lots, for the balance panel. */
  next_expiry_at: Date | null;
  next_expiry_amount: number;
}

/**
 * Spend `amount`, earliest-expiring lot first (FEFO).
 *
 * ── WHY THE ORDER IS NOT "PLAN, THEN PURCHASED" ─────────────────────────────
 * That was the old rule, and it was a stand-in for this one: plan credits used
 * to be the only ones that expired, so draining them first happened to spend
 * the perishable stock first. Once purchased credits expire too — and once a
 * two-month plan life means a user routinely holds TWO plan grants with
 * different dates — bucket order and expiry order stop agreeing, and spending
 * by bucket would let a customer's older credits lapse while their newer ones
 * were spent. Ordering by expires_at is the rule the product actually promises.
 *
 * ── WHY IT IS SAFE UNDER CONCURRENCY ────────────────────────────────────────
 * Each lot is decremented by a single conditional UPDATE whose WHERE clause is
 * the affordability check for that lot, so two concurrent burns cannot both
 * claim the same credits — the loser simply sees fewer rows and moves to the
 * next lot. The whole walk runs inside the caller's transaction, so a burn that
 * cannot be completed rolls back rather than leaving a partial debit. This
 * preserves the property reserveCredits was written for; see its docblock.
 *
 * Returns ok:false having changed nothing when the balance is short.
 */
async function burnFromLots(
  tx: any,
  user_id: number,
  amount: number,
): Promise<{ ok: boolean; plan_remaining: number; purchased_remaining: number }> {
  // Lock the candidate lots so a concurrent burn cannot read the same rows and
  // double-spend them. FOR UPDATE is what makes the read-then-write below safe;
  // the per-lot WHERE guard is the second line of defence.
  const lots = (await tx`
    SELECT id, remaining
    FROM   credit_lots
    WHERE  user_id = ${user_id} AND remaining > 0 AND expires_at > NOW()
    ORDER  BY expires_at ASC, id ASC
    FOR UPDATE
  `) as unknown as Array<{ id: number; remaining: number }>;

  const available = lots.reduce((n, l) => n + Number(l.remaining), 0);
  if (available < amount) {
    return { ok: false, plan_remaining: 0, purchased_remaining: 0 };
  }

  let outstanding = amount;
  for (const lot of lots) {
    if (outstanding <= 0) break;
    const take = Math.min(Number(lot.remaining), outstanding);
    await tx`
      UPDATE credit_lots
      SET remaining = remaining - ${take}, updated_at = NOW()
      WHERE id = ${lot.id} AND remaining >= ${take}
    `;
    outstanding -= take;
  }

  const after = (await tx`
    SELECT source, COALESCE(SUM(remaining), 0)::int AS n
    FROM   credit_lots
    WHERE  user_id = ${user_id} AND remaining > 0 AND expires_at > NOW()
    GROUP  BY source
  `) as unknown as Array<{ source: string; n: number }>;

  const bySource = (s: string) => Number(after.find((r) => r.source === s)?.n ?? 0);
  return { ok: true, plan_remaining: bySource('plan'), purchased_remaining: bySource('purchased') };
}

/**
 * Re-derive credit_balances from the lots, inside the caller's transaction.
 *
 * credit_balances is a READ-THROUGH CACHE now, never an independent source. It
 * is kept because a great deal already reads it (the credits endpoint, the
 * notification queries, the CMS), and because summing lots on every read would
 * be wasteful. The rule that makes it safe is that nothing writes it except
 * here, in the same transaction as the lot change that caused it — the moment
 * two writers maintain the same number independently you get the 3090-vs-1139
 * divergence this whole change exists to remove.
 *
 * `amount` is a GENERATED column (included + purchased) and is never written.
 */
export async function syncBalanceCache(tx: any, user_id: number): Promise<void> {
  await tx`
    INSERT INTO credit_balances (user_id, credit_type, included_remaining, purchased_remaining, included_allotment, cycle_started_at)
    SELECT ${user_id}, ${ISEO_CREDIT_TYPE},
           COALESCE(SUM(remaining) FILTER (WHERE source = 'plan'), 0)::int,
           COALESCE(SUM(remaining) FILTER (WHERE source = 'purchased'), 0)::int,
           COALESCE((SELECT included_allotment FROM credit_balances
                     WHERE user_id = ${user_id} AND credit_type = ${ISEO_CREDIT_TYPE}), 0),
           COALESCE((SELECT cycle_started_at FROM credit_balances
                     WHERE user_id = ${user_id} AND credit_type = ${ISEO_CREDIT_TYPE}), NOW())
    FROM   credit_lots
    WHERE  user_id = ${user_id} AND remaining > 0 AND expires_at > NOW()
    ON CONFLICT (user_id, credit_type) DO UPDATE SET
      included_remaining  = EXCLUDED.included_remaining,
      purchased_remaining = EXCLUDED.purchased_remaining,
      updated_at = NOW()
  `;
}


/** One row of the balance breakdown: a batch of credits sharing an expiry date. */
export interface CreditLotBucket {
  source: 'plan' | 'purchased';
  /**
   * True when this 'plan' batch was granted by the FREE plan specifically —
   * a Free Trial's allotment, not a paid subscription's. Always false for a
   * 'purchased' batch. Additive: `source` keeps its existing two values and
   * meaning (a consumer that only reads `source` sees exactly what it always
   * has), so nothing that already reads this shape can be broken by it — the
   * same reasoning `balance`/`lots` were themselves added under. See the
   * plugin's connection panel, the one consumer that reads this field today.
   */
  is_free: boolean;
  /** The day they lapse, as YYYY-MM-DD. A day, not an instant — see below. */
  expires_on: string;
  remaining: number;
}

/**
 * The live balance broken into the batches the customer actually holds.
 *
 * getLiveBalance answers "how much, and when does the soonest batch go". The
 * panel needs more than that: it lists every batch with its own date, so
 * somebody can see that 214 credits lapse next month while 580 do not.
 *
 * Grouped by UTC DAY rather than by `expires_at` itself. Lots created seconds
 * apart carry different timestamps but lapse on the same date, and the customer
 * thinks in dates — one row per day is the honest unit, and it is the same
 * bucketing the expiry-warning emails already use.
 *
 * Ordered soonest-first, which is both the order the panel displays and the
 * order the credits will actually be spent (FEFO).
 *
 * ── WHY THE JOIN, AND WHY is_free IS NOT source ─────────────────────────────
 * credit_lots.source only ever holds 'plan' or 'purchased' (a DB CHECK
 * constraint) — a Free Trial's grant and a paid plan's grant are BOTH
 * written as 'plan' (initializeUserCredits), so nothing in this table alone
 * says which one a given lot is. subscription_plans (via plan_id) is what
 * actually knows that.
 *
 * is_free is a NEW field, not a new value of `source`, on purpose: this
 * function also backs the CMS's own breakdown panel (GET /credits/:user_id),
 * whose utils/creditBreakdown.js reads `source === 'plan'` the same way the
 * plugin's connection panel does. Widening what `source` itself can be would
 * make every free-trial lot silently fall into that code's "else = purchased"
 * branch — a regression there, not a fix. Adding a field neither existing
 * reader looks at is safe by construction.
 *
 * A purchased lot's plan_id is always NULL, so the LEFT JOIN finds no plan
 * for it and is_free reads false — no extra filtering needed to keep
 * purchased lots out of this.
 */
export const getCreditLotSummary = async (user_id: number): Promise<CreditLotBucket[]> => {
  const rows = await sql`
    SELECT cl.source,
           COALESCE(sp.slug = 'free', false) AS is_free,
           to_char((cl.expires_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS expires_on,
           COALESCE(SUM(cl.remaining), 0)::int AS remaining
    FROM   credit_lots cl
    LEFT JOIN subscription_plans sp ON sp.id = cl.plan_id
    WHERE  cl.user_id = ${user_id} AND cl.remaining > 0 AND cl.expires_at > NOW()
    -- Grouped by the free/paid BOOLEAN, not by sp.slug. Grouping on the slug
    -- itself split batches that differ only in which plan minted them: a
    -- mid-cycle upgrade leaves the original grant on the old plan's id and the
    -- bump on the new one, and since upgradeIncludedCredits anchors the bump to
    -- the cycle's own expiry (currentCyclePlanExpiry) both lapse on the SAME
    -- day. A grow→optimize account therefore saw two "Plan credits" rows,
    -- identical date, no visible reason for being apart — and, because the CMS
    -- keys rows on (source, date), two rows with the same key.
    --
    -- The distinction worth keeping is the one is_free already names: a free
    -- trial's grant is zeroed when the trial ends (suspendPlanCredits) whatever
    -- its stored date says, so it genuinely does not lapse with a paid lot that
    -- shares its day. Every paid slug behaves identically and belongs together.
    GROUP  BY cl.source, COALESCE(sp.slug = 'free', false), (cl.expires_at AT TIME ZONE 'UTC')::date
    ORDER  BY (cl.expires_at AT TIME ZONE 'UTC')::date ASC, cl.source ASC
  `;
  return (rows as unknown as CreditLotBucket[]).map((r) => ({
    source: r.source,
    is_free: !!r.is_free,
    expires_on: r.expires_on,
    remaining: Number(r.remaining) || 0,
  }));
};

/** What the user can actually spend right now, with the next expiry. */
export const getLiveBalance = async (user_id: number): Promise<LiveBalance> => {
  const rows = (await sql`
    SELECT source, COALESCE(SUM(remaining), 0)::int AS n
    FROM   credit_lots
    WHERE  user_id = ${user_id} AND remaining > 0 AND expires_at > NOW()
    GROUP  BY source
  `) as unknown as Array<{ source: string; n: number }>;

  // Grouped by DAY, not by the raw timestamp. Two lots granted minutes apart —
  // a refill and an upgrade bonus, say — expire at different instants on the
  // same date, and grouping by instant split them into two buckets so this
  // reported only the first. The customer then saw "42 expiring on Oct 19" when
  // 600 were.
  const next = (await sql`
    SELECT (expires_at AT TIME ZONE 'UTC')::date AS expires_at,
           COALESCE(SUM(remaining), 0)::int AS n
    FROM   credit_lots
    WHERE  user_id = ${user_id} AND remaining > 0 AND expires_at > NOW()
    GROUP  BY (expires_at AT TIME ZONE 'UTC')::date
    ORDER  BY (expires_at AT TIME ZONE 'UTC')::date ASC
    LIMIT  1
  `) as unknown as Array<{ expires_at: Date; n: number }>;

  const bySource = (s: string) => Number(rows.find((r) => r.source === s)?.n ?? 0);
  const plan = bySource('plan');
  const purchased = bySource('purchased');

  return {
    total: plan + purchased,
    plan,
    purchased,
    next_expiry_at: next[0]?.expires_at ?? null,
    next_expiry_amount: Number(next[0]?.n ?? 0),
  };
};

/**
 * Add a lot. The single entry point for creating credits, so every credit in
 * the system has an expiry date by construction rather than by remembering.
 */
export const grantCreditLot = async (
  user_id: number,
  source: 'plan' | 'purchased',
  amount: number,
  opts: { reason?: string; planId?: number | null; providerObjectId?: string | null; expiresAt?: Date } = {},
): Promise<void> => {
  if (!Number.isInteger(amount) || amount <= 0) return;
  const months = source === 'plan' ? PLAN_CREDIT_LIFETIME_MONTHS : PURCHASED_CREDIT_LIFETIME_MONTHS;

  await sql.begin(async (tx) => {
    if (opts.expiresAt) {
      await tx`
        INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, plan_id, provider_object_id, reason)
        VALUES (${user_id}, ${source}, ${amount}, ${amount}, ${opts.expiresAt},
                ${opts.planId ?? null}, ${opts.providerObjectId ?? null}, ${opts.reason ?? null})
      `;
    } else {
      await tx`
        INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, plan_id, provider_object_id, reason)
        VALUES (${user_id}, ${source}, ${amount}, ${amount},
                NOW() + ${`${months} months`}::interval,
                ${opts.planId ?? null}, ${opts.providerObjectId ?? null}, ${opts.reason ?? null})
      `;
    }
    await syncBalanceCache(tx, user_id);
    await tx`
      INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
      VALUES (${user_id}, ${ISEO_CREDIT_TYPE}, ${amount}, ${opts.reason ?? 'Credits granted'})
    `;
  });
};

/**
 * Expire lapsed lots and record the loss.
 *
 * Zeroes `remaining` rather than deleting the row, so the ledger can point at
 * the lot that lapsed when a customer asks where their credits went. Returns
 * per-user totals so the caller can log or alert on them.
 */
export const expireLapsedLots = async (): Promise<Array<{ user_id: number; expired: number }>> => {
  return await sql.begin(async (tx) => {
    // Read what is about to be lost BEFORE zeroing it. An UPDATE ... RETURNING
    // hands back the post-update value, so the amount would come back as 0 and
    // every ledger row would say "0 credits expired".
    //
    // FOR UPDATE so a burn running concurrently cannot spend these between the
    // read and the write — the customer would then be debited for credits this
    // statement is about to declare expired.
    const lapsed = (await tx`
      SELECT id, user_id, remaining
      FROM   credit_lots
      WHERE  remaining > 0 AND expires_at <= NOW()
      FOR UPDATE
    `) as unknown as Array<{ id: number; user_id: number; remaining: number }>;

    if (lapsed.length === 0) return [];

    const perUser = new Map<number, number>();
    for (const lot of lapsed) {
      perUser.set(lot.user_id, (perUser.get(lot.user_id) ?? 0) + Number(lot.remaining));
    }

    await tx`
      UPDATE credit_lots SET remaining = 0, updated_at = NOW()
      WHERE id = ANY(${lapsed.map((l) => l.id)})
    `;

    const results: Array<{ user_id: number; expired: number }> = [];
    for (const [userId, expired] of perUser) {
      await syncBalanceCache(tx, userId);
      // Negative delta: this is a loss, and the ledger should read as one.
      await tx`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${userId}, ${ISEO_CREDIT_TYPE}, ${-expired}, 'Credits expired')
      `;
      results.push({ user_id: userId, expired });
    }
    return results;
  });
};

/**
 * Atomically reserve credits BEFORE doing paid work (reserve-then-settle).
 *
 * Why this exists: deductCredits() above reads the balance and then writes it. Under the default
 * READ COMMITTED isolation two concurrent requests both read the same value, both pass their
 * check and both write — so the balance can go negative. A bulk run reproduces it trivially.
 *
 * Here the check and the debit are ONE conditional statement. The WHERE clause is the check, so
 * the database decides affordability; concurrency cannot interleave between the two. Zero rows
 * returned means "could not afford" — there is no partial state to unwind.
 *
 * Plan (included) credits drain first so the expiring allotment is spent before credits the user
 * paid extra for. Both SET expressions read the row's OLD values, which is what makes the
 * two-bucket split correct in a single statement.
 *
 * NOTE: credit_balances.amount is a GENERATED column (included + purchased) — never write it.
 */
export const reserveCredits = async (
  user_id: number,
  credit_type: string,
  amount: number,
  reason: string,
  website_id?: number,
  generation_id?: number,
): Promise<ReserveResult> => {
  if (!Number.isInteger(amount) || amount <= 0) {
    // A zero/negative/fractional price is a configuration bug, not a free action. Refuse loudly
    // rather than silently granting free generations.
    throw new Error(`reserveCredits: amount must be a positive integer, got ${amount}`);
  }

  return await sql.begin(async (sql) => {
    const spent = await burnFromLots(sql, user_id, amount);
    if (!spent.ok) return { ok: false, included_remaining: 0, purchased_remaining: 0 };

    await syncBalanceCache(sql, user_id);

    await sql`
      INSERT INTO credit_transactions (user_id, credit_type, delta, reason, website_id, generation_id)
      VALUES (${user_id}, ${credit_type}, ${-amount}, ${reason}, ${website_id || null}, ${generation_id || null})
    `;

    return { ok: true, included_remaining: spent.plan_remaining, purchased_remaining: spent.purchased_remaining };
  });
};

/**
 * Compensating refund for a reservation whose paid work then failed.
 *
 * Refund policy: restore the plan (included) bucket first, capped at included_allotment, and put
 * any remainder into purchased. This mirrors the drain order and means a refund can never inflate
 * included_remaining above what the plan grants, nor silently convert plan credits into purchased
 * ones (which survive the billing cycle and would hand the user more value than they started with).
 *
 * Deliberately best-effort: it is called from a catch block, so a failure here must not mask the
 * original generation error. It logs loudly instead — the ledger row is the audit trail.
 */
export const refundCredits = async (
  user_id: number,
  credit_type: string,
  amount: number,
  reason: string,
  website_id?: number,
  generation_id?: number,
): Promise<void> => {
  if (!Number.isInteger(amount) || amount <= 0) return;

  try {
    await sql.begin(async (sql) => {
      // ── Refund into the lots it came from, NOT into a fresh one ────────────
      // A new lot would carry a new expiry date, so refunding a failed
      // generation would quietly extend the life of those credits — turning a
      // compensating action into free time. Topping the most recently drained
      // live lots back up keeps the original dates.
      //
      // Capped at `granted` by the table's CHECK, so a refund can never inflate
      // a lot beyond what it originally held.
      let outstanding = amount;
      const lots = (await sql`
        SELECT id, granted, remaining
        FROM   credit_lots
        WHERE  user_id = ${user_id} AND expires_at > NOW() AND remaining < granted
        ORDER  BY expires_at ASC, id ASC
        FOR UPDATE
      `) as unknown as Array<{ id: number; granted: number; remaining: number }>;

      for (const lot of lots) {
        if (outstanding <= 0) break;
        const room = Number(lot.granted) - Number(lot.remaining);
        const give = Math.min(room, outstanding);
        await sql`
          UPDATE credit_lots SET remaining = remaining + ${give}, updated_at = NOW()
          WHERE id = ${lot.id} AND remaining + ${give} <= granted
        `;
        outstanding -= give;
      }

      // Every live lot was already full — the credits were spent from lots that
      // have since expired, or from none at all. Issue the remainder as a plan
      // lot on the default lifetime so the user is not left short.
      if (outstanding > 0) {
        await sql`
          INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, reason)
          VALUES (${user_id}, 'plan', ${outstanding}, ${outstanding},
                  NOW() + ${`${PLAN_CREDIT_LIFETIME_MONTHS} months`}::interval,
                  ${`Refund: ${reason}`})
        `;
      }

      await syncBalanceCache(sql, user_id);

      await sql`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason, website_id, generation_id)
        VALUES (${user_id}, ${credit_type}, ${amount}, ${reason}, ${website_id || null}, ${generation_id || null})
      `;
    });
  } catch (err) {
    console.error(
      `❌ refundCredits FAILED — user ${user_id} is owed ${amount} ${credit_type} credit(s) for "${reason}". Refund manually.`,
      err,
    );
  }
};

export const createWebsite = async (user_id: number, domain: string, trial_used: boolean = false): Promise<Website> => {
  let site_code = generateSiteCode();
  
  // Ensure unique site code
  let attempts = 0;
  while (attempts < 10) {
    try {
      const result = await sql`
        INSERT INTO websites (user_id, domain, site_code, trial_used)
        VALUES (${user_id}, ${domain}, ${site_code}, ${trial_used})
        RETURNING *
      `;
      return result[0] as Website;
    } catch (error: any) {
      if (error.code === '23505') { // Unique constraint violation on site_code
        site_code = generateSiteCode();
        attempts++;
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('Failed to generate unique site code');
};


export const getUserWebsites = async (user_id: number): Promise<Website[]> => {
  const rows = await sql`
    SELECT * FROM websites 
    WHERE user_id = ${user_id} AND active = true
    ORDER BY created_at DESC
  `;
  return (rows as any[]).map(r => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    domain: String(r.domain),
    site_code: String(r.site_code),
    active: Boolean(r.active),
    created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    // `SELECT *` above returns every column, but this mapper is an explicit
    // allow-list, so a new column reaches the CMS only once it is named here.
    // Pre-migration-008 databases have no such column and yield null, which the
    // CMS reads as "never connected".
    last_connected_at: r.last_connected_at ?? null,
    // Pre-migration-014 yields null here too, which the CMS reads as "older
    // plugin build" and so declines to hold this site's silence against it.
    // That is the correct reading either way: no heartbeat has been recorded.
    heartbeat_at: r.heartbeat_at ?? null,
  })) as Website[];
};

/**
 * Record that the plugin just authenticated successfully for this website.
 *
 * Called from validateApiAccess on every authenticated plugin request, so it is
 * on the hot path for content generation. Two properties matter:
 *
 *  • THROTTLED IN SQL. The WHERE clause discards repeat writes inside a 5-minute
 *    window, so a burst of generations costs one UPDATE rather than one per
 *    request. Doing it in the statement (rather than an in-process cache) keeps
 *    it correct across multiple server instances and needs no extra SELECT.
 *
 *  • NEVER THROWS. The caller does not await this, and a status-chip timestamp
 *    is not worth failing a paid generation over. Postgres 42703
 *    (undefined_column) is expected and silent whenever migration 008 has not
 *    run yet — the same deploy-before-migrate tolerance the address endpoints
 *    use — so shipping this code ahead of the migration is safe.
 *
 *  • SUPERSEDES OTHER ACCOUNTS' ROWS FOR THE SAME DOMAIN. Only one physical
 *    WordPress install can hold live credentials for a domain at a time, but
 *    nothing about adding a website ties the domain string to a single owner
 *    (findWebsiteByDomain's own callers say so explicitly: "any number of
 *    accounts may add/link the same domain"). Without this, reconnecting a
 *    site under a different account left the OLD account's row reading
 *    Active forever — the same domain showed Active under two accounts at
 *    once. So every time this row is actually (re)stamped, any OTHER
 *    account's still-active row for the same domain is cleared in the same
 *    transaction. Exact-string domain match, `active = true` only — the same
 *    semantics findWebsiteByDomain's existing callers already rely on.
 */
export const touchWebsiteConnection = async (
  website_id: number,
  opts: { heartbeat?: boolean } = {},
): Promise<void> => {
  try {
    await sql.begin(async (sql) => {
      const stamped = (opts.heartbeat
        ? await sql`
            UPDATE websites
            SET last_connected_at = NOW(), heartbeat_at = NOW()
            WHERE id = ${website_id}
              AND (
                heartbeat_at IS NULL
                OR last_connected_at IS NULL
                OR last_connected_at < NOW() - INTERVAL '5 minutes'
              )
            RETURNING domain, user_id
          `
        : await sql`
            UPDATE websites
            SET last_connected_at = NOW()
            WHERE id = ${website_id}
              AND (last_connected_at IS NULL OR last_connected_at < NOW() - INTERVAL '5 minutes')
            RETURNING domain, user_id
          `) as unknown as { domain: string; user_id: number }[];

      // Throttled away — nothing changed, so nothing to supersede either. Same
      // cost as before this change in the common case (a site pinging inside
      // its own 5-minute window).
      const row = stamped[0];
      if (!row) return;

      // This row just went (or stayed) live, so any OTHER account's
      // still-active row for the SAME domain is now stale. Clear it rather
      // than leaving it to a heartbeat's 24h silence window (see the CMS's
      // CONNECTION_STALE_HOURS) — or forever, on a pre-heartbeat build. A
      // soft-deleted sibling is left alone: it is never shown as Active
      // anywhere, so touching it would only add risk. Clears every matching
      // sibling, not just one.
      await sql`
        UPDATE websites
        SET last_connected_at = NULL, heartbeat_at = NULL
        WHERE domain = ${row.domain}
          AND user_id != ${row.user_id}
          AND active = true
          AND (last_connected_at IS NOT NULL OR heartbeat_at IS NOT NULL)
      `;
    });
  } catch (error: any) {
    // 42703 = undefined_column: migration 008 (or 014) has not run yet.
    if (error?.code === '42703') return;
    console.warn('Failed to stamp website connection (non-fatal):', error?.message ?? error);
  }
};

/**
 * Forget that this website was ever connected.
 *
 * Called when the plugin tells us it is going away — the API Key or Site Code
 * has just been cleared on the settings page, or the plugin was deactivated.
 * That report is what makes the CMS accurate IMMEDIATELY in the case a user is
 * most likely to check: they remove their credentials and go straight to the
 * dashboard to confirm. Without it they would wait out the CMS's silence
 * window instead.
 *
 * Both columns are cleared. Leaving `heartbeat_at` set would claim the site is
 * still running a heartbeating plugin when we have just been told the opposite,
 * and would then hold that against a site that reconnects on an older build.
 *
 * Unlike touchWebsiteConnection this one is AWAITED by its caller and does not
 * swallow errors: it is the entire purpose of the request that triggers it, so
 * a failure has to be reported rather than silently dropped.
 */
export const clearWebsiteConnection = async (website_id: number): Promise<void> => {
  await sql`
    UPDATE websites
    SET last_connected_at = NULL, heartbeat_at = NULL
    WHERE id = ${website_id}
  `;
};


export const deleteWebsite = async (website_id: number): Promise<void> => {
  // Soft delete — preserves domain history so trial_used flag is never lost
  await sql`
    UPDATE websites
    SET active = false, deleted_at = NOW()
    WHERE id = ${website_id}
  `;
};

/**
 * Find ALL website rows for a domain (including soft-deleted).
 * Used by issue-connect-token to check trial history across accounts.
 */
export const findWebsiteByDomain = async (domain: string): Promise<Website[]> => {
  const rows = await sql`
    SELECT * FROM websites WHERE domain = ${domain}
    ORDER BY created_at DESC
  `;
  return rows as unknown as Website[];
};

/**
 * Find the active website row for a specific user+domain combo.
 * Returns null if no active match (could be soft-deleted or never registered).
 */
export const findWebsiteByUserAndDomain = async (user_id: number, domain: string): Promise<Website | null> => {
  const result = await sql`
    SELECT * FROM websites
    WHERE user_id = ${user_id} AND domain = ${domain} AND active = true
    LIMIT 1
  `;
  return (result[0] as Website) || null;
};

/**
 * Start the free trial for a user (idempotent — only fires if never started).
 * Every signup gets this: TRIAL_DAYS of access to the free-plan credits.
 */
export const startUserTrial = async (user_id: number): Promise<void> => {
  const started = await sql`
    UPDATE users
    SET
      trial_started_at = NOW(),
      trial_ends_at    = NOW() + (${TRIAL_DAYS} || ' days')::interval,
      updated_at       = NOW()
    WHERE id = ${user_id} AND trial_started_at IS NULL
  `;

  // Account Activity's first line. Gated on the UPDATE's row count rather than
  // written unconditionally: this function is called on every signup path and
  // is deliberately idempotent, so a second call matches no row and must not
  // announce a trial that started weeks ago.
  //
  // Failing to log must never fail a signup — the trial is already started by
  // the statement above, and a missing history row is not worth turning a
  // successful registration into an error.
  if (started.count > 0) {
    try {
      await recordTransaction(sql, {
        userId: user_id,
        type: 'plan_grant',
        description: describeTrialStarted(TRIAL_DAYS),
        amountCents: null,
        status: 'succeeded',
        providerEventId: `trial_started:${user_id}`,
      });
    } catch (err) {
      console.warn('Could not record the trial-started activity row (non-fatal):', err);
    }
  }
};

/**
 * Make sure Account Activity has its "Free trial started" line.
 *
 * startUserTrial() writes it only when IT starts the trial. A CMS signup never
 * gets that far: supabase.auth.signUp() creates the users row through the
 * handle_new_user trigger (migration 016), which sets trial_started_at itself,
 * so startUserTrial's UPDATE matches nothing and no row was ever written —
 * reported as "Free trial started does not show, as of October 15".
 *
 * Called on every CMS session (POST /users/by-email). It is one indexed
 * existence check when the row is already there, and it heals accounts created
 * before this fix on their next visit. Dated to the real trial start, not to
 * today, so it sorts where it belongs. Same event id as startUserTrial's row,
 * so the two can never both appear.
 */
export const ensureTrialStartedActivity = async (
  user: { id: number; trial_started_at?: Date | string | null },
): Promise<void> => {
  if (!user.trial_started_at) return;
  try {
    const providerEventId = `trial_started:${user.id}`;
    const existing = await sql`
      SELECT 1 FROM billing_transactions
      WHERE provider = 'stripe' AND provider_event_id = ${providerEventId}
      LIMIT 1
    `;
    if (existing.length > 0) return;

    await recordTransaction(sql, {
      userId: user.id,
      type: 'plan_grant',
      description: describeTrialStarted(TRIAL_DAYS),
      amountCents: null,
      status: 'succeeded',
      providerEventId,
      occurredAt: user.trial_started_at,
    });
  } catch (err) {
    console.warn(`Could not ensure the trial-started activity row for user ${user.id} (non-fatal):`, err);
  }
};
export const findUserByAuthId = async (auth_user_id: string): Promise<User | null> => {
  const result = await sql`
    SELECT * FROM users WHERE auth_user_id = ${auth_user_id} LIMIT 1
  `;
  return (result[0] as User) || null;
};

// OAuth user functions
export const findUserByOAuth = async (provider: string, oauth_id: string): Promise<User | null> => {
  const result = await sql`
    SELECT * FROM users WHERE oauth_provider = ${provider} AND oauth_id = ${oauth_id} LIMIT 1
  `;
  return (result[0] as User) || null;
};

export const getFreePlanId = async (): Promise<number> => {
  const result = await sql`
    SELECT id FROM subscription_plans WHERE slug = 'free' LIMIT 1
  `;
  if (!result[0]) throw new Error('FREE plan not configured in database');
  return result[0].id as number;
};

export const createOAuthUser = async (userData: {
  email: string;
  name: string;
  oauth_provider: string;
  oauth_id: string;
  avatar_url?: string;
  plan_id?: number;
}): Promise<User> => {
  const api_key = generateApiKey();
  const plan_id = userData.plan_id || await getFreePlanId();
  
  const result = await sql`
    INSERT INTO users (email, name, api_key, plan_id, oauth_provider, oauth_id, avatar_url)
    VALUES (${userData.email}, ${userData.name}, ${api_key}, ${plan_id}, ${userData.oauth_provider}, ${userData.oauth_id}, ${userData.avatar_url || null})
    RETURNING id, email, name, api_key, plan_id, oauth_provider, oauth_id, avatar_url, created_at, updated_at
  `;
  
  return result[0] as User;
};

export const updateUserOAuthData = async (user_id: number, data: {
  avatar_url?: string;
  name?: string;
  oauth_provider?: string;
  oauth_id?: string;
}): Promise<User | null> => {
  const result = await sql`
    UPDATE users
    SET
      avatar_url = COALESCE(${data.avatar_url || null}, avatar_url),
      name = COALESCE(${data.name || null}, name),
      -- Backfill provider identity only when not already set (reversed COALESCE):
      -- users created by the DB signup trigger have these NULL even for OAuth
      -- signups, which broke the "this account uses Google sign-in" detection.
      oauth_provider = COALESCE(oauth_provider, ${data.oauth_provider || null}),
      oauth_id = COALESCE(oauth_id, ${data.oauth_id || null}),
      updated_at = NOW()
    WHERE id = ${user_id}
    RETURNING id, email, name, api_key, plan_id, oauth_provider, oauth_id, avatar_url, created_at, updated_at
  `;
  return (result[0] as User) || null;
};

export const updateUserByAuthId = async (auth_user_id: string, updates: Partial<User>) => {
  const setClause = Object.keys(updates)
    .map(key => `${key} = $${key}`)
    .join(', ');
    
  const result = await sql`
    UPDATE users 
    SET ${sql(updates)}, updated_at = NOW()
    WHERE auth_user_id = ${auth_user_id}
    RETURNING *
  `;
  
  return result[0] as User;
};

// Additional functions for the API routes
export const addUserWebsite = async (user_id: number, url: string, name: string) => {
  // Extract domain from URL
  const domain = new URL(url).hostname;
  
  // Check user's website limit.
  //
  // NULL means UNLIMITED — that is how the top tier is stored. This used to
  // read `userPlan?.website_limit || 1`, which collapsed both null (unlimited)
  // and a missing plan down to 1: a Scale customer was capped at a single
  // website, while an unreadable account with no sites sailed past the gate
  // entirely. The live path in websites.routes.ts has always tested against
  // null explicitly; this now matches it, and the message matches too so the
  // CMS recognises the refusal either way.
  const userPlan = await getUserWithPlan(user_id);
  if (!userPlan) {
    // Fail closed: no plan read means no allowance to check against.
    throw new Error('User not found');
  }

  if (userPlan.website_limit !== null && userPlan.website_limit !== undefined) {
    const currentWebsites = await getUserWebsites(user_id);
    if (currentWebsites.length >= userPlan.website_limit) {
      throw new Error(`Website limit reached. Your plan allows ${userPlan.website_limit} websites.`);
    }
  }

  const result = await sql`
    INSERT INTO websites (user_id, domain, site_code, active)
    VALUES (${user_id}, ${domain}, ${generateSiteCode()}, true)
    RETURNING *
  `;
  
  return result[0];
};

export const deleteUserWebsite = async (website_id: number) => {
  await sql`
    UPDATE websites 
    SET active = false, updated_at = NOW()
    WHERE id = ${website_id}
  `;
};