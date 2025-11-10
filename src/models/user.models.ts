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
  password_hash:string;
}

export interface Website {
  id: number;
  user_id: number;
  domain: string;
  site_code: string;
  active: boolean;
  created_at: Date;
}

export interface CreditBalance {
  id: number;
  user_id: number;
  credit_type: 'images' | 'content' | 'keywords';
  amount: number;
  updated_at: Date;
}

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
  
  // Initialize credit balances (one-time for free tier, monthly for paid)
  await sql`
    INSERT INTO credit_balances (user_id, credit_type, amount)
    VALUES 
      (${user_id}, 'images', ${planData.image_credits}),
      (${user_id}, 'content', ${planData.content_credits}),
      (${user_id}, 'keywords', ${planData.keyword_credits})
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
    // UPGRADE: Immediate effect + add credits
    await sql.begin(async sql => {
      // Update subscription
      await sql`
        UPDATE subscriptions
        SET 
          previous_plan_id = plan_id,
          plan_id = ${new_plan_id}
        WHERE user_id = ${user_id}
      `;

      // ADD credits (not replace)
      const newPlan = await sql`SELECT * FROM subscription_plans WHERE id = ${new_plan_id}`;
      if (newPlan.length > 0) {
        const plan = newPlan[0];
        
        // Add credits to existing balance
        await sql`
          UPDATE credit_balances
          SET amount = amount + ${plan.image_credits}, updated_at = NOW()
          WHERE user_id = ${user_id} AND credit_type = 'images'
        `;
        
        await sql`
          UPDATE credit_balances
          SET amount = amount + ${plan.content_credits}, updated_at = NOW()
          WHERE user_id = ${user_id} AND credit_type = 'content'
        `;
        
        await sql`
          UPDATE credit_balances
          SET amount = amount + ${plan.keyword_credits}, updated_at = NOW()
          WHERE user_id = ${user_id} AND credit_type = 'keywords'
        `;

        // Log credit additions
        await sql`
          INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
          VALUES 
            (${user_id}, 'images', ${plan.image_credits}, 'Plan upgrade credit bonus'),
            (${user_id}, 'content', ${plan.content_credits}, 'Plan upgrade credit bonus'),
            (${user_id}, 'keywords', ${plan.keyword_credits}, 'Plan upgrade credit bonus')
        `;
      }
    });
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
    // Deduct credits
    await sql`
      UPDATE credit_balances 
      SET amount = amount - ${amount}, updated_at = NOW()
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
export const createWebsite = async (user_id: number, domain: string): Promise<Website> => {
  let site_code = generateSiteCode();
  
  // Ensure unique site code
  let attempts = 0;
  while (attempts < 10) {
    try {
      const result = await sql`
        INSERT INTO websites (user_id, domain, site_code)
        VALUES (${user_id}, ${domain}, ${site_code})
        RETURNING *
      `;
      return result[0] as Website;
    } catch (error: any) {
      if (error.code === '23505') { // Unique constraint violation
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
  await sql`
    UPDATE websites 
    SET active = false, updated_at = NOW()
    WHERE id = ${website_id}
  `;
};
export const findUserByAuthId = async (auth_user_id: string): Promise<User | null> => {
  const result = await sql`
    SELECT * FROM users WHERE auth_user_id = ${auth_user_id} LIMIT 1
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