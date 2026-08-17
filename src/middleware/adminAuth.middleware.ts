/**
 * Admin authentication for the admin panel and every credit-granting route.
 *
 * Replaces the placeholder that used to live in routes/admin/prompts.routes.ts, which set a mock
 * admin id and called next() unconditionally — leaving POST /api/v1/admin/users/:userId/gift-credits
 * open to anyone who could reach the host.
 *
 * WHY AN ENV ALLOWLIST RATHER THAN A DB ROLE
 * There is no role/is_admin concept anywhere in this codebase: /auth/login is the ordinary Supabase
 * user login and the admin frontend simply stores that same token under the `admin_token` key. So
 * verifying the JWT alone is NOT sufficient — every registered end user holds a valid one. A role
 * had to be introduced, and an env allowlist is used because:
 *   - it needs no migration on the critical path of a security fix;
 *   - it solves the bootstrap problem (a DB flag has no one to grant the first admin);
 *   - it matches this service's existing stance that privileged config lives in env with no runtime
 *     write path, so the admin set cannot be changed by any request.
 * Swapping to a users.is_admin column later only requires changing isAdminEmail() below.
 *
 * FAILS CLOSED: if ADMIN_EMAILS is unset or empty, nobody is an admin and every admin route 403s.
 * That is deliberate — an unconfigured deploy must not be an open one.
 */
import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { supabaseAdmin } from '../services/supabase.service.js';
import { findUserByEmail, type User } from '../models/user.models.js';

// Load env HERE, not relying on the caller. index.ts calls dotenv.config() in its module body,
// which runs AFTER this import is evaluated — so a module-level read of process.env would see
// nothing and lock every admin out. config.ts uses the same self-loading pattern. Idempotent.
dotenv.config();

export interface AdminAuthedRequest extends Request {
  adminUser?: User;
  /** Kept for the prompt routes, which recorded an author id against prompt versions. */
  adminId?: number;
}

/**
 * Parsed once at module load: the allowlist cannot change while the process runs, so a leaked
 * request path can never widen it. Emails are compared lower-cased and trimmed.
 */
const ADMIN_EMAILS: ReadonlySet<string> = Object.freeze(
  new Set(
    (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  ),
) as ReadonlySet<string>;

if (ADMIN_EMAILS.size === 0) {
  // Not fatal — the server is still fully usable for end users; only the admin surface is closed.
  console.warn(
    '⚠️  ADMIN_EMAILS is empty — all admin routes will reject with 403. Set it to a comma-separated list to enable the admin panel.',
  );
}

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Verify a Supabase JWT and require the caller to be on the admin allowlist.
 *
 * Mount this on the ROUTER, not on individual routes, so a route added later cannot be forgotten.
 */
export const requireAdmin = async (req: AdminAuthedRequest, res: Response, next: NextFunction) => {
  try {
    // Idempotent: prompts.routes.ts also lists this per-route, and the router is mounted behind it.
    // Without this guard every admin request would verify the JWT twice (two Supabase round-trips).
    // Keeping both layers is deliberate defence-in-depth — the mount is the guarantee, the per-route
    // usage documents intent at the call site — but it should only cost one verification.
    if (req.adminUser) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    }
    const jwt = authHeader.slice(7);

    let result: Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>;
    try {
      // Same 8 s guard as requireSupabaseUser: a hung auth call must not hold the request open.
      result = await Promise.race([
        supabaseAdmin.auth.getUser(jwt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('jwt_timeout')), 8000)),
      ]);
    } catch (err: any) {
      if (err?.message === 'jwt_timeout') {
        return res
          .status(503)
          .json({ success: false, error: 'Authentication service unavailable. Please try again in a moment.' });
      }
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    if (result.error || !result.data.user?.email) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const email = result.data.user.email;

    // Authenticated but not privileged. 403 (not 404) is safe here: the caller already proved who
    // they are, so this leaks nothing they did not already know about their own account.
    if (!isAdminEmail(email)) {
      console.warn(`⛔ admin route refused for non-admin ${email} (${req.method} ${req.originalUrl})`);
      return res.status(403).json({ success: false, error: 'Administrator access required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Admin account not found.' });
    }

    req.adminUser = user;
    req.adminId = user.id;
    next();
  } catch (error) {
    console.error('adminAuth middleware error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};

export default requireAdmin;
