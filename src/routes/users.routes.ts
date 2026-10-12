import express, { type Response as ExpressResponse } from 'express';
import { z } from 'zod';
import sql from '../data/db.js';
import { validateApiAccess, validateApiAccessWithoutStamp } from '../middleware/apiAuth.middleware.js';
// Dashboard-user authentication, for endpoints that serve one customer's own
// data. Same middleware /websites uses.
import { requireSupabaseUser, type SupabaseAuthedRequest } from '../middleware/supabaseAuth.middleware.js';
import { publicPricing } from '../services/credit-pricing.js';
// The signup confirmation + welcome pair, claimed per email so a failure of one
// cannot re-send the other. Called on first contact — see /by-email below.
import { ensureSignupEmails } from '../services/trial-emails.service.js';
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
  getLiveBalance,
  getCreditLotSummary,
  clearWebsiteConnection,
  ensureSignupGrant,
  hasPasswordCredential
} from '../models/user.models.js';

const router = express.Router();

/**
 * The plugin reporting that it is going away.
 *
 * Called when the API Key or Site Code is cleared on the settings page, and on
 * plugin deactivation. Removing credentials is otherwise invisible to us — the
 * plugin simply stops calling, and silence takes a while to become conclusive.
 * This is what makes the CMS accurate immediately in the case a user is most
 * likely to check.
 *
 * ── WHY THIS LIVES HERE AND NOT ON /websites ────────────────────────────────
 * /websites requires a Supabase JWT for every route (see websites.routes.ts).
 * The plugin has no JWT; it holds an API Key and a Site Code, which is what
 * validateApiAccess consumes — the same pair it already sends to /users/status.
 *
 * ── WHY THIS CANNOT BE ABUSED ───────────────────────────────────────────────
 * validateApiAccess has already proved the caller holds a valid API key AND a
 * site code belonging to that same user. So the only site a caller can
 * disconnect is one they could equally well connect, delete, or generate
 * against. It clears a status timestamp and nothing else: no content, no
 * credits, no credentials. Reconnecting is one request.
 *
 * TWO ordering hazards, both handled:
 *
 *  • The plugin must send this while it still HAS the old credentials.
 *    WordPress's update_option_* hooks hand it the previous value, so it can
 *    report the disconnection on its way out.
 *
 *  • Authenticating normally would STAMP this site as connected, and because
 *    that write is fire-and-forget it could land after the clear below. Hence
 *    validateApiAccessWithoutStamp.
 */
router.post('/disconnect', validateApiAccessWithoutStamp, async (req, res) => {
  try {
    const website = (req as any).website;
    await clearWebsiteConnection(website.id);
    res.json({ success: true, data: { website_id: website.id, connected: false } });
  } catch (error: any) {
    // 42703 = undefined_column, i.e. migration 014 has not run on this database
    // yet. There is nothing to clear, so the plugin's report is satisfied.
    if (error?.code === '42703') {
      return res.json({ success: true, data: { connected: false } });
    }
    console.error('Failed to clear website connection:', error);
    res.status(500).json({ success: false, error: 'Failed to record disconnection' });
  }
});

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

    // Per-batch expiry, the same data /credits/:user_id already gives the CMS's
    // breakdown panel (getCreditLotSummary/getLiveBalance). This endpoint used to
    // stop at plan_remaining/purchased_remaining below, so the plugin's own
    // "next to expire" row had no field to read and could never render — the
    // plugin and the CMS described the same balance with different amounts of
    // detail. Added ALONGSIDE credit_details for the same reason `balance` and
    // `lots` were added alongside `data` on /credits/:user_id: existing plugin
    // builds ignore fields they don't recognise, so this cannot break one.
    const balance = await getLiveBalance(user.id);
    const lots = await getCreditLotSummary(user.id);

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
      // The single next-expiry summary and the full per-batch list — same
      // shape /credits/:user_id sends the CMS, so the plugin's breakdown can
      // show real dates instead of the two dateless rows it was limited to.
      balance,
      lots,
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

    // ── Provision the signup grant, if it never happened ──────────────────
    // This is the first API call of every CMS session, and for an account
    // created through supabase.auth.signUp() it is the FIRST time the API sees
    // that account at all — the users row was written by a database trigger.
    // Before this, such an account had no credit lot, so it showed a zero
    // balance and every generation was refused. No-op for everyone else: one
    // existence check and nothing more. See ensureSignupGrant.
    await ensureSignupGrant(user);

    // ── Send the signup emails, if they never went ────────────────────────
    // Same seam, same reasoning. These were poller-only on a 15-minute
    // interval, so a new customer sat in front of a dashboard for up to a
    // quarter of an hour before hearing anything — reported as "the
    // confirmation arrived, but late". Sending from here puts them out while
    // the customer is still on the screen; the scheduler remains the backstop
    // for accounts that never open the CMS.
    //
    // Deliberately NOT awaited. Mail is slower than this request should be,
    // the claims inside make it safe to run concurrently, and a Mailgun outage
    // must not delay — or fail — somebody's dashboard.
    ensureSignupEmails(user).catch((err) => {
      console.error(`[users/by-email] signup emails failed for user ${user.id}:`, err);
    });

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
        // Was `!!user.password_hash`, which is NULL for every web email signup
        // (supabase.auth.signUp + trigger), so those accounts were told they
        // had no password. Supabase Auth is checked too — see the helper.
        has_password: await hasPasswordCredential(user),
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
//
// Guarded, and identity comes from the TOKEN. This used to take `user_id`
// straight from the body with no middleware at all, which made it a second,
// unauthenticated way into the websites table: anyone who knew a numeric user
// id could attach a site to that account. /websites has always worked this way
// (websites.routes.ts) — this route was simply missed.
//
// `user_id` stays in the body for compatibility with existing callers, but it
// is now checked against the token rather than trusted, matching
// websites.routes.ts:53-56.
router.post('/websites', requireSupabaseUser, async (req: SupabaseAuthedRequest, res) => {
  try {
    const { user_id: bodyUserId, url, name } = z.object({
      user_id: z.number().optional(),
      url: z.string().url(),
      name: z.string()
    }).parse(req.body);

    const user_id = req.appUser!.id;
    if (bodyUserId !== undefined && bodyUserId !== user_id) {
      return res.status(403).json({ success: false, error: 'Not authorized for this account.' });
    }

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
 * Real credit CONSUMPTION per action, with the generation counts behind it.
 * GET /api/v1/users/credit-usage/:user_id
 *
 * ── WHY THIS WAS REWRITTEN ──────────────────────────────────────────────────
 * The reported symptom: "I generated content and used 6 credits, but plan usage
 * doesn't show it." The balance dropped correctly; the usage panel stayed at
 * zero. TWO independent faults each zeroed the answer on their own, which is
 * why fixing either alone would have looked like it had not worked:
 *
 *  1. The query read `credit_transactions ... AND generation_id IS NOT NULL`.
 *     The modern content-v2 path reserves credits BEFORE calling the model, so
 *     the generation row does not exist yet and no id is passed. Every v2 charge
 *     therefore writes generation_id NULL and was filtered out before counting.
 *
 *  2. It then did `GROUP BY credit_type` and kept rows whose type was one of
 *     content/images/keywords. Migration 011 collapsed those into a single
 *     weighted pool, so credit_type is now always the literal 'iseo' — matching
 *     none of the three keys. Even a surviving legacy row was discarded.
 *
 * The deeper mistake is that both read the CREDIT ledger to answer a question
 * about ACTIONS. credit_transactions records money-shaped facts — how many
 * credits left which bucket — and since the pool collapse it carries no action
 * discriminator at all. `user_generations` is the table that knows what was
 * actually made, so that is what this now counts. It also yields the generation
 * COUNTS ("12 posts, 8 images") that the credits alone can never give.
 *
 * ── WHERE THE PER-GENERATION COST COMES FROM ────────────────────────────────
 * content-v2 stamps `metadata.billed = { action, variant, cost }` on the row, so
 * the price paid is recorded with the thing it paid for. Legacy v1 rows predate
 * that and have no `billed` block, but they DO pass generation_id, so their cost
 * is recovered from the ledger by the correlated subquery. New rows take the
 * first branch, old rows the second, and a row that somehow has neither counts
 * as a generation costing 0 rather than dropping out of the count entirely.
 *
 * NOTE ON THE JSON SHAPE: `metadata` is written with JSON.stringify into a jsonb
 * column, which stores a jsonb *string* containing JSON rather than an object —
 * so `metadata->'billed'` is null on every row in the database. Unwrapping with
 * `#>> '{}'` is what makes it readable. Both shapes are handled so that fixing
 * the write later cannot break this read.
 *
 * Returns, per action (content / images / keywords):
 *   credits     — credits spent this cycle
 *   generations — how many were produced this cycle
 * plus `lifetime` on the same shape, so a freshly reset cycle does not imply the
 * user has never generated anything.
 *
 * KEYWORD LISTS ARE FREE. `keywords` stays in the payload (generation counts, and
 * clients that still read the key), but `total_cycle_credits` adds up only the
 * actions that cost credits. Runs from before keyword lists went free still carry
 * a ledger cost under `keywords`; they are left out of the total so "Credits Used
 * This Cycle" describes what is billed now.
 */
router.get('/credit-usage/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    if (Number.isNaN(user_id)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }

    // One cycle start per user; balances are refilled together, so the newest
    // cycle_started_at is the current cycle.
    const cycleRows = await sql`
      SELECT MAX(cycle_started_at) AS cycle_started_at
      FROM   credit_balances
      WHERE  user_id = ${user_id}
    `;
    const cycleStart = (cycleRows[0] as any)?.cycle_started_at || null;

    // Only successful generations are usage. A failed run is refunded, so
    // counting it would show credits spent that the user still holds.
    const rows = await sql`
      WITH priced AS (
        SELECT
          CASE WHEN ug.type LIKE 'content%' THEN 'content'
               WHEN ug.type LIKE 'image%'   THEN 'images'
               ELSE 'keywords' END AS action,
          ug.created_at,
          COALESCE(
            -- content-v2: the price is stamped on the generation itself.
            (CASE
               WHEN jsonb_typeof(ug.metadata) = 'string' THEN (ug.metadata #>> '{}')::jsonb
               WHEN jsonb_typeof(ug.metadata) = 'object' THEN ug.metadata
             END -> 'billed' ->> 'cost')::int,
            -- legacy v1: recover it from the ledger row that names this id.
            (SELECT SUM(-ct.delta)::int
               FROM credit_transactions ct
              WHERE ct.generation_id = ug.id::text AND ct.delta < 0),
            0
          ) AS cost
        FROM user_generations ug
        WHERE ug.user_id = ${user_id}
          AND ug.status = 'success'
      )
      SELECT action,
             COALESCE(SUM(cost) FILTER (
               WHERE ${cycleStart}::timestamptz IS NULL OR created_at >= ${cycleStart}::timestamptz
             ), 0)::int AS credits_cycle,
             COUNT(*) FILTER (
               WHERE ${cycleStart}::timestamptz IS NULL OR created_at >= ${cycleStart}::timestamptz
             )::int AS generations_cycle,
             COALESCE(SUM(cost), 0)::int AS credits_lifetime,
             COUNT(*)::int              AS generations_lifetime
      FROM   priced
      GROUP  BY action
    `;

    const blank = () => ({
      content: { credits: 0, generations: 0 },
      images: { credits: 0, generations: 0 },
      keywords: { credits: 0, generations: 0 },
    });
    const cycle = blank();
    const lifetime = blank();

    for (const r of rows as any[]) {
      const action = r.action as keyof ReturnType<typeof blank>;
      if (!(action in cycle)) continue;
      cycle[action] = {
        credits: Number(r.credits_cycle) || 0,
        generations: Number(r.generations_cycle) || 0,
      };
      lifetime[action] = {
        credits: Number(r.credits_lifetime) || 0,
        generations: Number(r.generations_lifetime) || 0,
      };
    }

    const totalCycleCredits = cycle.content.credits + cycle.images.credits;

    res.json({
      success: true,
      data: {
        cycle,
        lifetime,
        cycle_started_at: cycleStart,
        total_cycle_credits: totalCycleCredits,
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

    // The same balance split into the batches that share an expiry date, so the
    // panel can list them individually instead of collapsing everything into
    // one plan figure and one purchased figure. Added ALONGSIDE `balance` for
    // the same reason `balance` was added alongside `data`: existing callers
    // keep working, and a CMS that has not been redeployed simply ignores it.
    const lots = await getCreditLotSummary(user_id);

    // Which cycle the user is in, so the panel can tell this cycle's plan
    // credits from last cycle's without guessing from the dates.
    const cycleStartedAt = (credits as any[])
      .find((c) => c.credit_type === 'iseo')?.cycle_started_at ?? null;

    res.json({
      success: true,
      data: credits,
      balance,
      lots,
      cycle_started_at: cycleStartedAt,
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

/**
 * Monthly article counts for the Overview "Content Growth" chart.
 * GET /api/v1/users/content-growth/:user_id
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The CMS used to build this chart by querying `user_generations` through
 * Supabase from the BROWSER, selecting and filtering a `credit_type` column.
 * That column does not exist on this table, so Postgres answered 42703 on every
 * poll, the CMS caught it, returned null, and fell through to a second path
 * that was itself reading a response shape the server does not send. The panel
 * showed "No content generated yet" to an account with 126 articles, and
 * nothing anywhere failed loudly.
 *
 * Aggregating here fixes the immediate bug and removes the arrangement that
 * caused it: the browser no longer needs to know this table's schema, so the
 * next column change cannot break the chart silently.
 *
 * ── WHAT COUNTS AS CONTENT ──────────────────────────────────────────────────
 * `type LIKE 'content%'` — the same rule /credit-usage applies to the same
 * table, so "a piece of content" means one thing across the product. Images
 * (`image_v2`) and keyword lists are deliberately excluded: this chart is the
 * customer's article output, and counting every row would have reported 178
 * where the honest answer is 120.
 *
 * ── NO ROW CEILING ──────────────────────────────────────────────────────────
 * GROUP BY in SQL, not in JavaScript over a capped page. The path this replaces
 * read at most 1000 rows, which silently truncated both the totals and the
 * anchor month for prolific accounts.
 *
 * Returns [{ month: 'YYYY-MM', count: N }] ascending — the shape
 * buildContentGrowthFromAggregated already consumes.
 */
router.get('/content-growth/:user_id', requireSupabaseUser, async (req: SupabaseAuthedRequest, res) => {
  try {
    // Identity comes from the TOKEN. The :user_id segment is kept because the
    // CMS sends it, but it is checked rather than trusted — this endpoint
    // returns one customer's publishing history and must not serve it to
    // anyone who can type a different number. (The neighbouring
    // /credit-usage/:user_id and /generations/:user_id predate this and take
    // the id from the path unchecked; that is worth closing separately.)
    const requested = parseInt(req.params.user_id);
    if (!Number.isNaN(requested) && requested !== req.appUser!.id) {
      return res.status(403).json({ success: false, error: 'Not authorized for this account.' });
    }

    const rows = await sql`
      SELECT to_char(created_at, 'YYYY-MM') AS month,
             COUNT(*)::int                  AS count
      FROM   user_generations
      WHERE  user_id = ${req.appUser!.id}
        AND  type LIKE 'content%'
      GROUP  BY 1
      ORDER  BY 1
    `;

    res.json({
      success: true,
      data: (rows as any[]).map((r) => ({ month: String(r.month), count: Number(r.count) })),
    });
  } catch (error) {
    console.error('Content growth error:', error);
    res.status(500).json({ success: false, error: 'Failed to load content growth' });
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
      // Deliberately NOT .min(1) here, even though a last name is now required.
      //
      // A Zod failure serialises as a raw issues array, and the CMS surfaces
      // `error` verbatim — so a user who cleared the field would be shown a
      // JSON dump mentioning "too_small" instead of being told to enter their
      // last name. The requirement is enforced just below, in one place, with
      // wording a person can act on and identical for both request shapes.
      last_name: z.string().trim().max(100).optional(),
      // Composed from the parts whenever they are supplied, so this bound now
      // only constrains a legacy caller sending `name` on its own. Raised to
      // 200 so it cannot reject a pair the two fields above would accept.
      name: z.string().trim().min(2).max(200).optional(),
    }).parse(req.body);

    let first = body.first_name ?? '';
    let last = body.last_name ?? '';

    // A last name is REQUIRED as of this change, matching the asterisk the CMS
    // now shows. Enforced on the server as well as in the form because the form
    // is a courtesy and this is the rule — an asterisk nothing validates is
    // decorative, and once one asterisk on a page is decorative none of them
    // mean anything.
    if (body.first_name !== undefined && !last) {
      return res.status(400).json({
        success: false,
        error: 'Enter your last name.',
      });
    }

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
      // A one-word `name` yields no last name, which the parts path above now
      // refuses. Refusing it here too keeps the two forms of this request under
      // the same rule instead of leaving `name` as a way around it.
      if (!last) {
        return res.status(400).json({
          success: false,
          error: 'A last name is required. Send first_name and last_name, or a full name containing both.',
        });
      }
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
/**
 * The page a browser gets. (One-Click POST still gets JSON.)
 *
 * Served from here rather than redirecting to the CMS because the CMS has no
 * /unsubscribe route — the link in every lifecycle email pointed at
 * `${CMS_BASE_URL}/unsubscribe`, fell through the SPA's catch-all, and bounced
 * the reader to a login screen. An unsubscribe link that demands a login is a
 * broken unsubscribe link, and mailbox providers judge us on it.
 *
 * Self-contained HTML with no assets: this has to render for someone who has
 * just told us to stop emailing them, which is the worst possible moment for a
 * dependency to fail.
 */
const unsubscribePage = (ok: boolean, message: string): string => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Unsubscribed' : 'Link expired'} &middot; ImproveSEO</title></head>
<body style="margin:0;background:#FAF9FB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:64px 20px;">
    <div style="font-size:19px;font-weight:700;color:#0B1229;letter-spacing:-0.3px;margin-bottom:24px;">Improve<span style="color:#FF7A59;">SEO</span></div>
    <div style="background:#fff;border:1px solid #E8E8ED;border-radius:12px;padding:36px 32px;">
      <h1 style="margin:0 0 14px;font-size:21px;color:#0B1229;">${ok ? "You're unsubscribed" : 'This link is no longer valid'}</h1>
      <p style="margin:0 0 10px;font-size:15px;line-height:1.65;color:#3A3F44;">${message}</p>
    </div>
    <p style="margin:18px 0 0;font-size:12px;color:#6B7280;">&copy; ${new Date().getFullYear()} ImproveSEO</p>
  </div>
</body></html>`;

const handleUnsubscribe = async (
  token: string,
  res: ExpressResponse,
  format: 'html' | 'json' = 'json',
) => {
  /** Answer in whichever shape the caller asked for. */
  const reply = (status: number, ok: boolean, message: string) =>
    format === 'html'
      ? res.status(status).type('html').send(unsubscribePage(ok, message))
      : res.status(status).json(ok ? { success: true, message } : { success: false, error: message });

  if (!token || token.length < 16) {
    return reply(400, false, 'That unsubscribe link looks incomplete. Please use the link exactly as it appears in the email.');
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
    return reply(400, false, 'This unsubscribe link is no longer valid. If you are still receiving product emails, reply to one of them and we will stop them by hand.');
  }

  console.log(`[unsubscribe] user ${rows[0].id} opted out of lifecycle email`);
  return reply(
    200,
    true,
    'You will not receive any more product emails from us. You will still get billing receipts — we have to tell you when your card is charged.',
  );
};

router.get('/unsubscribe', async (req, res) => {
  try {
    await handleUnsubscribe(String(req.query.token || ''), res, 'html');
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).type('html').send(unsubscribePage(false, 'Something went wrong on our end. Please reply to any of our emails and we will unsubscribe you by hand.'));
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