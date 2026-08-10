/**
 * The outbox worker.  (BILL-006)
 *
 * Claims due jobs, renders them, sends them, and records the outcome. Runs
 * in-process on a timer rather than as a separate service: this application
 * already runs schedulers this way (trial and lifecycle emails), and adding a
 * second deployment unit for a few emails a day would be worse operationally
 * than the thing it replaces.
 *
 * Concurrency safety comes from FOR UPDATE SKIP LOCKED in claimDueEmails, so
 * running several instances is safe — each claims a disjoint set.
 *
 * ── WHY THE PAYLOAD IS RENDERED, NOT REBUILT ────────────────────────────────
 * BILL-006: "All amounts, dates, and plan names come from the actual billing
 * event record — never reconstructed or approximated in the template layer."
 * The payload was captured at enqueue time from the billing event, and the
 * renderers below read only from it. Nothing here queries current state, so a
 * receipt cannot drift from what was actually charged — even if the worker runs
 * hours later after a provider outage, and even if the customer has since
 * changed plan again.
 */
import type { SqlLike } from './payment-methods.js';
import {
  claimDueEmails, markSent, markFailed, markSuppressed, suppressionReason,
  type EmailJob,
} from './email-outbox.js';
import { sendEmail, billingEmailTemplates } from '../email.service.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Template registry: job template name → renderer.
 *
 * Adding an email means adding an entry here and a template in
 * email.service.ts. A job whose template is not registered is dead-lettered
 * rather than retried forever — a missing renderer is a deploy problem, and no
 * amount of waiting fixes it.
 */
export const RENDERERS: Record<string, (payload: any) => RenderedEmail> = {
  'billing.upgrade': (p) => billingEmailTemplates.billingPlanChanged(p),
  'billing.cancellation': (p) => billingEmailTemplates.billingCancelled(p),
  'lifecycle.credit_expiry': (p) => billingEmailTemplates.creditsExpiringPlaceholder(p),
  'lifecycle.inactivity': (p) => billingEmailTemplates.inactivityPlaceholder(p),
};

/**
 * Process one batch. Returns counts so a scheduler can log them.
 *
 * Every job is independent: one bad recipient must not stop the batch, so each
 * is wrapped individually.
 */
export async function processEmailBatch(
  sql: SqlLike,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<{ sent: number; failed: number; suppressed: number; deadLettered: number }> {
  const counts = { sent: 0, failed: 0, suppressed: 0, deadLettered: 0 };

  const jobs = await claimDueEmails(sql, options.limit ?? 25);
  if (jobs.length === 0) return counts;

  for (const job of jobs) {
    try {
      const outcome = await processOne(sql, job, options.dryRun === true);
      counts[outcome] += 1;
      if (outcome === 'deadLettered') counts.failed += 0; // counted separately
    } catch (err) {
      // A renderer that throws must not take the batch down.
      const message = err instanceof Error ? err.message : String(err);
      const { deadLettered } = await markFailed(sql, job, message);
      if (deadLettered) counts.deadLettered++; else counts.failed++;
    }
  }

  return counts;
}

async function processOne(
  sql: SqlLike,
  job: EmailJob,
  dryRun: boolean,
): Promise<'sent' | 'failed' | 'suppressed' | 'deadLettered'> {
  // Suppression is checked at SEND time, not enqueue time: a user can
  // unsubscribe or hard-bounce between the two, and the later answer is the
  // one that matters.
  if (job.user_id) {
    const rows = await sql`
      SELECT email_hard_bounced_at, marketing_opt_out_at, is_internal
      FROM   users
      WHERE  id = ${job.user_id}
      LIMIT  1
    `;
    const reason = suppressionReason(rows[0] as any, job.category);
    if (reason) {
      await markSuppressed(sql, job.id, reason);
      console.log(`[email-worker] suppressed ${job.template}/${job.event_key}: ${reason}`);
      return 'suppressed';
    }
  }

  const render = RENDERERS[job.template];
  if (!render) {
    // Not retryable: waiting will not conjure a renderer.
    await markFailed(sql, { ...job, attempts: 99 }, `no renderer registered for template "${job.template}"`);
    return 'deadLettered';
  }

  const rendered = render(job.payload);

  if (dryRun) {
    console.log(
      `[email-worker] DRY RUN — would send "${rendered.subject}" to ${job.recipient} ` +
      `(${job.template}/${job.event_key})`,
    );
    return 'sent';
  }

  // Transactional headers. List-Unsubscribe on lifecycle mail only: putting it
  // on a receipt invites a customer to "unsubscribe" from being told what they
  // were charged, which we cannot honour anyway.
  const unsubscribeUrl = job.category === 'lifecycle'
    ? await unsubscribeUrlFor(sql, job.user_id)
    : null;

  const ok = await sendEmail({
    to: job.recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(unsubscribeUrl ? { listUnsubscribe: unsubscribeUrl } : {}),
  } as any);

  if (ok) {
    await markSent(sql, job.id);
    // BILL-006: "Log every send attempt with event id, template, recipient, and
    // result, so we can answer 'did this user get their receipt?'"
    console.log(
      `[email-worker] sent template=${job.template} event=${job.event_key} ` +
      `user=${job.user_id} recipient=${job.recipient} result=ok`,
    );
    return 'sent';
  }

  const { deadLettered } = await markFailed(sql, job, 'provider rejected or was unreachable');
  return deadLettered ? 'deadLettered' : 'failed';
}

/** The per-user unsubscribe link, from the token minted by migration 007. */
async function unsubscribeUrlFor(sql: SqlLike, userId: number | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = await sql`SELECT unsubscribe_token FROM users WHERE id = ${userId} LIMIT 1`;
    const token = rows[0]?.unsubscribe_token;
    if (!token) return null;
    const base = (process.env.CMS_BASE_URL || 'https://account.improveseoplugin.com').replace(/\/$/, '');
    return `${base}/unsubscribe?token=${token}`;
  } catch (_) {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the worker.
 *
 * Gated on BILLING_EMAILS_ENABLED, which already gated the inline sends this
 * replaces — so merging changes no behaviour until it is deliberately switched
 * on. Jobs still QUEUE while it is off, which is deliberate: turning it on then
 * delivers the backlog rather than starting from empty, and the queue is
 * itself the evidence of what would have been sent.
 */
export function startEmailWorker(sql: SqlLike): void {
  if (String(process.env.BILLING_EMAILS_ENABLED || '').toLowerCase() !== 'true') {
    console.log('📭 Email worker disabled (set BILLING_EMAILS_ENABLED=true to enable). Jobs will queue.');
    return;
  }
  if (timer) return;

  const intervalMs = Number(process.env.EMAIL_WORKER_INTERVAL_MS || 60_000);
  const run = () => {
    processEmailBatch(sql)
      .then((c) => {
        if (c.sent || c.failed || c.suppressed || c.deadLettered) {
          console.log(
            `[email-worker] batch — sent:${c.sent} failed:${c.failed} ` +
            `suppressed:${c.suppressed} dead:${c.deadLettered}`,
          );
        }
      })
      .catch((e) => console.error('[email-worker] batch error:', e));
  };

  timer = setInterval(run, intervalMs);
  setTimeout(run, 15_000).unref();
  if (timer.unref) timer.unref();
  console.log(`📬 Email worker started (every ${Math.round(intervalMs / 1000)}s).`);
}
