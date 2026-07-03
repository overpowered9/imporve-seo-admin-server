/**
 * Supabase JWT auth middleware for user-facing dashboard routes.
 *
 * Verifies the Bearer token with Supabase (8 s timeout), loads the matching
 * public.users row, and attaches it as req.appUser. Rejects with 401/503.
 */
import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../services/supabase.service.js';
import { findUserByEmail, type User } from '../models/user.models.js';

export interface SupabaseAuthedRequest extends Request {
  appUser?: User;
}

export const requireSupabaseUser = async (
  req: SupabaseAuthedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    }
    const jwt = authHeader.slice(7);

    let result: Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>;
    try {
      result = await Promise.race([
        supabaseAdmin.auth.getUser(jwt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('jwt_timeout')), 8000)),
      ]);
    } catch (err: any) {
      if (err.message === 'jwt_timeout') {
        return res.status(503).json({ success: false, error: 'Authentication service unavailable. Please try again in a moment.' });
      }
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
    if (result.error || !result.data.user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const user = await findUserByEmail(result.data.user.email!);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User account not found.' });
    }

    req.appUser = user;
    next();
  } catch (error) {
    console.error('supabaseAuth middleware error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};
