import express from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../services/supabase.service.js';
import sql from '../data/db.js';
import { findUserByEmail, findUserByOAuth, createOAuthUser, updateUserOAuthData, initializeUserCredits, generateApiKey, getFreePlanId, setPasswordHash, type User } from '../models/user.models.js';

const router = express.Router();

const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(8),
  plan_id: z.number().optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

// Signup with email verification
router.post('/signup', async (req, res) => {
  try {
    const { email, name, password, plan_id } = signupSchema.parse(req.body);
    
    // Create user in Supabase Auth (this will trigger our database function)
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false, // Require email confirmation
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

    // Get the created user from our users table
    const user = await findUserByEmail(email);
    
    res.status(201).json({
      success: true,
      message: 'User created successfully. Please check your email for verification.',
      data: {
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
          api_key: user?.api_key,
          plan_id: user?.plan_id,
          email_confirmed: false
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

export default router;