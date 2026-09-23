/**
 * Password confirmation emails.  (Settings → Update Security)
 *
 * "A confirmation email should be sent whenever a password is SET (Scenario 2)
 * or CHANGED (Scenarios 1 and 3)."
 *
 *   Scenario 1  email + password account changes it      → password_changed
 *   Scenario 2  Google account with no password sets one → password_set
 *   Scenario 3  Google account with a password changes it → password_changed
 *   reset link  forgot-password flow                      → password_changed
 *
 * All four end at POST /auth/set-password (the CMS's api.setPassword), which is
 * why the email is queued there and nowhere else.
 *
 * ── WHY THE CMS SAYS WHICH EVENT IT WAS ─────────────────────────────────────
 * By the time this route runs, Supabase already holds the new password, so the
 * server cannot look and see whether there was one before. Our own
 * password_hash is no better: a web email signup has a real password at
 * Supabase and a NULL hash here. The CMS knows (it rendered "Set password" or
 * "Update password"), so it sends `event`.
 *
 * ── WHY ONLY WITH A VERIFIED SESSION ────────────────────────────────────────
 * The route takes an email address in the body and has never required a token.
 * Queuing on that alone would let anyone send "your password was changed" to
 * any customer. So the email goes only when the request carries a Supabase
 * session for THAT address. The hash write itself is unchanged, so an older CMS
 * that sends no token keeps working — it just sends no email.
 */
import crypto from 'crypto';
import type { SqlLike } from './billing/payment-methods.js';
import { enqueueEmail } from './billing/email-outbox.js';
import { firstNameOf } from './billing/notification-jobs.js';

export const PASSWORD_EVENTS = ['set', 'changed', 'reset'] as const;
export type PasswordEvent = typeof PASSWORD_EVENTS[number];

/** Set → its own notice; a change and a reset both say "changed". */
export const passwordTemplateFor = (event: PasswordEvent): string =>
  event === 'set' ? 'security.password_set' : 'security.password_changed';

/** How the change was made, in the words the email uses. */
export const passwordMethodFor = (event: PasswordEvent): string =>
  event === 'reset' ? 'a password reset link' : 'your account Settings';

/** "September 23, 2026 at 14:05 UTC" — UTC, because the server has no per-user timezone. */
export const formatChangedAt = (d: Date): string => {
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${date} at ${time} UTC`;
};

const cmsBase = (): string =>
  (process.env.FRONTEND_URL || process.env.CMS_BASE_URL || 'https://account.improveseoplugin.com').replace(/\/$/, '');

/** Resolves a Supabase access token to its email, or null. Injectable for tests. */
export type TokenResolver = (jwt: string) => Promise<string | null>;

const supabaseTokenResolver: TokenResolver = async (jwt) => {
  // Imported lazily: supabase.service builds its client at import time and
  // throws without SUPABASE_URL, which would take every test importing this
  // module down with it.
  const { supabaseAdmin } = await import('./supabase.service.js');
  const result = await Promise.race([
    supabaseAdmin.auth.getUser(jwt),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('jwt_timeout')), 8000)),
  ]);
  if (result.error || !result.data.user?.email) return null;
  return result.data.user.email;
};

/** The email the request's Bearer token belongs to, or null when there is no valid one. */
export async function verifiedSessionEmail(
  authorizationHeader: string | undefined,
  resolve: TokenResolver = supabaseTokenResolver,
): Promise<string | null> {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) return null;
  try {
    return await resolve(authorizationHeader.slice(7));
  } catch {
    return null;
  }
}

export const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Queue the confirmation. Transactional: a marketing opt-out must not silence a
 * security notice (a hard bounce still does — see suppressionReason).
 *
 * Keyed on a fresh id: every call is a separate change of password, and there is
 * no provider event id to key on. The CMS makes the call once per change.
 *
 * Never throws — the password has already changed by the time this runs.
 */
export async function queuePasswordConfirmation(
  sql: SqlLike,
  input: { user: { id: number; email: string; name?: string | null }; event: PasswordEvent; now?: Date },
): Promise<{ enqueued: boolean }> {
  const { user, event } = input;
  const now = input.now ?? new Date();
  const base = cmsBase();
  const { enqueued } = await enqueueEmail(sql, {
    userId: user.id,
    recipient: user.email,
    template: passwordTemplateFor(event),
    category: 'transactional',
    eventKey: `password_${event}:${user.id}:${crypto.randomUUID()}`,
    payload: {
      firstName: firstNameOf(user.name, user.email),
      event,
      changedAt: formatChangedAt(now),
      method: passwordMethodFor(event),
      resetUrl: `${base}/forgot-password`,
      settingsUrl: `${base}/settings`,
    },
  });
  return { enqueued };
}

/**
 * The route's whole decision: send only for a named event, and only when the
 * request's session belongs to the account whose password was written.
 *
 * Returns what happened, so the route can report it and QA can see it.
 */
export async function confirmPasswordChange(
  sql: SqlLike,
  input: {
    user: { id: number; email: string; name?: string | null };
    event?: PasswordEvent;
    authorization?: string;
    resolve?: TokenResolver;
    now?: Date;
  },
): Promise<'queued' | 'skipped'> {
  const { user, event } = input;
  if (!event) return 'skipped';

  const sessionEmail = await verifiedSessionEmail(input.authorization, input.resolve);
  if (!sameEmail(sessionEmail, user.email)) {
    console.warn(`[security-emails] password ${event} confirmation not sent for user ${user.id}: no verified session for that account`);
    return 'skipped';
  }

  const { enqueued } = await queuePasswordConfirmation(sql, { user, event, now: input.now });
  return enqueued ? 'queued' : 'skipped';
}
