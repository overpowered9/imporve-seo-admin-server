import express from 'express';
import { z } from 'zod';
import sql from '../data/db.js';
// Credits live in credit_lots; credit_balances is a derived cache with exactly
// one writer. Both imports exist so this route cannot reinvent either.
import { syncBalanceCache } from '../models/user.models.js';
import { PURCHASED_CREDIT_LIFETIME_MONTHS } from '../config/credits.config.js';
import { describeUserPlan, type UserPlanRow } from '../models/user-plan.js';
import { recordTransaction } from '../services/billing/transactions.js';
import { describeCreditAdjustment } from '../services/billing/descriptions.js';

const router = express.Router();

/**
 * Add the plan an admin should actually READ to a user row.
 *
 * These queries return `sp.name` — the raw column, which still holds the
 * ORIGINAL names ("Starter Plan", "Pro Plan") while the product, the billing
 * ledger and the customer call those Optimize and Scale, and the 950-cent plan
 * whose slug is 'basic' is called Grow. A panel printing the column names a plan
 * that no longer exists by that name.
 *
 * It also could not tell a free trial from a lapsed free account: both sit on
 * the $0 plan and only the trial end separates them.
 *
 * Same derivation the support queue uses, so one account reads the same however
 * an agent reached it. Additive — `plan_name` is still the raw column, and
 * nothing that already worked changes shape.
 */
const withPlan = <T extends Record<string, unknown>>(row: T) => {
  const { plan_price_cents, user_created_at, ...rest } = row;
  return { ...rest, ...describeUserPlan(row as UserPlanRow) };
};

// GET /admin/users - List all users with pagination, search, filter, sort
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string) || '';
    const planFilter = (req.query.plan as string) || '';
    const sortBy = (req.query.sortBy as string) || 'created_at';
    const sortOrder = (req.query.sortOrder as string) || 'desc';

    // Validate sort column to prevent injection
    const allowedSorts = ['created_at', 'email', 'name', 'plan_id', 'id'];
    const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'created_at';
    const safeOrder = sortOrder === 'asc' ? 'asc' : 'desc';

    // Build query with conditions
    let users;
    let countResult;

    if (search && planFilter) {
      const searchPattern = `%${search}%`;
      const planId = parseInt(planFilter);
      
      if (safeSort === 'created_at' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
            AND u.plan_id = ${planId}
          ORDER BY u.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      countResult = await sql`
        SELECT COUNT(*) as total FROM users u
        WHERE (u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search})
          AND u.plan_id = ${planId}
      `;
    } else if (search) {
      const searchPattern = `%${search}%`;

      if (safeSort === 'created_at' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      countResult = await sql`
        SELECT COUNT(*) as total FROM users u
        WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
      `;
    } else if (planFilter) {
      const planId = parseInt(planFilter);

      if (safeSort === 'created_at' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      countResult = await sql`
        SELECT COUNT(*) as total FROM users u WHERE u.plan_id = ${planId}
      `;
    } else {
      // No filters
      if (safeSort === 'created_at' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      countResult = await sql`SELECT COUNT(*) as total FROM users`;
    }

    const total = parseInt(countResult[0]?.total || '0');

    res.json({
      success: true,
      data: {
        users: (users as unknown as Record<string, unknown>[]).map(withPlan),
        total,
        pagination: { limit, offset, total }
      }
    });
  } catch (error) {
    console.error('Admin list users error:', error);
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

// GET /admin/users/stats - Summary stats 
router.get('/stats', async (_req, res) => {
  try {
    const stats = await sql`
      SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN u.created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as new_last_30d,
        COUNT(CASE WHEN sp.slug = 'free' OR u.plan_id IS NULL THEN 1 END) as free_users,
        COUNT(CASE WHEN sp.slug != 'free' AND sp.slug IS NOT NULL THEN 1 END) as paid_users
      FROM users u
      LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
    `;

    const plans = await sql`
      SELECT sp.id, sp.name, sp.slug, COUNT(u.id) as user_count
      FROM subscription_plans sp
      LEFT JOIN users u ON u.plan_id = sp.id
      GROUP BY sp.id, sp.name, sp.slug
      ORDER BY sp.price_cents ASC
    `;

    res.json({
      success: true,
      data: {
        ...stats[0],
        plans
      }
    });
  } catch (error) {
    console.error('Admin user stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user stats' });
  }
});

// GET /admin/users/:userId - Get user detail with credits, websites, subscription
router.get('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    const userResult = await sql`
      SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
             sp.name as plan_name, sp.slug as plan_slug,
                 sp.price_cents as plan_price_cents, u.trial_ends_at, u.created_at as user_created_at
      FROM users u
      LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
      WHERE u.id = ${userId}
      LIMIT 1
    `;

    if (userResult.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const credits = await sql`
      SELECT credit_type, amount, updated_at FROM credit_balances WHERE user_id = ${userId}
    `;

    const websites = await sql`
      SELECT id, domain, site_code, active, created_at FROM websites WHERE user_id = ${userId}
    `;

    const subscription = await sql`
      SELECT s.*, sp.name as plan_name, sp.slug as plan_slug, sp.price_cents
      FROM subscriptions s
      LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
      WHERE s.user_id = ${userId}
      ORDER BY s.created_at DESC LIMIT 1
    `;

    const recentTransactions = await sql`
      SELECT * FROM credit_transactions
      WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 20
    `;

    res.json({
      success: true,
      data: {
        user: withPlan(userResult[0] as unknown as Record<string, unknown>),
        credits,
        websites,
        subscription: subscription[0] || null,
        recentTransactions
      }
    });
  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user details' });
  }
});

// POST /admin/users/:userId/gift-credits - Manage credits for a user (add, remove, set)
const giftCreditsSchema = z.object({
  operation: z.enum(['add', 'remove', 'set']),
  // One pool now. Legacy labels stay accepted so an un-updated admin panel keeps working; they
  // are normalised to 'iseo' at the call site below.
  credit_type: z.enum(['iseo', 'images', 'content', 'keywords']).default('iseo'),
  amount: z.number().int().min(0).max(10000),
  reason: z.string().min(1).max(500)
}).refine(data => data.operation === 'set' || data.amount >= 1, {
  message: 'Amount must be at least 1 for add/remove operations',
  path: ['amount']
});

router.post('/:userId/gift-credits', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    const { operation, credit_type, amount, reason } = giftCreditsSchema.parse(req.body);

    // Verify user exists
    const user = await sql`SELECT id, email, name FROM users WHERE id = ${userId} LIMIT 1`;
    if (user.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // ── Adjustments operate on LOTS, which is where the balance now lives ──
    //
    // This edited credit_balances directly. That table became a derived cache
    // when credits gained expiry dates, so an admin grant produced a number the
    // customer could see and could not spend — and a removal removed nothing,
    // because the next read recomputed the cache from the untouched lots.
    //
    // Admin grants go to the PURCHASED bucket on a full lifetime: they are a
    // goodwill gesture or a correction, and expiring them with the current plan
    // cycle would quietly take them back.
    const appliedDelta = await sql.begin(async (tx) => {
      const live = (await tx`
        SELECT id, source, remaining FROM credit_lots
        WHERE user_id = ${userId} AND remaining > 0 AND expires_at > NOW()
        ORDER BY expires_at ASC, id ASC
        FOR UPDATE
      `) as unknown as Array<{ id: number; source: string; remaining: number }>;

      const held = live.reduce((n, l) => n + Number(l.remaining), 0);

      // "set" is expressed as the delta needed to reach the target, so all three
      // operations share one code path and one set of edge cases.
      const delta = operation === 'add' ? amount
        : operation === 'remove' ? -Math.min(amount, held)
          : amount - held;

      if (delta > 0) {
        await tx`
          INSERT INTO credit_lots (user_id, source, granted, remaining, expires_at, reason)
          VALUES (${userId}, 'purchased', ${delta}, ${delta},
                  NOW() + ${`${PURCHASED_CREDIT_LIFETIME_MONTHS} months`}::interval,
                  ${`Admin adjustment: ${reason}`})
        `;
      } else if (delta < 0) {
        // Drain earliest-expiring first, the same order a generation would —
        // taking credits back should not leave a customer holding only the
        // stock that is about to lapse.
        let outstanding = -delta;
        for (const lot of live) {
          if (outstanding <= 0) break;
          const take = Math.min(Number(lot.remaining), outstanding);
          await tx`
            UPDATE credit_lots SET remaining = remaining - ${take}, updated_at = NOW()
            WHERE id = ${lot.id} AND remaining >= ${take}
          `;
          outstanding -= take;
        }
      }

      await syncBalanceCache(tx, userId);

      // Reuses the delta computed above rather than recomputing it. The old
      // line here was `operation === 'remove' ? -amount : amount`, which logged
      // a "set" as a positive grant of the target value even when the target
      // was LOWER than the balance — a reduction recorded in the ledger as an
      // increase. The delta above is the real movement in all three cases.
      const logReason = operation === 'add' ? `Admin add: ${reason}` :
                        operation === 'remove' ? `Admin remove: ${reason}` :
                        `Admin correction: ${reason}`;
      await tx`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${userId}, ${credit_type}, ${delta}, ${logReason})
      `;
      return delta;
    });

    // ── Account Activity: "Credit adjustment — N credits added/removed by support"
    // credit_transactions above is the internal audit log; the customer reads
    // billing_transactions. Written AFTER the transaction commits rather than
    // inside it: a failed ledger insert inside would abort the adjustment
    // itself, and the credits must move whether or not the line is written.
    // A "set" that changed nothing is not an adjustment, so no row.
    if (appliedDelta !== 0) {
      await recordTransaction(sql, {
        userId,
        type: 'plan_grant',
        description: describeCreditAdjustment(appliedDelta),
        amountCents: null,
        status: 'succeeded',
        providerEventId: `admin_adjustment:${userId}:${Date.now()}`,
        creditType: 'iseo',
        creditDelta: appliedDelta,
        metadata: { operation, reason },
      });
    }

    // Get updated balances
    const updatedCredits = await sql`
      SELECT credit_type, amount FROM credit_balances WHERE user_id = ${userId}
    `;

    const opLabel = operation === 'add' ? `Added ${amount}` : operation === 'remove' ? `Removed ${amount}` : `Set to ${amount}`;
    res.json({
      success: true,
      message: `${opLabel} ${credit_type} credits for ${user[0].email}`,
      data: { credits: updatedCredits }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: error.errors[0].message });
    }
    console.error('Admin gift credits error:', error);
    res.status(500).json({ success: false, error: 'Failed to gift credits' });
  }
});

// GET /admin/users/plans/all - Get all subscription plans
router.get('/plans/all', async (_req, res) => {
  try {
    const plans = await sql`
      SELECT * FROM subscription_plans ORDER BY price_cents ASC
    `;
    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('Admin get plans error:', error);
    res.status(500).json({ success: false, error: 'Failed to get plans' });
  }
});

export default router;
