import express from 'express';
import { z } from 'zod';
import sql from '../data/db.js';

const router = express.Router();

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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.email ILIKE ${searchPattern} OR u.name ILIKE ${searchPattern} OR CAST(u.id AS TEXT) = ${search}
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          WHERE u.plan_id = ${planId}
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
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
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'created_at' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.email ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'email' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.email DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'asc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.name ASC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (safeSort === 'name' && safeOrder === 'desc') {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
          FROM users u
          LEFT JOIN subscription_plans sp ON u.plan_id = sp.id
          ORDER BY u.name DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT u.id, u.email, u.name, u.api_key, u.plan_id, u.created_at, u.updated_at,
                 sp.name as plan_name, sp.slug as plan_slug
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
        users,
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
             sp.name as plan_name, sp.slug as plan_slug
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
        user: userResult[0],
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
  credit_type: z.enum(['images', 'content', 'keywords']),
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

    // Update/create credits in a transaction
    await sql.begin(async (tx) => {
      // Check if credit balance row exists
      const existing = await tx`
        SELECT id FROM credit_balances WHERE user_id = ${userId} AND credit_type = ${credit_type} LIMIT 1
      `;

      // Admin adjustments operate on the PURCHASED bucket so manual grants persist across
      // billing cycles (a monthly refill only resets the plan/included bucket). `amount`
      // is a generated column (included + purchased) and cannot be written directly.
      if (existing.length > 0) {
        if (operation === 'add') {
          await tx`
            UPDATE credit_balances
            SET purchased_remaining = purchased_remaining + ${amount}, updated_at = NOW()
            WHERE user_id = ${userId} AND credit_type = ${credit_type}
          `;
        } else if (operation === 'remove') {
          // Remove from the total balance, draining purchased first then included.
          await tx`
            UPDATE credit_balances
            SET
              purchased_remaining = GREATEST(0, purchased_remaining - ${amount}),
              included_remaining  = GREATEST(0, included_remaining - GREATEST(0, ${amount} - purchased_remaining)),
              updated_at = NOW()
            WHERE user_id = ${userId} AND credit_type = ${credit_type}
          `;
        } else {
          // "Set to X" targets the purchased bucket and clears the included bucket so the
          // visible total equals exactly X.
          await tx`
            UPDATE credit_balances
            SET purchased_remaining = ${amount}, included_remaining = 0, updated_at = NOW()
            WHERE user_id = ${userId} AND credit_type = ${credit_type}
          `;
        }
      } else {
        const insertAmount = operation === 'remove' ? 0 : amount;
        await tx`
          INSERT INTO credit_balances (user_id, credit_type, included_remaining, included_allotment, purchased_remaining, cycle_started_at)
          VALUES (${userId}, ${credit_type}, 0, 0, ${insertAmount}, NOW())
        `;
      }

      // Log transaction (delta: positive for add/set, negative for remove)
      const delta = operation === 'remove' ? -amount : amount;
      const logReason = operation === 'add' ? `Admin add: ${reason}` :
                        operation === 'remove' ? `Admin remove: ${reason}` :
                        `Admin correction: ${reason}`;
      await tx`
        INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
        VALUES (${userId}, ${credit_type}, ${delta}, ${logReason})
      `;
    });

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
