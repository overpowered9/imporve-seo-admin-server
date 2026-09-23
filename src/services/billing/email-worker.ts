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
  claimDueEmails, markSent, markFailed, markSuppressed, suppressionReason, releaseClaim,
  type EmailJob,
} from './email-outbox.js';
import { sendEmail, billingEmailTemplates } from '../email.service.js';
import { securityEmailTemplates } from '../email/security-templates.js';

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
  // Subscription lifecycle
  'billing.upgrade': (p) => billingEmailTemplates.billingPlanChanged(p),
  'billing.downgrade': (p) => billingEmailTemplates.billingDowngraded(p),
  'billing.cancellation': (p) => billingEmailTemplates.billingCancelled(p),
  'billing.paused': (p) => billingEmailTemplates.billingPaused(p),
  'billing.resumed': (p) => billingEmailTemplates.billingResumed(p),
  // Money in, money out
  'billing.credit_purchase': (p) => billingEmailTemplates.creditPurchase(p),
  'billing.renewal': (p) => billingEmailTemplates.renewalReceipt(p),
  'billing.refund': (p) => billingEmailTemplates.refundIssued(p),
  'billing.payment_failed': (p) => billingEmailTemplates.paymentFailed(p),
  // Lifecycle — suppressible by a marketing opt-out
  'lifecycle.credit_expiry': (p) => billingEmailTemplates.creditsExpiring(p),
  'lifecycle.inactivity': (p) => billingEmailTemplates.inactivityNudge(p),
  'lifecycle.trial_ended': (p) => billingEmailTemplates.trialEnded(p),
  // Account security — transactional; queued by POST /auth/set-password
  'security.password_set': (p) => securityEmailTemplates.passwordSet(p),
  'security.password_changed': (p) => securityEmailTemplates.passwordChanged(p),
};

/**
 * Strings that prove a template rendered against a payload it did not get.
 *
 * A customer received a receipt headed "Welcome to undefined" that said
 * "Charged today: undefined". Nothing in the pipeline objected, because every
 * stage did its job: the payload was captured correctly, the row was queued
 * correctly, the renderer substituted exactly what it was handed, and Mailgun
 * delivered it. The gap is that NOTHING EVER LOOKED AT THE OUTPUT.
 *
 * So this looks. These four tokens cannot occur in legitimate billing copy —
 * plan names, money and dates are all formatted by helpers that return real
 * strings — which makes their presence proof of a broken payload rather than a
 * style problem.
 *
 * `${` catches a template literal that was stored as source text instead of
 * being evaluated; `[object Object]` catches an object interpolated where a
 * string belonged.
 */
const UNRENDERED_TOKENS: Array<[RegExp, string]> = [
  [/\bundefined\b/, 'undefined'],
  [/\bnull\b/, 'null'],
  [/\bNaN\b/, 'NaN'],
  [/\[object Object\]/, '[object Object]'],
  [/\$\{/, 'an unevaluated ${...} template literal'],
];

/**
 * Which placeholder tokens leaked into a rendered email, if any.
 *
 * Checks the subject and the plain-text body. The HTML is deliberately NOT
 * checked: it carries CSS and URLs where these substrings can appear
 * legitimately, and the text part is generated from the same payload, so a
 * broken payload shows up there too. Scanning both would trade a guarantee for
 * false positives that block real receipts.
 */
export function unrenderedTokensIn(rendered: RenderedEmail): string[] {
  const haystack = `${rendered.subject}\n${rendered.text}`;
  return UNRENDERED_TOKENS.filter(([re]) => re.test(haystack)).map(([, name]) => name);
}

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

  // Resolved BEFORE rendering, because lifecycle templates put the link in the
  // footer as well as the header. A List-Unsubscribe header with no visible
  // link in the body is what gets mail marked as spam by recipients who cannot
  // find the off switch — and the footer link is the one most people use.
  //
  // Receipts get neither: `unsubscribeUrlFor` is only consulted for lifecycle
  // mail, so a transactional template renders the billing footer instead.
  const unsubscribeUrl = job.category === 'lifecycle'
    ? await unsubscribeUrlFor(sql, job.user_id)
    : null;

  const rendered = render(
    unsubscribeUrl ? { ...job.payload, unsubscribeUrl } : job.payload,
  );

  // The last gate before a customer sees it. Dead-lettered rather than retried:
  // the payload is already stored, so every retry renders the identical broken
  // text — waiting cannot fix it, and six attempts would mean six chances to
  // send it if the check were ever loosened. A human has to look.
  const leaked = unrenderedTokensIn(rendered);
  if (leaked.length > 0) {
    await markFailed(
      sql,
      { ...job, attempts: 99 },
      `refused to send: rendered copy contains ${leaked.join(', ')} — the payload is missing keys this template needs`,
    );
    console.error(
      `🚨 [email-worker] BLOCKED a broken email — template=${job.template} ` +
      `event=${job.event_key} user=${job.user_id} recipient=${job.recipient}. ` +
      `Subject would have read "${rendered.subject}". Payload keys present: ` +
      `[${Object.keys(job.payload || {}).join(', ') || 'none'}].`,
    );
    return 'deadLettered';
  }

  if (dryRun) {
    console.log(
      `[email-worker] DRY RUN — would send "${rendered.subject}" to ${job.recipient} ` +
      `(${job.template}/${job.event_key})`,
    );
    // Give the claim back. A dry run that leaves rows marked 'sending' does not
    // "inspect" a queue, it empties one into a state nothing reads.
    await releaseClaim(sql, job.id);
    return 'sent';
  }

  // List-Unsubscribe goes on lifecycle mail only (resolved above): putting it
  // on a receipt invites a customer to "unsubscribe" from being told what they
  // were charged, which we cannot honour anyway.
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

/**
 * The per-user unsubscribe link, from the token minted by migration 007.
 *
 * ── THIS USED TO POINT AT A 404 ─────────────────────────────────────────────
 * It built `${CMS_BASE_URL}/unsubscribe?token=…`, but the CMS has no such
 * route: the URL fell through the SPA's `/*` catch-all and redirected to the
 * login page. So every lifecycle email carried a List-Unsubscribe header
 * promising something that could not happen, and Gmail's one-click POST — which
 * mailbox providers require of bulk senders and monitor for compliance — hit a
 * front-end that cannot process it.
 *
 * It now points at the API route that actually handles it, which serves a real
 * confirmation page to a browser and JSON to the One-Click POST. Override with
 * PUBLIC_API_URL if the server is reached on a different hostname than the one
 * it thinks it has.
 */
async function unsubscribeUrlFor(sql: SqlLike, userId: number | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = await sql`SELECT unsubscribe_token FROM users WHERE id = ${userId} LIMIT 1`;
    const token = rows[0]?.unsubscribe_token;
    if (!token) return null;
    // Defaults to the Render host the CMS is configured to call, so this works
    // without new configuration. Set PUBLIC_API_URL when that host changes —
    // the same value the Stripe webhook URL has to track.
    const base = (process.env.PUBLIC_API_URL || 'https://imporve-seo-admin-server-nzbm.onrender.com')
      .replace(/\/$/, '')
      .replace(/\/api\/v1$/, '');
    return `${base}/api/v1/users/unsubscribe?token=${token}`;
  } catch (_) {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the worker.
 *
 * ON BY DEFAULT. BILL-006's whole complaint is that no email is sent on upgrade
 * or cancellation, so shipping the fix switched off would not resolve the
 * ticket — it would relocate it. Set BILLING_EMAILS_ENABLED=false to stop
 * delivery (jobs still queue, and are delivered when it is re-enabled).
 *
 * The two templates this delivers — upgrade and cancellation — have final copy.
 * The PLACEHOLDER lifecycle templates are gated separately by
 * LIFECYCLE_EMAILS_ENABLED, which stays off until the copy owner supplies text,
 * so nothing with "[PLACEHOLDER]" in the subject line can reach a customer.
 *
 * If Mailgun is unconfigured, sendEmail already no-ops with a warning and the
 * job is retried rather than lost, so an unset key degrades rather than breaks.
 */
export function startEmailWorker(sql: SqlLike): void {
  if (String(process.env.BILLING_EMAILS_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('📭 Email worker disabled (BILLING_EMAILS_ENABLED=false). Jobs will queue until re-enabled.');
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
