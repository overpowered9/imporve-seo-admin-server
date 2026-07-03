import sql from '../data/db.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
export interface User {
  id: number;
  email: string;
  name?: string;
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

/**
 * One-time free credits granted when an ELIGIBLE account first attaches a site that
 * has never been granted before. "Just enough to test." There is NO time limit — once
 * these run out the user must buy credits or subscribe. Single source of truth: tune here.
 */
export const FREE_TEST_CREDITS: Record<CreditType, number> = {
  images: 3,
  content: 3,
  keywords: 5,
};

export type TrialGrantResult =
  | 'granted'       // free credits awarded just now
  | 'account_used'  // this account already received its one-time free credits
  | 'domain_used'   // this domain already received free credits (on any account)
  | 'email_used';   // this verified company email was already used for a grant

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

  // Initialize credit balances. FREE accounts start at ZERO usable credits — the
  // one-time free test credits are granted later, only when an eligible account
  // first attaches a never-granted site (see grantFreeCreditsWithEmail). Paid plans
  // still receive their full allotment up front.
  const isFree = planData.price_cents === 0;
  const img = isFree ? 0 : planData.image_credits;
  const con = isFree ? 0 : planData.content_credits;
  const key = isFree ? 0 : planData.keyword_credits;
  await sql`
    INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
    VALUES
      (${user_id}, 'images', ${img}, ${img}, 0, NOW()),
      (${user_id}, 'content', ${con}, ${con}, 0, NOW()),
      (${user_id}, 'keywords', ${key}, ${key}, 0, NOW())
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
export const upgradeIncludedCredits = async (user_id: number, newPlan: any, reason = 'Plan upgrade'): Promise<void> => {
  await sql.begin(async sql => {
    for (const creditType of CREDIT_TYPES) {
      const newAllotment = planAllotment(newPlan, creditType);
      const rows = await sql`
        SELECT included_allotment FROM credit_balances
        WHERE user_id = ${user_id} AND credit_type = ${creditType}
        LIMIT 1
      `;
      const oldAllotment = rows.length > 0 ? Number(rows[0].included_allotment) : 0;
      const bump = Math.max(0, newAllotment - oldAllotment);

      await sql`
        INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
        VALUES (${user_id}, ${creditType}, ${newAllotment}, ${newAllotment}, 0, NOW())
        ON CONFLICT (user_id, credit_type)
        DO UPDATE SET
          included_allotment = ${newAllotment},
          included_remaining = credit_balances.included_remaining + ${bump},
          updated_at = NOW()
      `;
      if (bump > 0) {
        await sql`
          INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
          VALUES (${user_id}, ${creditType}, ${bump}, ${reason})
        `;
      }
    }
  });
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
      // Update subscription
      await sql`
        UPDATE subscriptions
        SET
          previous_plan_id = plan_id,
          plan_id = ${new_plan_id}
        WHERE user_id = ${user_id}
      `;

      // Also update user's plan_id for consistency
      await sql`
        UPDATE users
        SET plan_id = ${new_plan_id}
        WHERE id = ${user_id}
      `;
    });

    // Raise the included allotment to the new plan and grant the upgrade difference.
    // Purchased (top-up) credits are preserved. Runs in its own transaction.
    const newPlan = await sql`SELECT * FROM subscription_plans WHERE id = ${new_plan_id}`;
    if (newPlan.length > 0) {
      await upgradeIncludedCredits(user_id, newPlan[0], 'Plan upgrade credit bonus');
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
  })) as Website[];
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
 * Award the one-time free test credits IFF BOTH are true:
 *   - this account has never been granted before  (users.trial_started_at IS NULL), AND
 *   - this domain has never been granted on ANY account (no websites row with trial_used)
 *
 * On grant (atomically): stamp the account, mark this domain's website row trial_used,
 * and deposit FREE_TEST_CREDITS. There is no expiry — trial_started_at is just the
 * "already granted" marker. Race-safe: the user row is locked FOR UPDATE so two
 * concurrent attaches can't both grant.
 *
 * @param websiteId the active website row for this user+domain to mark as granted
 */
export const grantFreeCreditsWithEmail = async (
  user_id: number,
  websiteId: number,
  domain: string,
  email: string,
): Promise<TrialGrantResult> => {
  const normEmail = email.trim().toLowerCase();
  try {
    await sql.begin(async (sql) => {
      // The credit_grants ledger is the authoritative, race-proof gate: unique
      // indexes on user_id, domain and lower(email) mean the INSERT itself enforces
      // all three one-time caps. A 23505 tells us exactly which dimension collided.
      await sql`
        INSERT INTO credit_grants (user_id, website_id, domain, email, credits)
        VALUES (${user_id}, ${websiteId}, ${domain}, ${normEmail}, ${sql.json(FREE_TEST_CREDITS)})
      `;

      // Eligible — deposit credits and update the legacy markers used elsewhere.
      for (const creditType of CREDIT_TYPES) {
        const amount = FREE_TEST_CREDITS[creditType];
        await sql`
          INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
          VALUES (${user_id}, ${creditType}, ${amount}, ${amount}, 0, NOW())
          ON CONFLICT (user_id, credit_type)
          DO UPDATE SET
            included_remaining = credit_balances.included_remaining + ${amount},
            included_allotment = GREATEST(credit_balances.included_allotment, ${amount}),
            updated_at = NOW()
        `;
        await sql`
          INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
          VALUES (${user_id}, ${creditType}, ${amount}, 'Free test credits')
        `;
      }
      await sql`UPDATE users SET trial_started_at = COALESCE(trial_started_at, NOW()), updated_at = NOW() WHERE id = ${user_id}`;
      await sql`UPDATE websites SET trial_used = true WHERE id = ${websiteId}`;
    });
    return 'granted';
  } catch (e: any) {
    if (e && e.code === '23505') {
      const c = String(e.constraint_name || '');
      if (c.includes('user'))   return 'account_used';
      if (c.includes('domain')) return 'domain_used';
      if (c.includes('email'))  return 'email_used';
    }
    throw e;
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
}): Promise<User | null> => {
  const result = await sql`
    UPDATE users 
    SET 
      avatar_url = COALESCE(${data.avatar_url || null}, avatar_url),
      name = COALESCE(${data.name || null}, name),
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