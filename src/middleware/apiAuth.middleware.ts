import { Request, Response, NextFunction } from 'express';
import { findUserByApiKey, findWebsiteByCode, getUserCreditBalance, reconcileTrialCredits, touchWebsiteConnection, ISEO_CREDIT_TYPE } from '../models/user.models.js';

export interface AuthenticatedRequest extends Request {
  user?: any;
  website?: any;
}

/** Strips scheme, "www.", path, query, trailing dot and port so "https://www.example.com/" and "example.com:443" compare equal. */
function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * How hard the site_code ↔ domain check bites. Set ISEO_DOMAIN_ENFORCEMENT in the environment.
 *
 *   'log'     (default) — compare and record mismatches, but let every request through.
 *   'enforce'           — reject a mismatch with 403.
 *   'off'               — skip the check entirely.
 *
 * Defaults to 'log' ON PURPOSE. This check sits in the middleware that gates EVERY
 * authenticated route, so a false positive doesn't degrade one feature — it takes the whole
 * product down for that site at once (generation, credits, status, heartbeat). And
 * `websites.domain` is a self-reported string that has never been load-bearing until now:
 * it is set once at signup and there is no endpoint to edit it (websites.routes.ts has only
 * POST and DELETE), so a customer whose stored domain is stale — site migrated, staging
 * clone, moved to a subdomain, typed sloppily — cannot fix it themselves; they would have to
 * delete and re-add the website to get a new site_code.
 *
 * So: deploy on 'log', grep for ISEO_DOMAIN_MISMATCH to see how many REAL requests would have
 * been rejected and whether they are genuine misconfigurations or our own normalization
 * failing, then flip to 'enforce' via the env var — no code deploy needed.
 *
 * NOTE this is a misconfiguration guard, NOT a security control: x-site-domain is asserted by
 * the plugin, and anyone who controls the WordPress install can send whatever they like.
 * It stops the wrong site code being pasted into the wrong site. It stops nothing malicious.
 */
const DOMAIN_ENFORCEMENT = (process.env.ISEO_DOMAIN_ENFORCEMENT || 'log').toLowerCase();

/**
 * Authenticate a plugin request by API Key + Site Code.
 *
 * `stampConnection` exists for exactly one caller: POST /users/disconnect, the
 * plugin reporting that its credentials have just been removed. That request is
 * authenticated like any other, so the default behaviour would stamp the site
 * as connected on its way in — and because the stamp is fire-and-forget, the
 * UPDATE can land AFTER the handler has cleared it, leaving a site the user
 * just disconnected showing as Active. Not stamping is the only ordering that
 * is correct without awaiting a write on the generation hot path.
 */
const authenticate = ({ stampConnection }: { stampConnection: boolean }) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const api_key = req.headers['x-api-key'] as string;
    const site_code = req.headers['x-site-code'] as string;
    const origin = req.headers.origin || req.headers.referer;

    if (!api_key || !site_code) {
      return res.status(401).json({
        success: false,
        error: 'API key and site code are required'
      });
    }

    // Find user by API key
    const user = await findUserByApiKey(api_key);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    // Find website by site code and verify ownership
    const website = await findWebsiteByCode(site_code, user.id);
    if (!website) {
      return res.status(403).json({
        success: false,
        error: 'Website not found or not authorized'
      });
    }

    // Verify the site code was actually issued for the domain making this request.
    //
    // Without this, any site code active on this account authenticates from ANY of the
    // account's domains — e.g. site-a.com's plugin install could paste in site-b.com's
    // site code and both would resolve here identically, since findWebsiteByCode only
    // checks account ownership, never the caller's domain.
    //
    // x-site-domain is the plugin declaring its own home_url() host explicitly, sent on its
    // SERVER-side calls. Origin/Referer is the fallback, and carries the browser-side calls
    // (keyword generation posts straight from wp-admin to this API) — those deliberately do
    // not send the custom header, because it would join the CORS preflight and a plugin
    // update landing before this deploy would break them outright.
    //
    // Exact match after normalization: the old `origin.includes(website.domain)` was a
    // substring test, so "evil-example.com" satisfied a check against "example.com".
    //
    // No domain signal at all stays permissive — that is every request from a not-yet-updated
    // plugin, and refusing them would lock out sites that are correctly connected today.
    // website.domain being empty is treated the same way: a legacy row with no domain
    // recorded must not reject the one site it actually belongs to.
    const claimedDomain = (req.headers['x-site-domain'] as string) || origin;

    if (DOMAIN_ENFORCEMENT !== 'off' && claimedDomain && website.domain) {
      const claimed = normalizeDomain(claimedDomain);
      const registered = normalizeDomain(website.domain);

      if (claimed !== registered) {
        // One greppable line per mismatch — this is the signal that says whether flipping
        // ISEO_DOMAIN_ENFORCEMENT to 'enforce' would break real customers.
        console.warn(
          `ISEO_DOMAIN_MISMATCH mode=${DOMAIN_ENFORCEMENT} user=${user.id} website=${website.id} ` +
          `site_code=${site_code} registered=${registered} claimed=${claimed} ` +
          `source=${req.headers['x-site-domain'] ? 'x-site-domain' : 'origin'} path=${req.originalUrl}`
        );

        if (DOMAIN_ENFORCEMENT === 'enforce') {
          return res.status(403).json({
            success: false,
            error: "This Site Code does not belong to this website's domain."
          });
        }
      }
    }

    // ── Connection heartbeat ────────────────────────────────────────────────
    // Reaching this line means the api_key resolved to a user AND the site_code
    // resolved to a website that user owns — which is exactly what "the plugin
    // has the API Key and Site Code saved correctly" means. The plugin's
    // "Test Server Connection" button lands here via GET /users/status, so the
    // CMS can flip a site to "Active" the moment setup succeeds instead of
    // waiting for its first generation.
    //
    // `x-plugin-heartbeat: 1` marks an UNPROMPTED check-in — the plugin's
    // hourly ping, sent whether or not it has work to do. That is a different
    // fact from "the plugin called us", and the CMS needs both: it may only
    // hold a site's SILENCE against it once that site has proved it would
    // otherwise have spoken. See migration 014 and utils/websiteStatus.js.
    //
    // A presence check rather than a version string, so the plugin can announce
    // the capability without the two sides agreeing a version scheme.
    const heartbeat = String(req.headers['x-plugin-heartbeat'] ?? '') === '1';

    // Deliberately NOT awaited: this is bookkeeping for a status chip, and a
    // slow or failed write must never delay or break a customer's content
    // generation. touchWebsiteConnection swallows its own errors, including
    // Postgres 42703 when migration 008 or 014 has not run yet (same tolerance
    // the address endpoints use), so the catch here is only a backstop against
    // an unexpected synchronous throw.
    if (stampConnection) void touchWebsiteConnection(website.id, { heartbeat });

    // Attach user and website to request
    req.user = user;
    req.website = website;

    next();
  } catch (error) {
    console.error('API validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

export const validateApiAccess = authenticate({ stampConnection: true });

/** Same authentication, but does not record a connection. See `authenticate`. */
export const validateApiAccessWithoutStamp = authenticate({ stampConnection: false });

/**
 * Legacy pre-flight credit check, retained for the older generation routes only.
 *
 * ⚠️  NOT atomic: it reads the balance here and leaves the write to the end of the handler, so two
 * concurrent requests can both pass it and both generate. The v2 money paths
 * (/content-v2/article, /content-v2/image) no longer use it — they call reserveCredits(), where the
 * check and the debit are one conditional UPDATE. Anything new must do the same.
 *
 * `creditType` is now only a LABEL for the error message. There is a single pool ('iseo'), so the
 * balance is always read from it: passing the historical 'images' | 'content' | 'keywords' values
 * would otherwise read rows that migration 011 deletes, and 402 every request on routes the plugin
 * still depends on (notably /generate/generatekeyword).
 */
export const validateCredits = (creditType: 'images' | 'content' | 'keywords' | 'iseo', requiredAmount: number = 1) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Trial enforcement: free-plan accounts get a time-boxed trial (started at
      // signup). When it ends, the TRIAL (included) credits are voided — but
      // PURCHASED top-up credits keep working (the user paid for those).
      // Upgrading to a paid plan changes plan_id, which bypasses this entirely.
      //
      // reconcileTrialCredits uses the *effective* trial end (created_at + TRIAL_DAYS
      // when trial_ends_at was never set), so a missing timestamp can't slip past the
      // gate. It voids the plan credits and returns true iff this is a free-plan account
      // with an expired trial; after it runs, `amount` reflects purchased credits only.
      const trialExpired = await reconcileTrialCredits(req.user);
      if (trialExpired) {
        const purchasedBalance = await getUserCreditBalance(req.user.id, ISEO_CREDIT_TYPE);
        if (purchasedBalance < requiredAmount) {
          return res.status(402).json({
            success: false,
            error: 'Your free trial has ended. Upgrade your plan or buy credits to continue generating content.',
            code: 'TRIAL_EXPIRED',
          });
        }
        // Purchased credits cover the request — allow it through.
        return next();
      }

      const balance = await getUserCreditBalance(req.user.id, ISEO_CREDIT_TYPE);
      
      if (balance < requiredAmount) {
        return res.status(402).json({
          success: false,
          error: `Insufficient ISEO credits. Required: ${requiredAmount}, Available: ${balance}`,
          creditType,
          required: requiredAmount,
          available: balance
        });
      }

      next();
    } catch (error) {
      console.error('Credit validation error:', error);
      res.status(500).json({
        success: false,
        error: 'Credit validation failed'
      });
    }
  };
};