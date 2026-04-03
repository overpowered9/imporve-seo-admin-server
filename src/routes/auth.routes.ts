import express from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../services/supabase.service.js';
import { findUserByEmail } from '../models/user.models.js';

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

export default router;