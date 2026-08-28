/**
 * Admin authentication for the admin panel and every credit-granting route.
 *
 * MODEL: one static password, held in ADMIN_PASSWORD, exchanged at
 * POST /api/v1/auth/admin-login for a short-lived signed session token. The panel is a
 * single-operator internal tool, so it carries no per-person identity: there are no admin
 * accounts, no roles, and every admin action is attributed to 'admin'.
 *
 * This replaces a Supabase-JWT + ADMIN_EMAILS allowlist scheme. That scheme required an
 * admin to also be a registered end user, which coupled the panel to the customer auth
 * system for no benefit. ADMIN_EMAILS still exists and is still read — but only by
 * services/billing/notification-jobs.ts, to decide who receives operator emails. It no
 * longer grants any access.
 *
 * WHY A SIGNED TOKEN RATHER THAN SENDING THE PASSWORD ON EVERY REQUEST
 * Treating the password itself as the bearer credential would park it in localStorage and
 * put it on the wire on every call. Exchanging it once for a token means it is sent exactly
 * once per session, and a leaked token expires on its own.
 *
 * The HMAC key IS the password, deliberately: rotating ADMIN_PASSWORD invalidates every
 * outstanding session, which is what you want from a rotation and costs no extra config.
 *
 * FAILS CLOSED: if ADMIN_PASSWORD is unset or empty, nobody can log in and every admin
 * route rejects. An unconfigured deploy must not be an open one.
 *
 * KNOWN LIMITS, so this is not mistaken for per-user auth:
 *  - One shared secret. There is no way to tell two operators apart, and revoking one
 *    person means rotating the password for everyone.
 *  - No revocation list. A token stays valid until it expires.
 * Both are acceptable for a single-operator internal panel and neither is acceptable if
 * this ever grows real multi-admin use — at that point move to per-user accounts.
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load env HERE, not relying on the caller. index.ts calls dotenv.config() in its module body,
// which runs AFTER this import is evaluated — so a module-level read of process.env would see
// nothing and lock every admin out. config.ts uses the same self-loading pattern. Idempotent.
dotenv.config();

export interface AdminAuthedRequest extends Request {
  /**
   * Recorded as the author on prompt versions. The static-password model has no per-person
   * identity, so this is always the literal 'admin'. Kept so the prompt routes have a
   * stable value to store rather than writing `undefined` into a required column.
   */
  adminId?: string;
}

/** Read once at module load: a leaked request path can never change it while the process runs. */
const ADMIN_PASSWORD: string = (process.env.ADMIN_PASSWORD || '').trim();

/** How long an issued token stays valid. Optional; 12h keeps a working day to one sign-in. */
const SESSION_HOURS: number = (() => {
  const raw = Number(process.env.ADMIN_SESSION_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
})();

if (!ADMIN_PASSWORD) {
  // Not fatal — the server is still fully usable for end users; only the admin surface is closed.
  console.warn(
    '⚠️  ADMIN_PASSWORD is not set — admin login is disabled and all admin routes will reject. ' +
      'Set it to enable the admin panel.',
  );
} else if (ADMIN_PASSWORD.length < 12) {
  // A single shared password protects every credit-granting route; a short one is guessable
  // even with the login rate limit in front of it.
  console.warn(
    `⚠️  ADMIN_PASSWORD is only ${ADMIN_PASSWORD.length} characters. Use at least 12 — ` +
      'this one password guards every admin and credit-granting route.',
  );
}

/**
 * Constant-time comparison of two strings.
 *
 * Hashes both sides first so the buffers are always 32 bytes: timingSafeEqual throws on a
 * length mismatch, and calling it on raw inputs would leak the password's length through
 * that exception. A plain `===` would leak its content through timing.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** HMAC over the encoded payload, keyed by the password. */
function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update(payloadB64).digest('base64url');
}

/**
 * True if `password` matches ADMIN_PASSWORD. Returns false — never throws — for any
 * non-string or empty input, and always false when the server is unconfigured.
 */
export function checkAdminPassword(password: unknown): boolean {
  if (!ADMIN_PASSWORD) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  return safeEqual(password, ADMIN_PASSWORD);
}

/** Mint a session token. Caller must have already verified the password. */
export function issueAdminToken(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt }), 'utf8').toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

/** True if `token` carries a valid, unexpired signature. */
export function verifyAdminToken(token: string): boolean {
  if (!ADMIN_PASSWORD) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return false;

  // Signature first: never parse a payload that has not been authenticated.
  if (!safeEqual(signature, sign(payloadB64))) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof decoded?.exp === 'number' && Date.now() < decoded.exp;
  } catch {
    return false;
  }
}

/**
 * Require a valid admin session token.
 *
 * Mount this on the ROUTER, not on individual routes, so a route added later cannot be forgotten.
 */
export const requireAdmin = (req: AdminAuthedRequest, res: Response, next: NextFunction) => {
  // 503, not 401: the caller did nothing wrong and retrying with better credentials cannot
  // help — the server is missing configuration and an operator has to fix it.
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      success: false,
      error: 'Admin access is not configured on this server.',
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
  }

  if (!verifyAdminToken(authHeader.slice(7))) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  req.adminId = 'admin';
  next();
};

export default requireAdmin;
