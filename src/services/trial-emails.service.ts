/**
 * Trial email sequence (drip).
 *
 *   Welcome        — as soon after signup as the scheduler runs
 *   Check-in       — ~3 days after the trial started
 *   Trial-ending   — within the last ~day of the 7-day trial
 *
 * Design: scheduler-driven and keyed off the `users` table, so it catches EVERY
 * signup path (plugin, web, OAuth) uniformly — the server doesn't run code for
 * web/OAuth signups (the DB trigger creates them).
 *
 * Safety: each batch CLAIMS rows atomically (UPDATE … SET *_sent_at = NOW()
 * WHERE *_sent_at IS NULL … RETURNING) BEFORE sending. That guarantees
 * at-most-once even with concurrent schedulers/instances — a rare send failure
 * means a missed drip email (logged), never a duplicate.
 *
 * Gated by TRIAL_EMAILS_ENABLED=true. Sender identity is configurable so these
 * come from a real, reply-monitored inbox (they invite replies).
 */
import sql from '../data/db.js';
import { sendEmail, emailTemplates } from './email.service.js';

const BATCH_LIMIT = 100;

const cfg = () => {
  const frontend = (process.env.FRONTEND_URL || 'https://account.improveseoplugin.com').replace(/\/$/, '');
  return {
    enabled: String(process.env.TRIAL_EMAILS_ENABLED || '').toLowerCase() === 'true',
    from: process.env.TRIAL_EMAIL_FROM
      || `${process.env.TRIAL_EMAIL_FROM_NAME || 'Nathan from ImproveSEO'} <${process.env.TRIAL_EMAIL_FROM_EMAIL || process.env.MAILGUN_FROM_EMAIL || 'nathan@improveseoplugin.com'}>`,
    replyTo: process.env.TRIAL_EMAIL_REPLY_TO || process.env.TRIAL_EMAIL_FROM_EMAIL || undefined,
    createUrl: `${frontend}/overview`,
    upgradeUrl: `${frontend}/credits`,
  };
};

const firstNameOf = (name?: string | null): string => {
  const n = (name || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
};

type DueRow = { id: number; email: string; name: string | null; trial_ends_at?: string | null };

const fmtDate = (d?: string | null): string =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'in 7 days';

// Send from the CEO (custom from + reply-to) — the relationship emails.
async function send(row: DueRow, tpl: { subject: string; html: string; text: string }, c: ReturnType<typeof cfg>): Promise<boolean> {
  return sendEmail({ to: row.email, subject: tpl.subject, html: tpl.html, text: tpl.text, from: c.from, replyTo: c.replyTo });
}

// Send from the default system sender — the transactional confirmation.
async function sendSystem(row: DueRow, tpl: { subject: string; html: string; text: string }): Promise<boolean> {
  return sendEmail({ to: row.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
}

/** Run one pass of all three drip emails. Returns per-type counts sent. */
export async function processTrialEmails(): Promise<{ welcome: number; checkin: number; trialEnding: number }> {
  const c = cfg();
  const counts = { welcome: 0, checkin: 0, trialEnding: 0 };
  if (!c.enabled) return counts;

  // ── Account confirmation + Welcome — both sent at account creation ─────────
  // Per spec, a new signup gets the transactional confirmation (system sender)
  // AND the human Welcome (from the CEO). One claim gates both.
  const welcomeRows = await sql<DueRow[]>`
    WITH due AS (SELECT id FROM users WHERE welcome_email_sent_at IS NULL ORDER BY id LIMIT ${BATCH_LIMIT})
    UPDATE users u SET welcome_email_sent_at = NOW()
    FROM due WHERE u.id = due.id
    RETURNING u.id, u.email, u.name, u.trial_ends_at
  `;
  for (const row of welcomeRows) {
    const first = firstNameOf(row.name);
    const confOk = await sendSystem(row, emailTemplates.accountConfirmation(first, c.createUrl, fmtDate(row.trial_ends_at)));
    const welcomeOk = await send(row, emailTemplates.trialWelcome(first, c.createUrl), c);
    if (confOk && welcomeOk) { counts.welcome++; }
    else { // un-claim so the pair retries next pass instead of being silently dropped
      await sql`UPDATE users SET welcome_email_sent_at = NULL WHERE id = ${row.id}`;
      console.warn(`[trial-emails] signup emails failed for user ${row.id} (conf:${confOk} welcome:${welcomeOk}) — will retry`);
    }
  }

  // ── Check-in — free-plan trial users ~3 days in, trial still active ────────
  const checkinRows = await sql<DueRow[]>`
    WITH due AS (
      SELECT u.id FROM users u
      JOIN subscription_plans p ON p.id = u.plan_id
      WHERE u.checkin_email_sent_at IS NULL
        AND p.price_cents = 0
        AND u.trial_started_at IS NOT NULL
        AND u.trial_started_at <= NOW() - INTERVAL '3 days'
        AND u.trial_ends_at > NOW()
      ORDER BY u.id LIMIT ${BATCH_LIMIT}
    )
    UPDATE users u SET checkin_email_sent_at = NOW()
    FROM due WHERE u.id = due.id
    RETURNING u.id, u.email, u.name
  `;
  for (const row of checkinRows) {
    const ok = await send(row, emailTemplates.trialCheckin(firstNameOf(row.name)), c);
    if (ok) { counts.checkin++; }
    else {
      await sql`UPDATE users SET checkin_email_sent_at = NULL WHERE id = ${row.id}`;
      console.warn(`[trial-emails] checkin send failed for user ${row.id} (will retry)`);
    }
  }

  // ── Trial-ending — free-plan users with the trial ending within ~28 h ─────
  const endingRows = await sql<DueRow[]>`
    WITH due AS (
      SELECT u.id FROM users u
      JOIN subscription_plans p ON p.id = u.plan_id
      WHERE u.trial_end_email_sent_at IS NULL
        AND p.price_cents = 0
        AND u.trial_ends_at IS NOT NULL
        AND u.trial_ends_at > NOW()
        AND u.trial_ends_at <= NOW() + INTERVAL '28 hours'
      ORDER BY u.id LIMIT ${BATCH_LIMIT}
    )
    UPDATE users u SET trial_end_email_sent_at = NOW()
    FROM due WHERE u.id = due.id
    RETURNING u.id, u.email, u.name
  `;
  for (const row of endingRows) {
    const ok = await send(row, emailTemplates.trialEnding(firstNameOf(row.name), c.upgradeUrl), c);
    if (ok) { counts.trialEnding++; }
    else {
      // Only un-claim if there's still time to resend before the trial ends.
      await sql`UPDATE users SET trial_end_email_sent_at = NULL WHERE id = ${row.id} AND trial_ends_at > NOW()`;
      console.warn(`[trial-emails] trial-ending send failed for user ${row.id} (will retry if time remains)`);
    }
  }

  return counts;
}

let timer: NodeJS.Timeout | null = null;

/** Start the drip scheduler (every 15 min) if TRIAL_EMAILS_ENABLED=true. */
export function startTrialEmailScheduler(): void {
  if (!cfg().enabled) {
    console.log('📭 Trial email sequence disabled (set TRIAL_EMAILS_ENABLED=true to enable).');
    return;
  }
  const INTERVAL_MS = 15 * 60 * 1000;
  const run = () => {
    processTrialEmails()
      .then((c) => {
        if (c.welcome || c.checkin || c.trialEnding) {
          console.log(`📧 Trial emails sent — welcome:${c.welcome} checkin:${c.checkin} ending:${c.trialEnding}`);
        }
      })
      .catch((e) => console.error('[trial-emails] batch error:', e));
  };
  // First pass shortly after boot, then on an interval.
  timer = setInterval(run, INTERVAL_MS);
  setTimeout(run, 30_000).unref();
  if (timer.unref) timer.unref();
  console.log('📬 Trial email scheduler started (every 15 min).');
}
