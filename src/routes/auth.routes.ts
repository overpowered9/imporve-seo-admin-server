import express from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { supabaseAdmin } from '../services/supabase.service.js';
import sql from '../data/db.js';
import { findUserByEmail, findUserByOAuth, createUser, createOAuthUser, updateUserOAuthData, initializeUserCredits, ensureSignupGrant, generateApiKey, getFreePlanId, setPasswordHash, createWebsite, findWebsiteByDomain, findWebsiteByUserAndDomain, getUserWebsites, getUserWithPlan, startUserTrial, type User } from '../models/user.models.js';

const router = express.Router();

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(8),
  plan_id: z.number().optional(),
  source: z.enum(['plugin', 'web']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

// Signup with email verification
router.post('/signup', async (req, res) => {
  try {
    const { email, name, password, plan_id, source } = signupSchema.parse(req.body);
    const isPluginSignup = source === 'plugin';
    
    // Create user in Supabase Auth
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      // Plugin signups are auto-confirmed — the user is present in the popup completing the flow
      email_confirm: isPluginSignup ? true : false,
      user_metadata: {
        name,
        plan_id
      }
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    // Get or create user in our users table.
    // Idempotent: a Supabase DB trigger may have already inserted the row, in which case
    // findUserByEmail finds it. If no trigger exists (common in self-managed setups),
    // we create it explicitly so issue-connect-token never returns 404 for new signups.
    let user = await findUserByEmail(email);
    if (!user) {
      const freePlanId = await getFreePlanId();
      const apiKey = generateApiKey();
      user = await createUser({ email, name, api_key: apiKey, plan_id: freePlanId, password });
      await initializeUserCredits(user.id, freePlanId);
    }

    // Every signup starts the free trial (idempotent — the DB trigger may have
    // already started it when it created the row).
    await startUserTrial(user.id);

    res.status(201).json({
      success: true,
      message: isPluginSignup
        ? 'User created successfully.'
        : 'User created successfully. Please check your email for verification.',
      data: {
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
          api_key: user?.api_key,
          plan_id: user?.plan_id,
          email_confirmed: isPluginSignup,
        }
      }
    });
    
  } catch (error) {
    console.error('Signup error:', error);
    if (error instanceof z.ZodError) {
      // Map validation issues to a single friendly sentence instead of leaking
      // the raw zod issue array through error.message.
      const first = error.errors[0];
      const field = first?.path?.join('.') || 'input';
      const friendly =
        field === 'password' ? 'Password must be at least 8 characters.' :
        field === 'email'    ? 'Please enter a valid email address.' :
        field === 'name'     ? 'Please enter your name (at least 2 characters).' :
        `Invalid ${field}.`;
      return res.status(400).json({ success: false, error: friendly });
    }
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Signup failed'
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    
    // Authenticate with Supabase
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      // Supabase rejects unconfirmed accounts BEFORE credentials succeed, so the
      // email_confirmed_at check below never fires for them — detect it here and
      // return an actionable message instead of a misleading "Invalid credentials".
      if (/email\s*not\s*confirmed/i.test(error.message || '')) {
        return res.status(400).json({
          success: false,
          error: 'Please verify your email before logging in. Check your inbox for the confirmation link.',
          code: 'EMAIL_NOT_CONFIRMED',
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check if email is confirmed (defensive — normally caught above)
    if (!data.user?.email_confirmed_at) {
      return res.status(400).json({
        success: false,
        error: 'Please verify your email before logging in',
        code: 'EMAIL_NOT_CONFIRMED',
      });
    }

    // Get user details from our users table
    const user = await findUserByEmail(email);
    
    res.json({
      success: true,
      data: {
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
          api_key: user?.api_key,
          plan_id: user?.plan_id
        },
        session: {
          access_token: data.session?.access_token,
          refresh_token: data.session?.refresh_token
        }
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Login failed'
    });
  }
});

// Request password reset
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email);
    
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.json({
      success: true,
      message: 'Password reset email sent'
    });
    
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to send reset email'
    });
  }
});

// Verify whether a user can reset their password
router.post('/verify-reset-eligibility', async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);

    const user = await findUserByEmail(email);

    if (!user) {
      return res.json({
        success: true,
        eligible: false,
        reason: 'no_account',
        message: 'No account found with this email address.',
      });
    }

    if (user.oauth_provider && !user.password_hash) {
      return res.json({
        success: true,
        eligible: false,
        reason: 'oauth_only',
        provider: user.oauth_provider,
        message: `This account uses ${user.oauth_provider.charAt(0).toUpperCase() + user.oauth_provider.slice(1)} sign-in. Please sign in with ${user.oauth_provider.charAt(0).toUpperCase() + user.oauth_provider.slice(1)} and set a password in your account settings.`,
      });
    }

    return res.json({
      success: true,
      eligible: true,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Unable to verify account.',
    });
  }
});

// Mark that an OAuth user has set a password (called from Settings after supabase.auth.updateUser)
router.post('/set-password', async (req, res) => {
  try {
    const { email, password } = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    }).parse(req.body);

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    await setPasswordHash(user.id, password);

    return res.json({ success: true, message: 'Password set successfully.' });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set password.',
    });
  }
});

// Resend confirmation email
router.post('/resend-confirmation', async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    
    const { error } = await supabaseAdmin.auth.resend({
      type: 'signup',
      email
    });
    
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    
    res.json({
      success: true,
      message: 'Confirmation email sent'
    });
    
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to send confirmation email'
    });
  }
});

// OAuth user sync/creation - called when user authenticates with OAuth provider
// This endpoint is typically called from the frontend after successful OAuth authentication
router.post('/oauth-callback', async (req, res) => {
  try {
    const { provider, user } = z.object({
      provider: z.string(),
      user: z.object({
        id: z.string(),
        email: z.string().email(),
        name: z.string().optional().default(''),
        image: z.string().optional()
      })
    }).parse(req.body);

    // 1. Try OAuth-specific lookup first (requires migration columns)
    let existingUser = null;
    try {
      existingUser = await findUserByOAuth(provider, user.id);
    } catch {
      // oauth_provider/oauth_id columns may not exist yet — fall through to email lookup
    }

    if (existingUser) {
      try {
        await updateUserOAuthData(existingUser.id, { name: user.name, avatar_url: user.image });
      } catch { /* columns may not exist — non-fatal */ }

      return res.json({
        success: true,
        message: 'User authenticated successfully',
        data: {
          user: {
            id: existingUser.id,
            email: existingUser.email,
            name: user.name || existingUser.name,
            api_key: existingUser.api_key,
            plan_id: existingUser.plan_id,
            avatar_url: user.image || existingUser.avatar_url
          }
        }
      });
    }

    // 2. Check if email already exists (links OAuth to existing account).
    // Backfill oauth_provider/oauth_id here: trigger-created rows for OAuth
    // signups have them NULL, which broke Google-only account detection.
    const emailUser = await findUserByEmail(user.email);

    if (emailUser) {
      try {
        await updateUserOAuthData(emailUser.id, {
          avatar_url: user.image,
          name: user.name || emailUser.name,
          oauth_provider: provider,
          oauth_id: user.id,
        });
      } catch { /* non-fatal */ }
      await startUserTrial(emailUser.id); // idempotent — ensure the trial exists
      // A Google signup lands HERE, not in the "brand new user" branch below:
      // the auth.users trigger has already written the public.users row, so
      // findUserByEmail succeeds and this reads as "linking an existing
      // account". That meant initializeUserCredits below was never reached and
      // the new account got nothing. Idempotent, so genuinely existing accounts
      // are untouched. See ensureSignupGrant.
      await ensureSignupGrant(emailUser);

      return res.json({
        success: true,
        message: 'OAuth account linked to existing user',
        data: {
          user: {
            id: emailUser.id,
            email: emailUser.email,
            name: user.name || emailUser.name,
            api_key: emailUser.api_key,
            plan_id: emailUser.plan_id,
            avatar_url: user.image
          }
        }
      });
    }

    // 3. Brand new user — create account
    const freePlanId = await getFreePlanId();
    let newUser;
    try {
      // Full create with OAuth columns (requires migration)
      newUser = await createOAuthUser({
        email: user.email,
        name: user.name,
        oauth_provider: provider,
        oauth_id: user.id,
        avatar_url: user.image,
        plan_id: freePlanId
      });
    } catch {
      // Fallback: create without OAuth columns (pre-migration)
      const { api_key } = { api_key: generateApiKey() };
      const result = await sql`
        INSERT INTO users (email, name, api_key, plan_id)
        VALUES (${user.email}, ${user.name || 'User'}, ${api_key}, ${freePlanId})
        RETURNING id, email, name, api_key, plan_id, created_at, updated_at
      `;
      newUser = result[0] as User;
    }

    await initializeUserCredits(newUser.id, freePlanId);
    await startUserTrial(newUser.id);

    return res.status(201).json({
      success: true,
      message: 'User created successfully via OAuth',
      data: {
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          api_key: newUser.api_key,
          plan_id: newUser.plan_id,
          avatar_url: (newUser as User).avatar_url || user.image
        }
      }
    });

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'OAuth callback failed'
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Connect Token endpoints
// ─────────────────────────────────────────────────────────────────────────────

const issueConnectTokenSchema = z.object({
  site_domain: z.string().min(1).max(253),
  source: z.literal('plugin').optional(),
});

/**
 * POST /api/v1/auth/issue-connect-token
 *
 * Authenticated with Supabase JWT (Authorization: Bearer <token>).
 * Links the site to the account (any number of accounts may link the same
 * domain) and returns a short-lived opaque token for the plugin to exchange.
 * Credits/trial are granted at SIGNUP, not here.
 */
router.post('/issue-connect-token', async (req, res) => {
  try {
    // ── 1. Validate request body first (sync, no network cost) ─────────────
    const { site_domain } = issueConnectTokenSchema.parse(req.body);
    // Normalise: trim + lowercase FIRST, then strip www. (order matters — an
    // uppercase "WWW." would survive a case-sensitive strip done before lowercasing).
    const domain = site_domain.trim().toLowerCase().replace(/^www\./, '');

    // ── 2. Verify Supabase JWT (8 s timeout — guards against auth service hangs) ──
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    }
    const jwt = authHeader.slice(7);
    let supabaseUser: Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>['data']['user'];
    try {
      const result = await Promise.race([
        supabaseAdmin.auth.getUser(jwt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('jwt_timeout')), 8000)
        ),
      ]);
      if (result.error || !result.data.user) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
      }
      supabaseUser = result.data.user;
    } catch (err: any) {
      if (err.message === 'jwt_timeout') {
        return res.status(503).json({ success: false, error: 'Authentication service unavailable. Please try again in a moment.' });
      }
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    // ── 3. Fetch user record + domain rows in parallel ──────────────────────
    const [user, allDomainRows] = await Promise.all([
      findUserByEmail(supabaseUser.email!),
      findWebsiteByDomain(domain),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found. Please contact support.' });
    }

    // ── 4. Resolve this account's website row ────────────────────────────────
    // Any number of accounts may link the same domain — other accounts' rows for
    // this domain are simply ignored. Reconnect own active row, reactivate own
    // soft-deleted row, or create a fresh one.
    let websiteId: number;
    let site_code: string;
    const ownActiveRow   = allDomainRows.find(r => r.active && r.user_id === user.id);
    const ownSoftDeleted = allDomainRows.find(r => !r.active && r.user_id === user.id);

    // Enforce the plan's website_limit whenever this connect would ACTIVATE a new
    // site (fresh create or soft-delete reactivation). Reconnecting an already
    // active site never counts. Previously only the dashboard add-website path
    // enforced this, so the plugin flow bypassed the limit entirely.
    if (!ownActiveRow) {
      const userWithPlan = await getUserWithPlan(user.id);
      if (userWithPlan && userWithPlan.website_limit !== null) {
        const activeSites = await getUserWebsites(user.id);
        if (activeSites.length >= userWithPlan.website_limit) {
          return res.status(403).json({
            success: false,
            error: `Website limit reached. Your plan allows ${userWithPlan.website_limit} website(s). Remove a site or upgrade your plan to connect this one.`,
            code: 'WEBSITE_LIMIT_REACHED',
          });
        }
      }
    }

    if (ownActiveRow) {
      websiteId = ownActiveRow.id;
      site_code = ownActiveRow.site_code;
    } else if (ownSoftDeleted) {
      await sql`UPDATE websites SET active = true, deleted_at = NULL WHERE id = ${ownSoftDeleted.id}`;
      websiteId = ownSoftDeleted.id;
      site_code = ownSoftDeleted.site_code;
    } else {
      let newSite;
      try {
        newSite = await createWebsite(user.id, domain, false);
      } catch (error: any) {
        if (error.code === '23505' || error.message === 'Failed to generate unique site code') {
          // A concurrent request raced us on site_code generation.
          return res.status(409).json({
            success: false,
            error: 'Connection is already in progress. Please try again in a moment.',
            code: 'CONCURRENT_REQUEST',
          });
        }
        throw error;
      }
      websiteId = newSite.id;
      site_code = newSite.site_code;
    }

    // ── 5. Trial info (granted at signup — nothing to grant here) ────────────
    const trial_status: 'new' | 'reconnect' = (ownActiveRow || ownSoftDeleted) ? 'reconnect' : 'new';
    const trial_ends_at = user.trial_ends_at ? new Date(user.trial_ends_at).toISOString() : null;
    const days_remaining = user.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(user.trial_ends_at).getTime() - Date.now()) / 86_400_000))
      : null;

    // ── 6. Issue short-lived connect token (idempotent) ─────────────────────
    // Return an existing valid token if one already exists for this user+site_code.
    // This handles the race where the client calls this endpoint twice in quick
    // succession (e.g. TOKEN_REFRESHED firing alongside INITIAL_SESSION).
    const existingRows = await sql`
      SELECT token FROM connect_tokens
      WHERE  user_id   = ${user.id}
        AND  site_code = ${site_code}
        AND  used      = false
        AND  expires_at > NOW()
      ORDER BY expires_at DESC
      LIMIT 1
    `;

    let token: string;
    if (existingRows[0]) {
      token = existingRows[0].token as string;
    } else {
      token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // Opportunistic cleanup — runs async, doesn't block the response
      sql`DELETE FROM connect_tokens WHERE expires_at < NOW() - INTERVAL '1 hour'`.catch(() => {/* ignore */});

      // Persist trial_status so the redirect-fallback path (which never receives
      // the postMessage) can read it at exchange time.
      await sql`
        INSERT INTO connect_tokens (token, user_id, site_code, expires_at, trial_status)
        VALUES (${token}, ${user.id}, ${site_code}, ${expiresAt.toISOString()}, ${trial_status})
      `;
    }

    return res.json({
      success: true,
      data: {
        connect_token: token,
        trial_status,     // 'new' | 'reconnect'
        trial_ends_at,    // ISO timestamp or null
        days_remaining,   // integer days left in the trial, or null
      },
    });

  } catch (error) {
    const errorId = crypto.randomBytes(4).toString('hex');
    console.error(`[issue-connect-token] [${errorId}]`, error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request data', details: error.errors });
    }
    res.status(500).json({ success: false, error: 'Internal server error', error_id: errorId });
  }
});

const exchangeConnectTokenSchema = z.object({
  connect_token: z.string().length(64), // 32 bytes → 64 hex chars
});

/**
 * POST /api/v1/auth/exchange-connect-token
 *
 * Public endpoint (no auth required). Called by the WordPress plugin immediately
 * after receiving the connect_token via postMessage. Single-use + 5-min TTL.
 * Returns the credentials the plugin needs (api_key, site_code, trial info).
 */
router.post('/exchange-connect-token', async (req, res) => {
  try {
    const { connect_token } = exchangeConnectTokenSchema.parse(req.body);

    // ── 1. Atomically mark token as used and retrieve it in one query ───────
    // Using a single UPDATE…RETURNING prevents TOCTOU races where two concurrent
    // requests both see used=false, both pass validation, and both receive credentials.
    const markedRows = await sql`
      UPDATE connect_tokens
      SET    used = true
      WHERE  token      = ${connect_token}
        AND  used       = false
        AND  expires_at > NOW()
      RETURNING *
    `;

    if (!markedRows[0]) {
      // Determine the exact reason for the caller to display the right message
      const checkRows = await sql`
        SELECT used, expires_at FROM connect_tokens WHERE token = ${connect_token} LIMIT 1
      `;
      if (!checkRows[0]) {
        return res.status(404).json({ success: false, error: 'Token not found', code: 'TOKEN_NOT_FOUND' });
      }
      if (checkRows[0].used) {
        return res.status(410).json({ success: false, error: 'Token has already been used', code: 'TOKEN_USED' });
      }
      return res.status(410).json({ success: false, error: 'Token has expired. Please reconnect.', code: 'TOKEN_EXPIRED' });
    }

    const tokenRow = markedRows[0] as any;

    // ── 2. Fetch user credentials ───────────────────────────────────────────
    const userRows = await sql`
      SELECT api_key, name AS user_name, email, trial_started_at, trial_ends_at
      FROM   users
      WHERE  id = ${tokenRow.user_id}
      LIMIT  1
    `;
    if (!userRows[0]) {
      return res.status(404).json({ success: false, error: 'User account not found', code: 'USER_NOT_FOUND' });
    }
    const row = { ...tokenRow, ...userRows[0] } as any;

    // Days remaining in the signup trial (7-day window started at signup).
    let days_remaining: number | null = null;
    if (row.trial_ends_at) {
      const msLeft = new Date(row.trial_ends_at).getTime() - Date.now();
      days_remaining = Math.max(0, Math.ceil(msLeft / 86_400_000));
    }

    return res.json({
      success: true,
      data: {
        api_key: row.api_key,
        site_code: row.site_code,
        user_name: row.user_name,
        email: row.email,
        trial_status: row.trial_status || 'new',  // 'new' | 'reconnect'
        trial_started_at: row.trial_started_at,
        trial_ends_at: row.trial_ends_at,
        days_remaining,
      },
    });

  } catch (error) {
    const errorId = crypto.randomBytes(4).toString('hex');
    console.error(`[exchange-connect-token] [${errorId}]`, error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid token format', details: error.errors });
    }
    res.status(500).json({ success: false, error: 'Internal server error', error_id: errorId });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

export default router;