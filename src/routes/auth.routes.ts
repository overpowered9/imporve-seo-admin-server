import express from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../services/supabase.service.js';
import { findUserByEmail, findUserByOAuth, createOAuthUser, updateUserOAuthData, initializeUserCredits } from '../models/user.models.js';

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
      provider: z.string(), // 'google', 'github', etc.
      user: z.object({
        id: z.string(), // OAuth provider user ID
        email: z.string().email(),
        name: z.string().optional().default(''),
        image: z.string().optional() // Avatar URL from provider
      })
    }).parse(req.body);

    // Check if user already exists with this OAuth provider
    let existingUser = await findUserByOAuth(provider, user.id);
    
    if (existingUser) {
      // Update profile data if needed
      await updateUserOAuthData(existingUser.id, {
        name: user.name,
        avatar_url: user.image
      });
      
      // Return existing user
      const updated = await findUserByOAuth(provider, user.id);
      return res.json({
        success: true,
        message: 'User authenticated successfully',
        data: {
          user: {
            id: updated?.id,
            email: updated?.email,
            name: updated?.name,
            api_key: updated?.api_key,
            plan_id: updated?.plan_id,
            avatar_url: updated?.avatar_url
          }
        }
      });
    }

    // Check if email already exists (from previous email/password signup)
    let emailUser = await findUserByEmail(user.email);
    
    if (emailUser) {
      // Link OAuth account to existing email account
      await updateUserOAuthData(emailUser.id, {
        avatar_url: user.image,
        name: user.name || emailUser.name
      });
      
      // Also update oauth fields directly
      await supabaseAdmin
        .from('users')
        .update({
          oauth_provider: provider,
          oauth_id: user.id,
          avatar_url: user.image,
          updated_at: new Date().toISOString()
        })
        .eq('id', emailUser.id);
      
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

    // Create new user from OAuth
    const newUser = await createOAuthUser({
      email: user.email,
      name: user.name,
      oauth_provider: provider,
      oauth_id: user.id,
      avatar_url: user.image,
      plan_id: 1 // DEFAULT/FREE plan
    });

    // Initialize user credits
    await initializeUserCredits(newUser.id, 1);

    res.status(201).json({
      success: true,
      message: 'User created successfully via OAuth',
      data: {
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          api_key: newUser.api_key,
          plan_id: newUser.plan_id,
          avatar_url: newUser.avatar_url
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