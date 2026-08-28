/**
 * Small per-user, in-memory rate limiter.
 *
 * Exists for /generate/auxiliary, which is authenticated but charges no credits and is retried up
 * to four times per article by the plugin's meta-length enforcement. Without a cap, an
 * authenticated caller can spin it indefinitely at our cost. It is genuinely sub-cent per call, so
 * a credit line would be disproportionate — a ceiling on call rate is the right control.
 *
 * DELIBERATE LIMITATIONS, so nobody mistakes this for a general-purpose limiter:
 *  - State is per process. Render can run several instances, so the effective ceiling is
 *    (limit x instances). That is fine for an abuse ceiling; it would NOT be fine for anything
 *    security-critical or for exact quota enforcement — those belong in the database.
 *  - It is a fixed window, not a sliding one, so a caller can burst across a window boundary.
 *
 * If either limitation ever matters, replace this with a Redis/Postgres-backed limiter rather than
 * tightening the numbers here.
 */
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './apiAuth.middleware.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/** Keyed by user id. Entries are evicted lazily on access and by the sweeper below. */
const buckets = new Map<string, Bucket>();

/**
 * Stop the map growing without bound on a long-lived process. Runs rarely and only touches expired
 * entries. `unref()` so this timer never holds the process open (it would break test runs and
 * graceful shutdown).
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

export interface RateLimitOptions {
  /** Max requests allowed per window, per user. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Shown to the caller when the limit trips. */
  message?: string;
}

/**
 * Limit an authenticated route per user.
 *
 * Must be mounted AFTER validateApiAccess, since it keys off req.user. If no user is present the
 * request is passed through untouched rather than bucketed under a shared key — sharing one bucket
 * across all anonymous callers would let one of them deny service to the rest.
 */
export function rateLimitPerUser({ limit, windowMs, message }: RateLimitOptions) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId) return next();

    const key = String(userId);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        error: message || 'Too many requests. Please slow down and try again shortly.',
        retry_after_seconds: retryAfterSec,
      });
    }

    bucket.count += 1;
    next();
  };
}

/**
 * Limit an UNAUTHENTICATED route per client IP.
 *
 * Exists for POST /auth/admin-login, which guards a single shared static password. Without a
 * ceiling that password is open to unlimited online guessing, and one password is the whole
 * security of the admin surface — so a cap matters far more here than the per-user limiter's
 * cost control does.
 *
 * Requires `app.set('trust proxy', ...)` to be correct, or req.ip is the proxy's address and
 * every caller lands in one shared bucket. index.ts sets it for Render's single hop.
 *
 * Inherits the per-process and fixed-window limitations documented at the top of this file.
 * Both are worse here than for the per-user limiter — several instances multiply the ceiling,
 * so treat this as a brute-force *ceiling*, not a guarantee. It buys enough time for a strong
 * password to hold; it does not make a weak one safe.
 */
export function rateLimitPerIp({ limit, windowMs, message }: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Namespaced so an IP key can never collide with a user id key in the shared map.
    const key = `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        error: message || 'Too many requests. Please slow down and try again shortly.',
        retry_after_seconds: retryAfterSec,
      });
    }

    bucket.count += 1;
    next();
  };
}

/** Exposed for tests, so one case cannot leak counts into the next. */
export function __resetRateLimitBuckets(): void {
  buckets.clear();
}
