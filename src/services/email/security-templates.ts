/**
 * Account-security notices: a password was SET, or a password was CHANGED.
 *
 * ── INTERIM COPY — final wording to follow ──────────────────────────────────
 * The task was to set up the mechanism; the client is supplying the copy. What
 * is here is deliberately plain so it is safe to send in the meantime: what
 * happened, when, how, and what to do if it was not them. Replace the strings;
 * keep the payload fields, which the route fills.
 *
 * Transactional, never lifecycle: a security notice must reach someone who has
 * unsubscribed from marketing mail. No unsubscribe link, for the same reason.
 */
import { emailShell, p, small, callout, textBody, escapeHtml } from './layout.js';

export interface RenderedEmail { subject: string; html: string; text: string }

export interface PasswordNoticePayload {
  firstName: string;
  /** Already formatted, e.g. "September 23, 2026 at 14:05 UTC". */
  changedAt: string;
  /** How it was done, in words: "your account Settings" or "a password reset link". */
  method: string;
  /** Where to reset it if this was not them. */
  resetUrl: string;
  /** Where the account's security settings live. */
  settingsUrl: string;
}

const NOT_ME = callout(
  `<strong>Wasn't you?</strong> Reset your password now and reply to this email so we can secure your account.`,
  'warning',
);

/** Scenario 2 — an account that had no password (Google sign-up) set one. */
export const passwordSet = (pl: PasswordNoticePayload): RenderedEmail => {
  const html = emailShell({
    heading: 'Your password is set',
    preheader: `A password was added to your ImproveSEO account on ${pl.changedAt}.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`A password was set for your ImproveSEO account on <strong>${escapeHtml(pl.changedAt)}</strong> via ${escapeHtml(pl.method)}.`) +
      p(`You can now sign in with your email address and this password. Google sign-in keeps working as before.`) +
      NOT_ME +
      small(`Manage your sign-in options in <a href="${escapeHtml(pl.settingsUrl)}">Settings</a>.`),
    cta: { label: 'Reset my password', url: pl.resetUrl },
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `A password was set for your ImproveSEO account on ${pl.changedAt} via ${pl.method}.`,
    `You can now sign in with your email address and this password. Google sign-in keeps working as before.`,
    '',
    `Wasn't you? Reset your password now and reply to this email so we can secure your account:`,
    pl.resetUrl,
    '',
    `Manage your sign-in options: ${pl.settingsUrl}`,
  ]);

  return { subject: 'Your ImproveSEO password is set', html, text };
};

/** Scenarios 1 and 3, and a forgot-password reset: an existing password changed. */
export const passwordChanged = (pl: PasswordNoticePayload): RenderedEmail => {
  const html = emailShell({
    heading: 'Your password was changed',
    preheader: `The password on your ImproveSEO account was changed on ${pl.changedAt}.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`The password for your ImproveSEO account was changed on <strong>${escapeHtml(pl.changedAt)}</strong> via ${escapeHtml(pl.method)}.`) +
      p(`If you made this change, there's nothing else to do.`) +
      NOT_ME +
      small(`Manage your sign-in options in <a href="${escapeHtml(pl.settingsUrl)}">Settings</a>.`),
    cta: { label: 'Reset my password', url: pl.resetUrl },
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `The password for your ImproveSEO account was changed on ${pl.changedAt} via ${pl.method}.`,
    `If you made this change, there's nothing else to do.`,
    '',
    `Wasn't you? Reset your password now and reply to this email so we can secure your account:`,
    pl.resetUrl,
    '',
    `Manage your sign-in options: ${pl.settingsUrl}`,
  ]);

  return { subject: 'Your ImproveSEO password was changed', html, text };
};

export const securityEmailTemplates = { passwordSet, passwordChanged };
