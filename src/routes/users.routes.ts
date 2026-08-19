import express, { type Response as ExpressResponse } from 'express';
import { z } from 'zod';
import sql from '../data/db.js';
import { validateApiAccess } from '../middleware/apiAuth.middleware.js';
import { publicPricing } from '../services/credit-pricing.js';
import { 
  findUserByEmail,
  findUserByApiKey,
  ISEO_CREDIT_TYPE,
  getUserCreditBalances,
  getUserWebsites,
  getUserWithPlan,
  getUserAnalytics,
  getUserGenerations,
  getUserWebsiteStats,
  addUserWebsite,
  deleteUserWebsite,
  getUserSubscription,
  updateUserName,
  updateUserProfileName,
  regenerateApiKey,
  reconcileTrialCredits,
  effectiveTrialEnd,
  getLiveBalance
} from '../models/user.models.js';

const router = express.Router();

// User status endpoint for WordPress plugin connection testing
router.get('/status', validateApiAccess, async (req, res) => {
  try {
    // This endpoint is called with API key authentication
    // The middleware should have populated req.user and req.website
    const user = (req as any).user;
    const website = (req as any).website;
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated'
      });
    }

    // Void any expired trial (plan) credits before reading, so the numbers we return
    // reflect the truth immediately rather than only after a generation attempt.
    const trialExpired = await reconcileTrialCredits(user);

    // Get user credit balances
    const credits = await getUserCreditBalances(user.id);

    // Get user subscription/plan details
    const subscription = await getUserSubscription(user.id);

    const iseoBalance = credits.find(c => c.credit_type === ISEO_CREDIT_TYPE)?.amount || 0;

    // Per-type plan-vs-purchased breakdown, so clients (the plugin's connection panel)
    // can explain a balance instead of showing a bare number.
    // One pool now, so every legacy label resolves to the SAME row. Kept as a function so the
    // three compatibility keys below keep rendering for plugins/CMS builds that have not updated.
    const detailFor = (_t: string) => {
      const c = credits.find(cr => cr.credit_type === ISEO_CREDIT_TYPE);
      return {
        total: c?.amount ?? 0,
        plan_remaining: c?.included_remaining ?? 0,
        purchased_remaining: c?.purchased_remaining ?? 0,
        allotment: c?.included_allotment ?? 0,
      };
    };

    // Trial window (effective end falls back to created_at + TRIAL_DAYS when unset).
    const trialEnd = effectiveTrialEnd(user);
    const daysRemaining = trialEnd
      ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86_400_000))
      : null;
    const isPaid = !!subscription;

    res.json({
      success: true,
      user: user.name || user.email,
      email: user.email,
      website: website?.domain,
      // THE balance. One ISEO pool.
      credits_total: iseoBalance,
      // Pricing so a client can show what an action will cost BEFORE the user commits. Advisory
      // only — the server reservation is the real gate and the client never states which price
      // applies (regeneration is detected server-side).
      pricing: publicPricing(),
      // COMPATIBILITY SHIM — kept for one release so an un-updated plugin/CMS does not break.
      // All three report the same pooled number rather than a third of it, so a legacy display
      // shows what the user actually has. Remove once both consumers read credits_total.
      credits: {
        images: iseoBalance,
        content: iseoBalance,
        keywords: iseoBalance
      },
      credit_details: {
        images: detailFor('images'),
        content: detailFor('content'),
        keywords: detailFor('keywords'),
      },
      plan: {
        name: isPaid ? subscription.plan_name : 'Free',
        slug: isPaid ? subscription.plan_slug : 'free',
        is_paid: isPaid,
        is_free: !isPaid,
      },
      trial: {
        active: !isPaid && !trialExpired && !!trialEnd,
        expired: trialExpired,
        ends_at: trialEnd ? trialEnd.toISOString() : null,
        days_remaining: daysRemaining,
      },
      trial_expired: trialExpired,
      subscription: subscription || null,
      server_status: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('User status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user status'
    });
  }
});

// Get user by email (for frontend auth context)
router.post('/by-email', async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Void any expired trial (plan) credits before reading, so the dashboard shows the
    // truthful post-expiry balance (plan credits zeroed, purchased preserved).
    const trialExpired = await reconcileTrialCredits(user);

    // Get user with plan details
    const userWithPlan = await getUserWithPlan(user.id);

    // Get credit balances
    const credits = await getUserCreditBalances(user.id);

    // Get websites
    const websites = await getUserWebsites(user.id);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        // Migration 009. `SELECT *` omits these on a database that has not run
        // it yet, so they arrive as null and the CMS falls back to splitting
        // `name` — the profile form still shows something sensible either way.
        first_name: user.first_name ?? null,
        last_name: user.last_name ?? null,
        api_key: user.api_key,
        plan_id: user.plan_id,
        plan_name: userWithPlan?.plan_name,
        plan_slug: userWithPlan?.plan_slug,
        website_limit: userWithPlan?.website_limit,
        scheduled_publishing: userWithPlan?.scheduled_publishing,
        course_access: userWithPlan?.course_access,
        oauth_provider: user.oauth_provider || null,
        has_password: !!user.password_hash,
        credits,
        websites_count: websites.length,
        created_at: user.created_at,
        trial_started_at: user.trial_started_at || null,
        trial_ends_at: user.trial_ends_at || null,
        trial_expired: trialExpired
      }
    });
    
  } catch (error) {
    console.error('Get user by email error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get user'
    });
  }
});

// Get user profile (authenticated route)
router.get('/profile/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    
    const user = await getUserWithPlan(user_id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const credits = await getUserCreditBalances(user_id);
    const websites = await getUserWebsites(user_id);
    
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          api_key: user.api_key,
          plan_id: user.plan_id,
          plan_name: user.plan_name,
          plan_slug: user.plan_slug,
          website_limit: user.website_limit,
          scheduled_publishing: user.scheduled_publishing,
          course_access: user.course_access,
          created_at: user.created_at
        },
        credits,
        websites,
        statistics: {
          websites_count: websites.length,
          active_websites: websites.filter(w => w.active).length
        }
      }
    });
    
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user profile'
    });
  }
});

// Get user websites
router.get('/websites/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const websites = await getUserWebsites(user_id);
    
    res.json({
      success: true,
      data: websites
    });
  } catch (error) {
    console.error('Get user websites error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user websites'
    });
  }
});

// Add user website
router.post('/websites', async (req, res) => {
  try {
    const { user_id, url, name } = z.object({
      user_id: z.number(),
      url: z.string().url(),
      name: z.string()
    }).parse(req.body);
    
    const website = await addUserWebsite(user_id, url, name);
    
    res.json({
      success: true,
      data: website
    });
  } catch (error) {
    console.error('Add website error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add website'
    });
  }
});

// Delete user website
router.delete('/websites/:website_id', async (req, res) => {
  try {
    const website_id = parseInt(req.params.website_id);
    
    await deleteUserWebsite(website_id);
    
    res.json({
      success: true,
      message: 'Website deleted successfully'
    });
  } catch (error) {
    console.error('Delete website error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete website'
    });
  }
});

/**
 * Real credit CONSUMPTION per type.
 * GET /api/v1/users/credit-usage/:user_id
 *
 * Bug 12: the dashboard showed "0 credits used" after several projects had
 * been run. It derived usage arithmetically as
 * `included_allotment - included_remaining`, which silently collapses to 0
 * whenever `included_allotment` is 0 — true for balance rows created before the
 * bucket columns existed, and whenever the plan lookup it fell back to didn't
 * resolve. It also ignored anything paid for out of PURCHASED credits entirely,
 * so a user spending top-ups always read as 0 used.
 *
 * This counts what actually happened instead. `credit_transactions` rows with a
 * `generation_id` are consumption events written by deductCredits — one row per
 * generation, whichever bucket paid for it. Grants, refills, purchases and
 * trial suspensions have no generation_id and are excluded, so an expiry sweep
 * can never be mistaken for usage.
 *
 * Returns both:
 *   cycle    — since cycle_started_at, what "X of Y used" should reconcile with
 *   lifetime — all time, so a brand-new cycle doesn't imply the user never generated
 */
router.get('/credit-usage/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    if (Number.isNaN(user_id)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }

    // One cycle start per user; balances are refilled together, so the newest
    // cycle_started_at is the current cycle for every type.
    const cycleRows = await sql`
      SELECT MAX(cycle_started_at) AS cycle_started_at
      FROM   credit_balances
      WHERE  user_id = ${user_id}
    `;
    const cycleStart = (cycleRows[0] as any)?.cycle_started_at || null;

    // delta is negative for debits; negate to report a positive "used" count.
    const rows = await sql`
      SELECT credit_type,
             COALESCE(SUM(-delta) FILTER (
               WHERE ${cycleStart}::timestamptz IS NULL OR created_at >= ${cycleStart}::timestamptz
             ), 0)::int AS used_cycle,
             COALESCE(SUM(-delta), 0)::int AS used_lifetime
      FROM   credit_transactions
      WHERE  user_id = ${user_id}
        AND  delta < 0
        AND  generation_id IS NOT NULL
      GROUP  BY credit_type
    `;

    const empty = { content: 0, images: 0, keywords: 0 };
    const cycle: Record<string, number> = { ...empty };
    const lifetime: Record<string, number> = { ...empty };
    for (const r of rows as any[]) {
      if (r.credit_type in cycle) {
        cycle[r.credit_type] = Number(r.used_cycle) || 0;
        lifetime[r.credit_type] = Number(r.used_lifetime) || 0;
      }
    }

    res.json({
      success: true,
      data: {
        cycle,
        lifetime,
        cycle_started_at: cycleStart,
      },
    });
  } catch (error) {
    console.error('Get credit usage error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch credit usage' });
  }
});

// Get user credits
router.get('/credits/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);

    // Void any expired trial (plan) credits before reading, so the dashboard tiles
    // reflect the post-expiry balance immediately (plan credits 0, purchased kept).
    const user = await getUserWithPlan(user_id);
    if (user) await reconcileTrialCredits(user as any);

    const credits = await getUserCreditBalances(user_id);

    // The balance panel needs the ONE spendable number, where it sits, and when
    // it dies — all computed from the lots, the only place that knows.
    //
    // Added ALONGSIDE `data` rather than replacing it: several callers still
    // read the raw rows, and quietly changing that shape underneath them is how
    // the CMS came to be summing three stale rows in the first place.
    const balance = await getLiveBalance(user_id);

    res.json({
      success: true,
      data: credits,
      balance,
    });
  } catch (error) {
    console.error('Get user credits error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user credits'
    });
  }
});

// Get user subscription
router.get('/subscription/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const subscription = await getUserSubscription(user_id);
    
    res.json({
      success: true,
      data: subscription
    });
  } catch (error) {
    console.error('Get user subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user subscription'
    });
  }
});

// Get user generations
router.get('/generations/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const limit = parseInt(req.query.limit as string) || 10;
    const page = parseInt(req.query.page as string) || 1;
    const offset = (page - 1) * limit;
    
    console.log('🔍 User generations route called:', { user_id, limit, page, offset });
    
    const generations = await getUserGenerations(user_id, { limit, offset });
    
    res.json({
      success: true,
      data: generations
    });
  } catch (error) {
    console.error('Get user generations error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user generations'
    });
  }
});

// Get user analytics
router.get('/analytics/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const analytics = await getUserAnalytics(user_id);
    
    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    console.error('Get user analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user analytics'
    });
  }
});

// Get user website stats
router.get('/website-stats/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const stats = await getUserWebsiteStats(user_id);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get website stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get website stats'
    });
  }
});

// Update user profile (name)
/**
 * Address for tax purposes (task3.md 4.2).
 * GET  /api/v1/users/address/:user_id
 * PUT  /api/v1/users/address/:user_id
 *
 * Kept as its own endpoint rather than folded into the profile PATCH so the
 * onboarding prompt and the Settings form share one contract, and so the
 * "has the user given us an address yet?" read is a single cheap query.
 *
 * PII: these fields are returned ONLY here, for the user's own record. They are
 * deliberately absent from /users/by-email and /users/status, so no
 * plugin-facing or session-bootstrap response ever carries a postal address.
 * Nothing here is logged — note the catch blocks log the error, never req.body.
 */
const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(1).max(120),
  // Optional: many countries (e.g. most of the EU) have no state/province.
  state: z.string().trim().max(120).optional().nullable(),
  // Optional for the same reason — a handful of countries have no postal code
  // at all. Validating a US-shaped ZIP globally would lock those users out.
  postal_code: z.string().trim().max(32).optional().nullable(),
  country: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/),
});

router.get('/address/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    if (Number.isNaN(user_id)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }
    const rows = await sql`
      SELECT address_line1, address_line2, address_city, address_state,
             address_postal_code, address_country, address_updated_at
      FROM   users WHERE id = ${user_id} LIMIT 1
    `;
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    const r = rows[0] as any;
    res.json({
      success: true,
      data: {
        line1: r.address_line1,
        line2: r.address_line2,
        city: r.address_city,
        state: r.address_state,
        postal_code: r.address_postal_code,
        country: r.address_country,
        updated_at: r.address_updated_at,
        // The single flag the UI prompts on, so the client never has to
        // re-derive "is this complete?" and get it subtly different.
        has_address: !!(r.address_line1 && r.address_city && r.address_country),
      },
    });
  } catch (error: any) {
    // 42703 = undefined_column: migration 003 has not run on this database yet.
    // Deploys and migrations race in most setups, so the code must tolerate
    // running ahead of the schema rather than 500-ing at every caller. Report
    // "no address on file" — which is true — and flag it as unavailable so the
    // client can stay quiet instead of prompting for something it cannot save.
    if (error?.code === '42703') {
      console.warn('[address] address columns missing — run `npm run migrate:address`. Reporting no address.');
      return res.json({
        success: true,
        data: { has_address: false, available: false },
      });
    }
    console.error('Get address error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch address' });
  }
});

router.put('/address/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    if (Number.isNaN(user_id)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }
    const a = addressSchema.parse(req.body);
    const rows = await sql`
      UPDATE users
      SET    address_line1       = ${a.line1},
             address_line2       = ${a.line2 || null},
             address_city        = ${a.city},
             address_state       = ${a.state || null},
             address_postal_code = ${a.postal_code || null},
             address_country     = ${a.country.toUpperCase()},
             address_updated_at  = NOW(),
             updated_at          = NOW()
      WHERE  id = ${user_id}
      RETURNING id
    `;
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: 'Address saved' });
  } catch (error) {
    // Log the failure, never the payload — it contains a postal address.
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Please check the address fields',
        details: error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      });
    }
    // Same missing-schema case as the GET above. A save genuinely cannot
    // succeed here, so this stays an error — but a specific, actionable one
    // rather than a generic 500 that looks like the user's fault.
    if ((error as any)?.code === '42703') {
      console.warn('[address] address columns missing — run `npm run migrate:address`.');
      return res.status(503).json({
        success: false,
        error: 'Address storage is not available yet. Please try again later.',
        code: 'ADDRESS_STORAGE_UNAVAILABLE',
      });
    }
    console.error('Save address error:', error instanceof Error ? error.message : 'unknown');
    res.status(500).json({ success: false, error: 'Failed to save address' });
  }
});

router.patch('/profile/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    // The CMS now collects the parts (migration 009). `name` is still accepted
    // so an older client — or anything else already calling this endpoint —
    // keeps working; it is split on the first space, the same rule the backfill
    // uses. Exactly one of the two forms must be supplied.
    const body = z.object({
      // 100 per part, matching the maxLength the CMS puts on the two inputs.
      // These were 50, a bound the form could exceed but could not warn about:
      // a 60-character first name typed into a field that happily accepted it
      // came back as a Zod failure naming neither the field nor the real limit.
      // The two numbers have to agree, and the form's is the looser one.
      first_name: z.string().trim().min(1).max(100).optional(),
      last_name: z.string().trim().max(100).optional(),
      // Composed from the parts whenever they are supplied, so this bound now
      // only constrains a legacy caller sending `name` on its own. Raised to
      // 200 so it cannot reject a pair the two fields above would accept.
      name: z.string().trim().min(2).max(200).optional(),
    }).parse(req.body);

    let first = body.first_name ?? '';
    let last = body.last_name ?? '';

    if (!body.first_name) {
      if (!body.name) {
        return res.status(400).json({
          success: false,
          error: 'Provide first_name (and optionally last_name), or name.',
        });
      }
      const spaceAt = body.name.indexOf(' ');
      first = spaceAt === -1 ? body.name : body.name.slice(0, spaceAt);
      last = spaceAt === -1 ? '' : body.name.slice(spaceAt + 1).trim();
    }

    const updated = await updateUserProfileName(user_id, first, last);
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        // May be undefined pre-migration-009; the CMS falls back to splitting
        // `name` in that case rather than blanking the fields.
        first_name: updated.first_name ?? null,
        last_name: updated.last_name ?? null
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update profile'
    });
  }
});

// Regenerate API key
router.post('/regenerate-api-key/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const newKey = await regenerateApiKey(user_id);

    res.json({
      success: true,
      message: 'API key regenerated successfully',
      api_key: newKey
    });
  } catch (error) {
    console.error('Regenerate API key error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to regenerate API key'
    });
  }
});

/**
 * One-click unsubscribe from lifecycle email.  (BILL-008)
 *
 * GET  /api/v1/users/unsubscribe?token=…   — for a browser link
 * POST /api/v1/users/unsubscribe           — for List-Unsubscribe-Post
 *
 * DELIBERATELY UNAUTHENTICATED, and that is correct: an unsubscribe link that
 * requires signing in is an unsubscribe link that does not work, and mailbox
 * providers treat the One-Click header as a promise that a POST alone
 * suffices. The token is unguessable, per-user, and grants exactly one power —
 * to stop lifecycle mail. It cannot read or change anything else.
 *
 * Idempotent: unsubscribing twice is a success, not an error. A user who clicks
 * the link again must not see a failure page.
 *
 * Note this suppresses LIFECYCLE mail only. Billing receipts continue, because
 * a customer who is being charged has to be told — see suppressionReason.
 */
const handleUnsubscribe = async (token: string, res: ExpressResponse) => {
  if (!token || token.length < 16) {
    return res.status(400).json({ success: false, error: 'Invalid unsubscribe link.' });
  }

  const rows = await sql`
    UPDATE users
    SET    marketing_opt_out_at = COALESCE(marketing_opt_out_at, NOW())
    WHERE  unsubscribe_token = ${token}
    RETURNING id, email
  `;

  if (rows.length === 0) {
    // Do not distinguish "no such token" from any other failure: the endpoint
    // is unauthenticated, and a precise answer turns it into an oracle for
    // probing valid tokens.
    return res.status(400).json({ success: false, error: 'This unsubscribe link is no longer valid.' });
  }

  console.log(`[unsubscribe] user ${rows[0].id} opted out of lifecycle email`);
  return res.json({
    success: true,
    message: 'You have been unsubscribed from product emails. You will still receive billing receipts.',
  });
};

router.get('/unsubscribe', async (req, res) => {
  try {
    await handleUnsubscribe(String(req.query.token || ''), res);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ success: false, error: 'Could not process the unsubscribe. Please contact support.' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    await handleUnsubscribe(String(req.body?.token || req.query.token || ''), res);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ success: false, error: 'Could not process the unsubscribe. Please contact support.' });
  }
});

export default router;