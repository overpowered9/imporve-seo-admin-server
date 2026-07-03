import express from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { supabaseAdmin } from '../services/supabase.service.js';
import sql from '../data/db.js';
import { findUserByEmail, findUserByOAuth, createUser, createOAuthUser, updateUserOAuthData, initializeUserCredits, generateApiKey, getFreePlanId, setPasswordHash, createWebsite, findWebsiteByDomain, findWebsiteByUserAndDomain, grantFreeCreditsWithEmail, type TrialGrantResult, type User } from '../models/user.models.js';
import { sendEmail, emailTemplates } from '../services/email.service.js';
import { checkCompanyEmail } from '../services/company-email.js';
import { hashCode, timingSafeEqualHex, consumeLinkProof } from '../services/link-verification.js';

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
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check if email is confirmed
    if (!data.user?.email_confirmed_at) {
      return res.status(400).json({
        success: false,
        error: 'Please verify your email before logging in'
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

    // 2. Check if email already exists (links OAuth to existing account)
    const emailUser = await findUserByEmail(user.email);

    if (emailUser) {
      try {
        await updateUserOAuthData(emailUser.id, { avatar_url: user.image, name: user.name || emailUser.name });
      } catch { /* non-fatal */ }

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
// Email verification (company-email gate for free credits)
// ─────────────────────────────────────────────────────────────────────────────

// Verify the Supabase JWT (8s timeout) and return the auth user, or an error tuple.
async function getAuthedSupabaseUser(
  req: express.Request,
): Promise<{ user: NonNullable<Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>['data']['user']> } | { error: string; status: number }> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing or invalid Authorization header', status: 401 };
  }
  const jwt = authHeader.slice(7);
  try {
    const result = await Promise.race([
      supabaseAdmin.auth.getUser(jwt),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('jwt_timeout')), 8000)),
    ]);
    if (result.error || !result.data.user) return { error: 'Invalid or expired token', status: 401 };
    return { user: result.data.user };
  } catch (err: any) {
    if (err.message === 'jwt_timeout') return { error: 'Authentication service unavailable. Please try again in a moment.', status: 503 };
    return { error: 'Invalid or expired token', status: 401 };
  }
}

/**
 * POST /api/v1/auth/request-link-code
 * Auth: Supabase JWT. Sends a 6-digit code to a company email so the user can
 * unlock the one-time free credits for a site link. Rate-limited; policy-checked.
 */
router.post('/request-link-code', async (req, res) => {
  try {
    const auth = await getAuthedSupabaseUser(req);
    if ('error' in auth) return res.status(auth.status).json({ success: false, error: auth.error });

    const { email, site_domain } = z.object({
      email: z.string().email(),
      site_domain: z.string().min(1).max(253),
    }).parse(req.body);

    const normEmail = email.trim().toLowerCase();
    const domain = site_domain.replace(/^www\./, '').toLowerCase().trim();

    // Company-email policy
    const policy = checkCompanyEmail(normEmail);
    if (!policy.ok) return res.status(400).json({ success: false, error: policy.message, code: policy.code });

    // Early reject: this email already claimed a grant (better UX than a doomed code).
    const used = await sql`SELECT 1 FROM credit_grants WHERE lower(email) = ${normEmail} LIMIT 1`;
    if (used[0]) return res.status(409).json({ success: false, error: 'This email has already been used to claim free credits.', code: 'EMAIL_ALREADY_USED' });

    const user = await findUserByEmail(auth.user.email!);
    if (!user) return res.status(404).json({ success: false, error: 'User account not found.' });

    // Rate limit: 60s between sends per (user,email); max 5 requests/hour per user.
    const recent = await sql`
      SELECT last_sent_at FROM email_verifications
      WHERE user_id = ${user.id} AND lower(email) = ${normEmail}
      ORDER BY last_sent_at DESC LIMIT 1
    `;
    if (recent[0] && Date.now() - new Date(recent[0].last_sent_at).getTime() < 60_000) {
      return res.status(429).json({ success: false, error: 'Please wait a minute before requesting another code.' });
    }
    const hourCount = await sql`
      SELECT count(*)::int c FROM email_verifications
      WHERE user_id = ${user.id} AND created_at > NOW() - INTERVAL '1 hour'
    `;
    if ((hourCount[0]?.c ?? 0) >= 5) {
      return res.status(429).json({ success: false, error: 'Too many code requests. Please try again later.' });
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const rows = await sql`
      INSERT INTO email_verifications (email, code_hash, purpose, user_id, site_domain, expires_at, last_sent_at)
      VALUES (${normEmail}, ${codeHash}, 'site_link', ${user.id}, ${domain}, ${expiresAt.toISOString()}, NOW())
      RETURNING id
    `;

    const tpl = emailTemplates.linkVerificationCode(code, domain);
    const sent = await sendEmail({ to: normEmail, subject: tpl.subject, html: tpl.html, text: tpl.text });

    // Dev fallback: if Mailgun isn't configured yet, return the code (non-prod only)
    // so the flow is testable end-to-end.
    const devFallback = !sent && process.env.NODE_ENV !== 'production';
    if (!sent && !devFallback) {
      return res.status(502).json({ success: false, error: 'Could not send the verification email. Please try again.' });
    }

    return res.json({
      success: true,
      verification_id: rows[0].id,
      ...(devFallback ? { dev_code: code } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: 'Invalid request data', details: error.errors });
    const errorId = crypto.randomBytes(4).toString('hex');
    console.error(`[request-link-code] [${errorId}]`, error);
    return res.status(500).json({ success: false, error: 'Internal server error', error_id: errorId });
  }
});

/**
 * POST /api/v1/auth/verify-link-code
 * Auth: Supabase JWT. Checks the 6-digit code and, on success, returns a single-use
 * link_proof (15-min TTL) that the connect / add-website grant paths consume.
 */
router.post('/verify-link-code', async (req, res) => {
  try {
    const auth = await getAuthedSupabaseUser(req);
    if ('error' in auth) return res.status(auth.status).json({ success: false, error: auth.error });

    const { verification_id, code } = z.object({
      verification_id: z.number().int(),
      code: z.string().regex(/^\d{6}$/),
    }).parse(req.body);

    const user = await findUserByEmail(auth.user.email!);
    if (!user) return res.status(404).json({ success: false, error: 'User account not found.' });

    const rows = await sql`
      SELECT * FROM email_verifications WHERE id = ${verification_id} AND user_id = ${user.id} LIMIT 1
    `;
    const v = rows[0] as any;
    if (!v) return res.status(404).json({ success: false, error: 'Verification not found.' });
    if (v.consumed_at) return res.status(410).json({ success: false, error: 'This code was already used. Request a new one.' });
    if (new Date(v.expires_at).getTime() < Date.now()) return res.status(410).json({ success: false, error: 'Code expired. Please request a new one.' });
    if (v.attempts >= 5) return res.status(429).json({ success: false, error: 'Too many incorrect attempts. Please request a new code.' });

    if (!timingSafeEqualHex(hashCode(code), v.code_hash)) {
      await sql`UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ${v.id}`;
      return res.status(400).json({ success: false, error: 'Incorrect code.', attempts_left: Math.max(0, 5 - (v.attempts + 1)) });
    }

    const proof = crypto.randomBytes(32).toString('hex');
    const proofExpires = new Date(Date.now() + 15 * 60 * 1000);
    await sql`
      UPDATE email_verifications
      SET consumed_at = NOW(), proof_token = ${proof}, proof_expires_at = ${proofExpires.toISOString()}
      WHERE id = ${v.id}
    `;
    return res.json({ success: true, link_proof: proof, email: v.email });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: 'Invalid request data', details: error.errors });
    const errorId = crypto.randomBytes(4).toString('hex');
    console.error(`[verify-link-code] [${errorId}]`, error);
    return res.status(500).json({ success: false, error: 'Internal server error', error_id: errorId });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Connect Token endpoints
// ─────────────────────────────────────────────────────────────────────────────

const issueConnectTokenSchema = z.object({
  site_domain: z.string().min(1).max(253),
  source: z.literal('plugin').optional(),
  link_proof: z.string().optional(), // single-use proof from verify-link-code; unlocks the grant
});

/**
 * POST /api/v1/auth/issue-connect-token
 *
 * Authenticated with Supabase JWT (Authorization: Bearer <token>).
 * Enforces one-trial-per-account and one-trial-per-domain rules,
 * then creates (or retrieves) the website entry and returns a short-lived
 * opaque token for the plugin to exchange.
 */
router.post('/issue-connect-token', async (req, res) => {
  try {
    // ── 1. Validate request body first (sync, no network cost) ─────────────
    const { site_domain, link_proof } = issueConnectTokenSchema.parse(req.body);
    // Normalise: strip leading www. so "www.example.com" and "example.com" are the same site
    const domain = site_domain.replace(/^www\./, '').toLowerCase().trim();

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

    // ── 4. Resolve this account's website row (connection = ownership/linkage) ──
    // Connecting is decoupled from the credit grant. The ONLY hard block is a site
    // that is actively owned by a DIFFERENT account right now.
    const activeElsewhere = allDomainRows.find(r => r.active && r.user_id !== user.id);
    if (activeElsewhere) {
      return res.status(409).json({
        success: false,
        error: 'This website is currently connected to another account. Remove it there first.',
        code: 'DOMAIN_CONFLICT',
      });
    }

    // Reconnect own active row, reactivate own soft-deleted row, or create a fresh one.
    let websiteId: number;
    let site_code: string;
    const ownActiveRow   = allDomainRows.find(r => r.active && r.user_id === user.id);
    const ownSoftDeleted = allDomainRows.find(r => !r.active && r.user_id === user.id);

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
          // A concurrent request raced us and inserted first (unique partial index on
          // domain WHERE active=true). createWebsite may throw with or without .code.
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

    // ── 5. One-time free credit grant — requires a verified company email ────
    // Connecting always succeeds above. Credits are only awarded when a valid,
    // single-use link_proof (from verify-link-code) is presented, and only if the
    // account, domain and verified email have never been granted before.
    const verifiedEmail = await consumeLinkProof(link_proof, user.id, domain);
    const grant: TrialGrantResult | 'unverified' = verifiedEmail
      ? await grantFreeCreditsWithEmail(user.id, websiteId, domain, verifiedEmail)
      : 'unverified';

    let trial_status: 'new' | 'reconnect' | 'none';
    let trial_reason: string | null = null;
    if (grant === 'granted') {
      trial_status = 'new';                 // free credits awarded
    } else if (ownActiveRow || ownSoftDeleted) {
      trial_status = 'reconnect';           // their own existing site, no new grant
    } else {
      trial_status = 'none';                // connected, but no credits granted
      trial_reason = grant;                 // 'account_used' | 'domain_used' | 'email_used' | 'unverified'
    }

    // ── 6. Issue short-lived connect token (idempotent) ─────────────────────
    // Return an existing valid token if one already exists for this user+site_code.
    // This handles the race where the client calls this endpoint twice in quick
    // succession (e.g. TOKEN_REFRESHED firing alongside INITIAL_SESSION).
    const existingRows = await sql`
      SELECT token, trial_status, trial_reason FROM connect_tokens
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
      // Keep the response consistent with what exchange will later return: reuse the
      // outcome recorded when this token was first issued (the grant ran on that call).
      trial_status = (existingRows[0].trial_status as typeof trial_status) || trial_status;
      trial_reason = (existingRows[0].trial_reason as typeof trial_reason) ?? trial_reason;
    } else {
      token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // Opportunistic cleanup — runs async, doesn't block the response
      sql`DELETE FROM connect_tokens WHERE expires_at < NOW() - INTERVAL '1 hour'`.catch(() => {/* ignore */});

      // Persist the trial outcome on the token so the redirect-fallback path (which
      // never receives the postMessage) can read the exact status at exchange time.
      await sql`
        INSERT INTO connect_tokens (token, user_id, site_code, expires_at, trial_status, trial_reason)
        VALUES (${token}, ${user.id}, ${site_code}, ${expiresAt.toISOString()}, ${trial_status}, ${trial_reason})
      `;
    }

    return res.json({
      success: true,
      data: {
        connect_token: token,
        trial_status,   // 'new' | 'reconnect' | 'none'
        trial_reason,   // 'account_used' | 'domain_used' | null  (only when status === 'none')
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

    return res.json({
      success: true,
      data: {
        api_key: row.api_key,
        site_code: row.site_code,
        user_name: row.user_name,
        email: row.email,
        // Trial is now a one-time credit grant with no expiry — surface the recorded
        // outcome so the redirect-fallback path shows the correct screen 3 variant.
        trial_status: row.trial_status || 'new',          // 'new' | 'reconnect' | 'none'
        trial_reason: row.trial_reason || null,           // 'account_used' | 'domain_used' | null
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