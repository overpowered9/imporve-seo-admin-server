import sql from '../data/db.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
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
}

export interface CreditBalance {
  id: number;
  user_id: number;
  credit_type: 'images' | 'content' | 'keywords';
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

type CreditType = 'images' | 'content' | 'keywords';
const CREDIT_TYPES: CreditType[] = ['images', 'content', 'keywords'];

/** Length of the free trial started at signup. */
export const TRIAL_DAYS = 7;

const planAllotment = (plan: any, creditType: CreditType): number => {
  if (creditType === 'images') return plan.image_credits;
  if (creditType === 'content') return plan.content_credits;
  return plan.keyword_credits;
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

  // Initialize credit balances with the plan's full allotment (free plan = the
  // trial credits, currently 10 of each type; paid plans = their allotment).
  await sql`
    INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
    VALUES
      (${user_id}, 'images', ${planData.image_credits}, ${planData.image_credits}, 0, NOW()),
      (${user_id}, 'content', ${planData.content_credits}, ${planData.content_credits}, 0, NOW()),
      (${user_id}, 'keywords', ${planData.keyword_credits}, ${planData.keyword_credits}, 0, NOW())
    ON CONFLICT (user_id, credit_type) DO NOTHING
  `;
  
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

export const getUserCreditBalance = async (user_id: number, credit_type: string): Promise<number> => {
  const result = await sql`
    SELECT amount FROM credit_balances 
    WHERE user_id = ${user_id} AND credit_type = ${credit_type}
    LIMIT 1
  `;
  return result[0]?.amount || 0;
};

export const getUserCreditBalances = async (user_id: number): Promise<CreditBalance[]> => {
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
 */
export const refillPlanCredits = async (user_id: number, plan: any, reason = 'Plan credits refill'): Promise<void> => {
  await sql.begin(async sql => {
    for (const creditType of CREDIT_TYPES) {
      const allotment = planAllotment(plan, creditType);
      await sql`
        INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
        VALUES (${user_id}, ${creditType}, ${allotment}, ${allotment}, 0, NOW())
        ON CONFLICT (user_id, credit_type)
        DO UPDATE SET
          included_remaining = ${allotment},
          included_allotment = ${allotment},
          cycle_started_at   = NOW(),
          updated_at         = NOW()
      `;
      await sql`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${user_id}, ${creditType}, ${allotment}, ${reason})
      `;
    }
  });
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
    await sql`
      INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
      VALUES (${user_id}, ${credit_type}, 0, 0, ${quantity}, NOW())
      ON CONFLICT (user_id, credit_type)
      DO UPDATE SET
        purchased_remaining = credit_balances.purchased_remaining + ${quantity},
        updated_at = NOW()
    `;
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
export const upgradeIncludedCredits = async (
  user_id: number,
  newPlan: any,
  reason = 'Plan upgrade',
  prorationFactor: number = 1
): Promise<void> => {
  // Guard the factor — a bad cycle date must never invert or inflate a grant.
  const factor = Number.isFinite(prorationFactor)
    ? Math.min(1, Math.max(0, prorationFactor))
    : 1;

  await sql.begin(async sql => {
    for (const creditType of CREDIT_TYPES) {
      const newAllotment = planAllotment(newPlan, creditType);
      const rows = await sql`
        SELECT included_allotment FROM credit_balances
        WHERE user_id = ${user_id} AND credit_type = ${creditType}
        LIMIT 1
      `;
      const oldAllotment = rows.length > 0 ? Number(rows[0].included_allotment) : 0;
      const fullDifference = Math.max(0, newAllotment - oldAllotment);

      // OLD (always the full difference, regardless of when in the cycle):
      // const bump = Math.max(0, newAllotment - oldAllotment);
      //
      // Round rather than floor so a genuine upgrade never grants 0 credits
      // near the end of a cycle; a paid upgrade should always give something.
      const bump = fullDifference > 0
        ? Math.max(1, Math.round(fullDifference * factor))
        : 0;

      await sql`
        INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
        VALUES (${user_id}, ${creditType}, ${bump}, ${newAllotment}, 0, NOW())
        ON CONFLICT (user_id, credit_type)
        DO UPDATE SET
          included_allotment = ${newAllotment},
          included_remaining = credit_balances.included_remaining + ${bump},
          updated_at = NOW()
      `;
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
 * Suspend access by zeroing the PLAN (included) credits only — e.g. on a failed renewal
 * or a bad subscription status. Purchased credits are preserved (the user paid for them).
 */
export const suspendPlanCredits = async (user_id: number, reason = 'Subscription suspended'): Promise<void> => {
  await sql.begin(async sql => {
    const rows = await sql`
      SELECT credit_type, included_remaining FROM credit_balances
      WHERE user_id = ${user_id} AND included_remaining > 0
    `;
    await sql`
      UPDATE credit_balances
      SET included_remaining = 0, updated_at = NOW()
      WHERE user_id = ${user_id}
    `;
    for (const row of rows) {
      await sql`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${user_id}, ${row.credit_type}, ${-Number(row.included_remaining)}, ${reason})
      `;
    }
  });
};

/**
 * Effective trial end for a user: the explicit `trial_ends_at`, or — when that was never
 * set — `created_at + TRIAL_DAYS` as a fallback. Returns null only when neither is known.
 * The fallback closes the hole where a NULL `trial_ends_at` would otherwise bypass every
 * trial check (a null timestamp is not "no trial", it's a trial whose end we must infer).
 */
export const effectiveTrialEnd = (
  user: { trial_ends_at?: Date | null; created_at?: Date | null }
): Date | null => {
  if (user.trial_ends_at) return new Date(user.trial_ends_at);
  if (user.created_at) {
    const d = new Date(user.created_at);
    d.setDate(d.getDate() + TRIAL_DAYS);
    return d;
  }
  return null;
};

/** True when the user's free-trial window has elapsed (uses effectiveTrialEnd). */
export const isTrialExpired = (
  user: { trial_ends_at?: Date | null; created_at?: Date | null }
): boolean => {
  const end = effectiveTrialEnd(user);
  return !!end && end.getTime() < Date.now();
};

/** Is this a free ($0) plan? A missing/unknown plan is treated as free (fail-safe). */
export const isFreePlanId = async (plan_id?: number | null): Promise<boolean> => {
  if (!plan_id) return true;
  const rows = await sql`SELECT price_cents FROM subscription_plans WHERE id = ${plan_id} LIMIT 1`;
  return !rows[0] || Number(rows[0].price_cents) === 0;
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
    await suspendPlanCredits(user.id, 'Trial expired');
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
export const changePlan = async (
  user_id: number, 
  new_plan_id: number, 
  immediate: boolean = true
) => {
  const currentSub = await getUserSubscription(user_id);
  
  if (!currentSub) {
    throw new Error('No active subscription found');
  }

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
      // ── FLAG: BILLING_PRORATED_CREDITS_ENABLED ───────────────────────────
      // Prorating the grant changes how many credits a paying customer
      // receives, so it stays OFF until it has been verified against a real
      // billing cycle. Off = the previous behaviour exactly: the full plan
      // difference, granted regardless of cycle position.
      //
      // Turn it on only after confirming, on a test account mid-cycle, that
      // the credits granted line up with the prorated amount charged.
      const prorateCredits = String(process.env.BILLING_PRORATED_CREDITS_ENABLED || '').toLowerCase() === 'true';
      const factor = prorateCredits
        ? remainingCycleFraction(cycleRows[0]?.cycle_started_at, currentSub.next_billing_date)
        : 1;
      await upgradeIncludedCredits(user_id, newPlan[0], 'Plan upgrade credit bonus', factor);
    }
  } else {
    // DOWNGRADE: Schedule for next billing date
    await sql`
      UPDATE subscriptions
      SET
        pending_plan_id = ${new_plan_id},
        pending_plan_effective_date = next_billing_date,
        status = 'pending_downgrade'
      WHERE user_id = ${user_id}
    `;
  }
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
    // Drain PLAN (included) credits first so the expiring allotment is used before the
    // purchased credits the user paid extra for. Any remainder comes out of purchased.
    const rows = await sql`
      SELECT included_remaining, purchased_remaining FROM credit_balances
      WHERE user_id = ${user_id} AND credit_type = ${credit_type}
      LIMIT 1
    `;
    const included = rows.length > 0 ? Number(rows[0].included_remaining) : 0;
    const fromIncluded = Math.min(included, amount);
    const fromPurchased = amount - fromIncluded;

    await sql`
      UPDATE credit_balances
      SET
        included_remaining  = included_remaining - ${fromIncluded},
        purchased_remaining = purchased_remaining - ${fromPurchased},
        updated_at = NOW()
      WHERE user_id = ${user_id} AND credit_type = ${credit_type}
    `;

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
    // CMS reads as "never connected" and falls back to its generations signal.
    last_connected_at: r.last_connected_at ?? null,
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
 */
export const touchWebsiteConnection = async (website_id: number): Promise<void> => {
  try {
    await sql`
      UPDATE websites
      SET last_connected_at = NOW()
      WHERE id = ${website_id}
        AND (last_connected_at IS NULL OR last_connected_at < NOW() - INTERVAL '5 minutes')
    `;
  } catch (error: any) {
    if (error?.code === '42703') return; // migration 008 has not run yet
    console.warn('Failed to stamp website connection (non-fatal):', error?.message ?? error);
  }
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
  await sql`
    UPDATE users
    SET
      trial_started_at = NOW(),
      trial_ends_at    = NOW() + (${TRIAL_DAYS} || ' days')::interval,
      updated_at       = NOW()
    WHERE id = ${user_id} AND trial_started_at IS NULL
  `;
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
  
  // Check user's website limit
  const userPlan = await getUserWithPlan(user_id);
  const currentWebsites = await getUserWebsites(user_id);
  
  if (currentWebsites.length >= (userPlan?.website_limit || 1)) {
    throw new Error('Website limit reached for your plan');
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