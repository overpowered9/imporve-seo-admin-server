/**
 * Lifecycle notification emails (credits.md round 2, bugs 16 & 17).
 *
 *   Credit expiry — N days before the plan credits reset, if any remain
 *   Inactivity    — no generations for >14 days, if any credits remain
 *
 * Deliberately modelled on trial-emails.service.ts: batched, scheduler-driven,
 * env-gated, and CLAIM-BEFORE-SEND so concurrent schedulers or a restarted
 * instance can never double-send. The difference is where the claim lives —
 * see the note on dedupe keys below.
 *
 * ⚠️ The email COPY is placeholder (the client marked it "coming soon"). The
 * triggers, selection rules, dynamic data and dedupe guards are complete. Final
 * wording drops into the two templates in email.service.ts without touching
 * anything here.
 *
 * Gated by LIFECYCLE_EMAILS_ENABLED=true, so merging this changes no behaviour
 * until it is deliberately switched on.
 */
import sql from '../data/db.js';
import { sendEmail, emailTemplates } from './email.service.js';

const BATCH_LIMIT = 100;

/** Notification kinds — also the `kind` column value in user_notifications. */
const KIND_CREDIT_EXPIRY = 'credit_expiry';
const KIND_INACTIVITY = 'inactivity';

const cfg = () => {
  const frontend = (process.env.FRONTEND_URL || 'https://account.improveseoplugin.com').replace(/\/$/, '');
  return {
    enabled: String(process.env.LIFECYCLE_EMAILS_ENABLED || '').toLowerCase() === 'true',
    /** How many days before the reset the expiry warning goes out. */
    expiryWarningDays: Number(process.env.CREDIT_EXPIRY_WARNING_DAYS || 3),
    /** Assumed cycle length; only used when a cycle end can't be read from the subscription. */
    cycleLengthDays: Number(process.env.CREDIT_CYCLE_DAYS || 30),
    /** Inactivity threshold. The client asked for >2 weeks. */
    inactivityDays: Number(process.env.INACTIVITY_EMAIL_DAYS || 14),
    /** Don't nag: minimum gap between successive inactivity emails. */
    inactivityCooldownDays: Number(process.env.INACTIVITY_COOLDOWN_DAYS || 30),
    dashboardUrl: `${frontend}/overview`,
  };
};

const firstNameOf = (name?: string | null, email?: string | null): string =>
  (name || '').trim().split(/\s+/)[0] || (email || '').split('@')[0] || 'there';

const fmtDate = (d?: string | Date | null): string =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'soon';

/**
 * How many complete articles-with-image a balance buys.
 *
 * MUST stay in step with the CMS's contentPiecesFromCredits() (see
 * user-cms/src/utils/creditRates.js): one piece costs one content credit plus
 * one image credit, so the answer is limited by whichever pool runs out first —
 * NOT the combined total. An email promising more pieces than the dashboard
 * shows is worse than sending no email at all.
 */
const piecesFrom = (content: number, images: number): number =>
  Math.max(0, Math.min(Math.floor(content || 0), Math.floor(images || 0)));

type CreditTotals = { content: number; images: number; keywords: number; total: number };

const emptyTotals = (): CreditTotals => ({ content: 0, images: 0, keywords: 0, total: 0 });

/**
 * Atomically claim the right to send one notification.
 *
 * Returns true only for the caller that actually inserted the row. The UNIQUE
 * (user_id, kind, dedupe_key) constraint means a concurrent scheduler — or the
 * same job re-running after a crash — gets false and skips, which is what makes
 * this at-most-once rather than at-least-once.
 *
 * Claiming BEFORE sending means a send failure costs a missed email (logged),
 * never a duplicate. That is the same trade-off the trial drip makes, and it is
 * the right way round for anything that lands in a customer's inbox.
 */
async function claim(userId: number, kind: string, dedupeKey: string): Promise<boolean> {
  try {
    const rows = await sql`
      INSERT INTO user_notifications (user_id, kind, dedupe_key)
      VALUES (${userId}, ${kind}, ${dedupeKey})
      ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING
      RETURNING id
    `;
    return (rows as any[]).length > 0;
  } catch (err: any) {
    // The table is created by migration 002. If it hasn't been run yet, say so
    // once and decline to send rather than sending unguarded (which would spam
    // every user on every scheduler pass).
    if (err?.code === '42P01') {
      console.warn('[lifecycle-emails] user_notifications table missing — run `npm run migrate:notifications`. Skipping.');
      return false;
    }
    throw err;
  }
}

/** Release a claim so the next pass can retry a failed send. */
async function unclaim(userId: number, kind: string, dedupeKey: string): Promise<void> {
  try {
    await sql`
      DELETE FROM user_notifications
      WHERE user_id = ${userId} AND kind = ${kind} AND dedupe_key = ${dedupeKey}
    `;
  } catch (_) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 16 — credits approaching their cycle reset
// ─────────────────────────────────────────────────────────────────────────────
export async function processCreditExpiryEmails(): Promise<number> {
  const c = cfg();
  let sent = 0;

  // Candidates: users whose PLAN credits reset within the warning window and
  // who still have something to lose. Users with zero remaining plan credits
  // get nothing — there is no loss to warn about, and a "your 0 credits are
  // expiring" email is noise.
  //
  // The reset date is the subscription's next_billing_date when there is one;
  // otherwise cycle_started_at + the configured cycle length, which is how the
  // free/trial tier rolls.
  const rows = await sql`
    SELECT u.id, u.email, u.name,
           COALESCE(SUM(cb.included_remaining) FILTER (WHERE cb.credit_type = 'content'),  0)::int AS content,
           COALESCE(SUM(cb.included_remaining) FILTER (WHERE cb.credit_type = 'images'),   0)::int AS images,
           COALESCE(SUM(cb.included_remaining) FILTER (WHERE cb.credit_type = 'keywords'), 0)::int AS keywords,
           COALESCE(SUM(cb.included_remaining), 0)::int AS total,
           MAX(cb.cycle_started_at) AS cycle_started_at,
           COALESCE(
             MAX(s.next_billing_date)::timestamptz,
             MAX(cb.cycle_started_at) + (${c.cycleLengthDays} || ' days')::interval
           ) AS reset_at
    FROM   users u
    JOIN   credit_balances cb ON cb.user_id = u.id
    LEFT   JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
    WHERE  u.email IS NOT NULL
    GROUP  BY u.id, u.email, u.name
    HAVING COALESCE(SUM(cb.included_remaining), 0) > 0
       AND COALESCE(
             MAX(s.next_billing_date)::timestamptz,
             MAX(cb.cycle_started_at) + (${c.cycleLengthDays} || ' days')::interval
           ) BETWEEN NOW() AND NOW() + (${c.expiryWarningDays} || ' days')::interval
    LIMIT  ${BATCH_LIMIT}
  `;

  for (const row of rows as any[]) {
    // Dedupe on the CYCLE, so this fires again next month but not twice this
    // month. Falls back to the reset date if cycle_started_at is somehow null.
    const dedupeKey = `cycle:${new Date(row.cycle_started_at || row.reset_at).toISOString().slice(0, 10)}`;
    if (!(await claim(row.id, KIND_CREDIT_EXPIRY, dedupeKey))) continue;

    const credits: CreditTotals = {
      content: Number(row.content) || 0,
      images: Number(row.images) || 0,
      keywords: Number(row.keywords) || 0,
      total: Number(row.total) || 0,
    };
    const daysUntil = Math.max(
      1,
      Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 86_400_000)
    );

    const tpl = emailTemplates.creditsExpiringSoon(
      firstNameOf(row.name, row.email),
      daysUntil,
      credits,
      piecesFrom(credits.content, credits.images),
      fmtDate(row.reset_at),
      c.dashboardUrl,
    );

    const ok = await sendEmail({ to: row.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    if (ok) sent++;
    else {
      await unclaim(row.id, KIND_CREDIT_EXPIRY, dedupeKey);
      console.warn(`[lifecycle-emails] credit-expiry send failed for user ${row.id} — will retry`);
    }
  }

  return sent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 17 — inactive >14 days, with their credit availability included
// ─────────────────────────────────────────────────────────────────────────────
export async function processInactivityEmails(): Promise<number> {
  const c = cfg();
  let sent = 0;

  // "Activity" is the last generation. A user who has NEVER generated is
  // excluded on purpose — they are the trial drip's audience, and hitting a
  // brand-new signup with a "you've been away" email reads as a broken system.
  //
  // The cooldown is enforced in SQL rather than by the dedupe key alone,
  // because a user who lapses, returns, and lapses again SHOULD hear from us
  // again — just not every fortnight forever.
  const rows = await sql`
    WITH last_activity AS (
      SELECT user_id, MAX(created_at) AS last_generation_at
      FROM   user_generations
      GROUP  BY user_id
    )
    SELECT u.id, u.email, u.name,
           la.last_generation_at,
           COALESCE(SUM(cb.amount) FILTER (WHERE cb.credit_type = 'content'),  0)::int AS content,
           COALESCE(SUM(cb.amount) FILTER (WHERE cb.credit_type = 'images'),   0)::int AS images,
           COALESCE(SUM(cb.amount) FILTER (WHERE cb.credit_type = 'keywords'), 0)::int AS keywords,
           COALESCE(SUM(cb.amount), 0)::int AS total
    FROM   users u
    JOIN   last_activity la ON la.user_id = u.id
    JOIN   credit_balances cb ON cb.user_id = u.id
    WHERE  u.email IS NOT NULL
      AND  la.last_generation_at < NOW() - (${c.inactivityDays} || ' days')::interval
      AND  NOT EXISTS (
             SELECT 1 FROM user_notifications n
             WHERE  n.user_id = u.id
               AND  n.kind = ${KIND_INACTIVITY}
               AND  n.sent_at > NOW() - (${c.inactivityCooldownDays} || ' days')::interval
           )
    GROUP  BY u.id, u.email, u.name, la.last_generation_at
    HAVING COALESCE(SUM(cb.amount), 0) > 0
    LIMIT  ${BATCH_LIMIT}
  `;

  for (const row of rows as any[]) {
    const daysInactive = Math.floor(
      (Date.now() - new Date(row.last_generation_at).getTime()) / 86_400_000
    );
    // Dedupe on the inactivity WINDOW (the last-activity date), so the same
    // lapse can't produce two emails even if the cooldown query races.
    const dedupeKey = `since:${new Date(row.last_generation_at).toISOString().slice(0, 10)}`;
    if (!(await claim(row.id, KIND_INACTIVITY, dedupeKey))) continue;

    const credits: CreditTotals = {
      content: Number(row.content) || 0,
      images: Number(row.images) || 0,
      keywords: Number(row.keywords) || 0,
      total: Number(row.total) || 0,
    };

    const tpl = emailTemplates.inactivityWithCredits(
      firstNameOf(row.name, row.email),
      daysInactive,
      credits,
      piecesFrom(credits.content, credits.images),
      c.dashboardUrl,
    );

    const ok = await sendEmail({ to: row.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    if (ok) sent++;
    else {
      await unclaim(row.id, KIND_INACTIVITY, dedupeKey);
      console.warn(`[lifecycle-emails] inactivity send failed for user ${row.id} — will retry`);
    }
  }

  return sent;
}

/** Run one pass of both jobs. Exported so it can be triggered manually/tested. */
export async function processLifecycleEmails(): Promise<{ expiry: number; inactivity: number }> {
  if (!cfg().enabled) return { expiry: 0, inactivity: 0 };
  const expiry = await processCreditExpiryEmails();
  const inactivity = await processInactivityEmails();
  return { expiry, inactivity };
}

let timer: NodeJS.Timeout | null = null;

export function startLifecycleEmailScheduler(): void {
  if (!cfg().enabled) {
    console.log('📭 Lifecycle emails disabled (set LIFECYCLE_EMAILS_ENABLED=true to enable).');
    return;
  }
  if (timer) return; // already running

  // Hourly. Both triggers are day-granular, so anything more frequent is just
  // load; anything less risks missing a narrow expiry window.
  const INTERVAL_MS = 60 * 60 * 1000;
  const run = () => {
    processLifecycleEmails()
      .then((c) => {
        if (c.expiry || c.inactivity) {
          console.log(`📧 Lifecycle emails sent — expiry:${c.expiry} inactivity:${c.inactivity}`);
        }
      })
      .catch((e) => console.error('[lifecycle-emails] batch error:', e));
  };

  timer = setInterval(run, INTERVAL_MS);
  // Delay the first pass past boot so a cold start isn't competing with it.
  setTimeout(run, 60_000).unref();
  if (timer.unref) timer.unref();
  console.log('📬 Lifecycle email scheduler started (hourly).');
}
