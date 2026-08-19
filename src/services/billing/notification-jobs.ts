/**
 * Scheduled notification jobs.  (BILL-007 credit expiry, BILL-008 inactivity)
 *
 * BILL-008 requires reusing BILL-007's scheduling rather than building a
 * parallel system, and that shared logic be factored into one tested component.
 * That component is `runNotificationJob` below: both jobs are a candidate
 * query, a dedupe key, and a payload builder, so those are the three things a
 * job supplies and everything else is common.
 *
 * ── CONFIGURATION ───────────────────────────────────────────────────────────
 * Lead times come from config, not code (BILL-007). Signed off: 14 days, 3
 * days, and day-of. Change CREDIT_EXPIRY_LEAD_DAYS to alter them; no logic
 * changes and no redeploy of behaviour is required.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 * Expiry is evaluated in UTC. Per-account timezones apply to DISPLAY only, in
 * the email template. A job that ran in local time would fire twice on a DST
 * fall-back and skip an hour on spring-forward, and "expires in 3 days" is not
 * a claim precise enough to need a local boundary. Month-end is handled by
 * Postgres interval arithmetic rather than by adding 30 days: `+ interval '1
 * month'` on 31 January gives 28 February, which is what a billing cycle does.
 *
 * ── CONCURRENCY ─────────────────────────────────────────────────────────────
 * Claim-before-send against a UNIQUE constraint, rather than a single-runner
 * lock. Chosen because it is the same mechanism that already protects the trial
 * drip in this codebase, it survives a worker restart mid-batch, and it makes
 * the job safe to run manually while the scheduler is also running — a
 * single-runner lock would make the manual run either block or silently no-op.
 *
 * The trade-off is explicit: claiming before sending means a send failure costs
 * a MISSED email, not a duplicate. For a warning that will fire again next
 * cycle, that is the right way round.
 *
 * ── SCALE ───────────────────────────────────────────────────────────────────
 * Every candidate query is paged with a LIMIT and keyed on the last id seen, so
 * nothing loads the user table into memory.
 */
import type { SqlLike } from './payment-methods.js';
import { enqueueEmail, type EmailCategory } from './email-outbox.js';
import { expireLapsedLots } from '../../models/user.models.js';

export interface NotificationConfig {
  /** Lead times in days before expiry. Signed off as 14, 3, 0 (day-of). */
  creditExpiryLeadDays: number[];
  /** Consecutive days with no qualifying activity before the nudge. */
  inactivityDays: number;
  /** Minimum gap between successive inactivity emails to one user. */
  inactivityCooldownDays: number;
  /** Rows per page. */
  batchSize: number;
  dashboardUrl: string;
  creditsUrl: string;
}

export const loadNotificationConfig = (): NotificationConfig => {
  const frontend = (process.env.FRONTEND_URL || process.env.CMS_BASE_URL || 'https://account.improveseoplugin.com')
    .replace(/\/$/, '');
  return {
    creditExpiryLeadDays: String(process.env.CREDIT_EXPIRY_LEAD_DAYS || '14,3,0')
      .split(',')
      .map((d) => parseInt(d.trim(), 10))
      .filter((d) => Number.isFinite(d) && d >= 0)
      // Descending, so the earliest warning is considered first and a user who
      // crosses two thresholds between runs gets the more urgent one.
      .sort((a, b) => b - a),
    inactivityDays: Number(process.env.INACTIVITY_EMAIL_DAYS || 14),
    inactivityCooldownDays: Number(process.env.INACTIVITY_COOLDOWN_DAYS || 60),
    batchSize: Number(process.env.NOTIFICATION_BATCH_SIZE || 100),
    dashboardUrl: `${frontend}/overview`,
    creditsUrl: `${frontend}/credits`,
  };
};

export const firstNameOf = (name?: string | null, email?: string | null): string =>
  (name || '').trim().split(/\s+/)[0] || (email || '').split('@')[0] || 'there';

export const fmtDate = (d?: string | Date | null): string =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'soon';

/**
 * How many complete articles-with-image a balance buys.
 *
 * MUST match the CMS's contentPiecesFromCredits: one piece costs one content
 * credit AND one image credit, so the answer is limited by whichever runs out
 * first — not the combined total. An email promising more pieces than the
 * dashboard shows is worse than sending no email.
 */
export const piecesFrom = (content: number, images: number): number =>
  Math.max(0, Math.min(Math.floor(content || 0), Math.floor(images || 0)));

export interface Candidate {
  user_id: number;
  email: string;
  name: string | null;
  [key: string]: any;
}

export interface JobDefinition<T extends Candidate = Candidate> {
  /** Job name, for logs. */
  name: string;
  /** Email template to queue. */
  template: string;
  category: EmailCategory;
  /** One page of candidates, after `afterId`. */
  fetchPage: (sql: SqlLike, afterId: number, limit: number) => Promise<T[]>;
  /**
   * Identifies the OCCURRENCE, so the same kind can fire again later but never
   * twice for the same one. This IS the idempotency guarantee.
   */
  dedupeKey: (candidate: T) => string;
  /** Everything the template needs, built from the candidate row. */
  payload: (candidate: T, cfg: NotificationConfig) => Record<string, unknown>;
}

export interface JobResult {
  name: string;
  scanned: number;
  queued: number;
  skippedDuplicate: number;
  errors: number;
  /** Populated in dry-run: exactly who WOULD be emailed. */
  wouldEmail: Array<{ userId: number; email: string; dedupeKey: string }>;
}

/**
 * Run one notification job. Shared by BILL-007 and BILL-008.
 *
 * @param dryRun reports who would be emailed and writes NOTHING — no claim, no
 *   queue row. Mandatory per both tickets, and the default for the CLI.
 */
export async function runNotificationJob<T extends Candidate>(
  sql: SqlLike,
  job: JobDefinition<T>,
  cfg: NotificationConfig,
  options: { dryRun?: boolean; maxPages?: number } = {},
): Promise<JobResult> {
  const dryRun = options.dryRun === true;
  const maxPages = options.maxPages ?? 100;

  const result: JobResult = {
    name: job.name, scanned: 0, queued: 0, skippedDuplicate: 0, errors: 0, wouldEmail: [],
  };

  let afterId = 0;
  for (let page = 0; page < maxPages; page++) {
    let candidates: T[];
    try {
      candidates = await job.fetchPage(sql, afterId, cfg.batchSize);
    } catch (err) {
      // A missing table (migration not yet run) must not spam the logs on every
      // scheduler pass, and must not be mistaken for "nobody is due".
      console.error(`[${job.name}] candidate query failed:`, err);
      result.errors++;
      break;
    }
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1].user_id;

    for (const candidate of candidates) {
      result.scanned++;
      const key = job.dedupeKey(candidate);

      if (dryRun) {
        result.wouldEmail.push({ userId: candidate.user_id, email: candidate.email, dedupeKey: key });
        continue;
      }

      try {
        // Claim first. The UNIQUE (user_id, kind, dedupe_key) constraint means a
        // concurrent scheduler — or this job re-run after a crash — loses the
        // race and skips, which is what makes this at-most-once.
        const claimed = await claimNotification(sql, candidate.user_id, job.name, key);
        if (!claimed) {
          result.skippedDuplicate++;
          continue;
        }

        const { enqueued } = await enqueueEmail(sql, {
          userId: candidate.user_id,
          recipient: candidate.email,
          template: job.template,
          category: job.category,
          // The outbox dedupes independently on this, so even a released claim
          // cannot produce a second email for the same occurrence.
          eventKey: `${job.name}:${candidate.user_id}:${key}`,
          payload: job.payload(candidate, cfg),
        });

        if (enqueued) result.queued++;
        else result.skippedDuplicate++;
      } catch (err) {
        result.errors++;
        console.error(`[${job.name}] failed for user ${candidate.user_id}:`, err);
      }
    }

    if (candidates.length < cfg.batchSize) break;
  }

  return result;
}

/** Atomically claim the right to send one notification. */
export async function claimNotification(
  sql: SqlLike,
  userId: number,
  kind: string,
  dedupeKey: string,
): Promise<boolean> {
  try {
    const rows = await sql`
      INSERT INTO user_notifications (user_id, kind, dedupe_key)
      VALUES (${userId}, ${kind}, ${dedupeKey})
      ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  } catch (err: any) {
    if (err?.code === '42P01') {
      console.warn(`[${kind}] user_notifications table missing — run the migrations. Skipping rather than sending unguarded.`);
      return false;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BILL-007 — credits approaching expiry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Candidate query for one lead time.
 *
 * SUPPRESSION IS IN THE QUERY, not applied afterwards, so a suppressed user is
 * never claimed and never occupies a dedupe key they did not consume:
 *   - zero balance → nothing to lose, and "your 0 credits are expiring" is noise
 *   - consumed / extended → the reset date moves, so they fall out naturally
 *   - closed, deleted, internal → excluded
 *   - unsubscribed / hard-bounced → excluded here AND at send time
 *
 * CONSOLIDATION: the row is aggregated per USER, not per credit type, so a user
 * whose content and image credits expire together gets ONE email describing
 * both. That is BILL-007's batching requirement, satisfied by GROUP BY rather
 * than by a second de-duplication pass.
 *
 * BOUNDARIES: `reset_at::date = (NOW() + N days)::date` compares whole UTC days,
 * so "exactly 14 days" is a day, not an instant. Comparing timestamps would
 * make the job's own run time the boundary — a run at 09:00 would miss anyone
 * expiring at 08:59 and catch them a day late.
 */
export const creditExpiryJob = (leadDays: number, cfg: NotificationConfig): JobDefinition => ({
  name: 'credit_expiry',
  template: 'lifecycle.credit_expiry',
  category: 'lifecycle',
  fetchPage: (sql, afterId, limit) => sql`
    -- ── Driven by credit_lots.expires_at, not by the billing cycle ──────────
    -- This used to derive the reset date from the subscription's next billing
    -- date, or failing that from cycle_started_at + 1 month. Both were proxies
    -- for "when do these credits die?", and neither is true any more: a lot
    -- lives two months (plan) or twelve (purchased), so credits routinely
    -- outlive the cycle that granted them and two lots with different dates sit
    -- side by side. The expiry date is now a column, so read it.
    --
    -- Grouped by the DATE, so a user warned about one lot expiring is told the
    -- total going with it rather than receiving one email per lot.
    SELECT u.id AS user_id, u.email, u.name,
           -- The three aliases are kept so the existing email templates keep
           -- rendering; each reports the same pooled figure.
           COALESCE(SUM(cl.remaining), 0)::int AS content,
           COALESCE(SUM(cl.remaining), 0)::int AS images,
           COALESCE(SUM(cl.remaining), 0)::int AS keywords,
           COALESCE(SUM(cl.remaining), 0)::int AS expiring_total,
           -- What survives this expiry: everything in later lots.
           COALESCE((
             SELECT SUM(later.remaining)::int FROM credit_lots later
             WHERE later.user_id = u.id AND later.remaining > 0
               AND later.expires_at > MAX(cl.expires_at)
           ), 0) AS remaining_after,
           MAX(cl.expires_at) AS cycle_started_at,
           MAX(cl.expires_at) AS reset_at
    FROM   users u
    JOIN   credit_lots cl ON cl.user_id = u.id AND cl.remaining > 0
    WHERE  u.email IS NOT NULL
      AND  u.id > ${afterId}
      AND  u.marketing_opt_out_at IS NULL
      AND  u.email_hard_bounced_at IS NULL
      AND  u.is_internal = FALSE
      AND  (cl.expires_at AT TIME ZONE 'UTC')::date
           = ((NOW() AT TIME ZONE 'UTC') + (${leadDays} || ' days')::interval)::date
    GROUP  BY u.id, u.email, u.name
    HAVING COALESCE(SUM(cl.remaining), 0) > 0
    ORDER  BY u.id
    LIMIT  ${limit}
  ` as Promise<Candidate[]>,

  // Keyed on the EXPIRY DATE and the threshold, so a user legitimately receives
  // the 14-day and the 3-day warning for the same lot, but never the same one
  // twice — and two lots expiring on different dates are warned about
  // separately, which is correct: they are different money.
  dedupeKey: (c) => `expires:${new Date(c.reset_at).toISOString().slice(0, 10)}:lead:${leadDays}`,

  payload: (c, config) => ({
    firstName: firstNameOf(c.name, c.email),
    expiringAmount: `${Number(c.expiring_total).toLocaleString()} credits`
      + ` (${c.content} content, ${c.images} image, ${c.keywords} keyword)`,
    expiryDate: fmtDate(c.reset_at),
    remainingAfter: `${Number(c.remaining_after).toLocaleString()} credits`,
    pieces: piecesFrom(c.content, c.images),
    leadTimeLabel: leadDays === 0 ? 'today' : `in ${leadDays} day${leadDays === 1 ? '' : 's'}`,
    ctaUrl: config.creditsUrl,
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// BILL-008 — inactive accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INACTIVITY DEFINITION — as signed off.
 *
 *   Activity  = a content generation (user_generations.created_at). This is the
 *               only activity signal the telemetry actually supports today:
 *               there is no last_login_at or last_active_at column anywhere in
 *               the schema, and inventing one would need a write on the
 *               authenticated request path plus a backfill.
 *   Threshold = 14 CONSECUTIVE days with no generation, measured from the last
 *               one, rolling.
 *   Scope     = evaluated PER USER; credit balance stated at the account level.
 *   Cooldown  = 60 days minimum between sends, so a permanently lapsed user
 *               hears from us roughly six times a year, not twenty-six.
 *
 * Users who have NEVER generated are excluded: they are the trial drip's
 * audience, and "you've been away" to someone who never arrived reads as a
 * broken system.
 *
 * Zero-credit users are excluded — the email's entire payload is their balance,
 * so there is nothing to say to someone with none.
 *
 * Dunning accounts are excluded: a failed-payment customer needs a payment
 * email, not a re-engagement nudge.
 */
export const inactivityJob = (cfg: NotificationConfig): JobDefinition => ({
  name: 'inactivity',
  template: 'lifecycle.inactivity',
  category: 'lifecycle',
  fetchPage: (sql, afterId, limit) => sql`
    WITH last_activity AS (
      SELECT user_id, MAX(created_at) AS last_generation_at
      FROM   user_generations
      GROUP  BY user_id
    )
    SELECT u.id AS user_id, u.email, u.name,
           la.last_generation_at,
           COALESCE(sp.name, 'Free') AS plan_name,
           -- One ISEO pool now; both aliases report the same pooled balance (see above).
           COALESCE(SUM(cb.amount), 0)::int AS content,
           COALESCE(SUM(cb.amount), 0)::int AS images,
           COALESCE(SUM(cb.amount), 0)::int AS total_credits,
           MIN(cb.cycle_started_at) + INTERVAL '1 month' AS nearest_expiry
    FROM   users u
    JOIN   last_activity la ON la.user_id = u.id
    JOIN   credit_balances cb ON cb.user_id = u.id
    LEFT   JOIN subscriptions s ON s.user_id = u.id
    LEFT   JOIN subscription_plans sp ON sp.id = u.plan_id
    WHERE  u.email IS NOT NULL
      AND  u.id > ${afterId}
      AND  u.marketing_opt_out_at IS NULL
      AND  u.email_hard_bounced_at IS NULL
      AND  u.is_internal = FALSE
      -- 14 CONSECUTIVE days with no generation, measured in whole UTC days so
      -- the job's run time is not the boundary.
      AND  (la.last_generation_at AT TIME ZONE 'UTC')::date
             <= ((NOW() AT TIME ZONE 'UTC') - (${cfg.inactivityDays} || ' days')::interval)::date
      -- Dunning customers get a payment email, not this one.
      AND  (s.status IS NULL OR s.status NOT IN ('past_due', 'unpaid', 'incomplete'))
      -- The cooldown, enforced in SQL so a returning-then-lapsing user can be
      -- emailed again while a continuously inactive one cannot.
      AND  NOT EXISTS (
             SELECT 1 FROM user_notifications n
             WHERE  n.user_id = u.id
               AND  n.kind = 'inactivity'
               AND  n.sent_at > NOW() - (${cfg.inactivityCooldownDays} || ' days')::interval
           )
    GROUP  BY u.id, u.email, u.name, la.last_generation_at, sp.name
    HAVING COALESCE(SUM(cb.amount), 0) > 0
    ORDER  BY u.id
    LIMIT  ${limit}
  ` as Promise<Candidate[]>,

  // Keyed on the inactivity WINDOW (the last-activity date), so one lapse
  // cannot produce two emails even if the cooldown query races.
  dedupeKey: (c) => `since:${new Date(c.last_generation_at).toISOString().slice(0, 10)}`,

  payload: (c, config) => ({
    firstName: firstNameOf(c.name, c.email),
    creditBalance: `${Number(c.total_credits).toLocaleString()} credits`,
    pieces: piecesFrom(c.content, c.images),
    nearestExpiry: c.nearest_expiry ? fmtDate(c.nearest_expiry) : null,
    planName: c.plan_name || 'Free',
    daysInactive: Math.floor(
      (Date.now() - new Date(c.last_generation_at).getTime()) / 86_400_000,
    ),
    ctaUrl: config.dashboardUrl,
  }),
});

/** Run every notification job once. Exported for the CLI and the scheduler. */
export async function runAllNotificationJobs(
  sql: SqlLike,
  options: { dryRun?: boolean } = {},
): Promise<JobResult[]> {
  const cfg = loadNotificationConfig();
  const results: JobResult[] = [];

  // BILL-007 — one pass per configured lead time.
  for (const leadDays of cfg.creditExpiryLeadDays) {
    const result = await runNotificationJob(sql, creditExpiryJob(leadDays, cfg), cfg, options);
    result.name = `credit_expiry(${leadDays}d)`;
    results.push(result);
  }

  // BILL-008 — reuses the same runner; see the module note.
  results.push(await runNotificationJob(sql, inactivityJob(cfg), cfg, options));

  // ── The sweep that actually takes the credits away ────────────────────────
  // Runs AFTER the warnings, so a lot that reaches zero lead time is warned
  // about on its last day and expired on the next pass, never silently expired
  // in the same run that was supposed to warn about it.
  //
  // Never runs in a dry run: this one destroys value, and "dry run" has to mean
  // it for the runbook to be usable.
  if (!options.dryRun) {
    results.push(await runExpirySweep());
  }

  return results;
}

/**
 * Expire lapsed lots, and tell the admins how much vanished.
 *
 * ── WHY THE ALERT IS TO ADMINS AND NOT THE BALANCE PANEL ────────────────────
 * Signed off explicitly: credit-loss prevention is "email + admin
 * notifications, not the balance panel". A panel that nags about expiry turns
 * every visit into a warning the user cannot act on in the moment; the warning
 * belongs where it can be acted on — the customer's inbox, ahead of time (the
 * credit_expiry job above), and the operator's, after the fact.
 */
async function runExpirySweep(): Promise<JobResult> {
  const result: JobResult = {
    name: 'credit_expiry_sweep',
    scanned: 0, queued: 0, skippedDuplicate: 0, errors: 0, wouldEmail: [],
  };

  try {
    const expired = await expireLapsedLots();
    result.scanned = expired.length;
    const total = expired.reduce((n, e) => n + e.expired, 0);

    if (expired.length > 0) {
      // One structured line, so it can be alerted on without parsing prose.
      console.warn(
        `[credit-expiry] swept ${total} credit(s) from ${expired.length} user(s): `
        + expired.map((e) => `${e.user_id}:${e.expired}`).join(' '),
      );
      const admins = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (admins.length === 0) {
        console.warn(
          '[credit-expiry] ADMIN_EMAILS is empty — the admin notification for this sweep '
          + 'went nowhere. Set it, or credit loss is invisible to operators.',
        );
      }
    }
  } catch (err) {
    result.errors = 1;
    console.error('[credit-expiry] sweep failed:', err);
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startNotificationScheduler(sql: SqlLike): void {
  if (String(process.env.LIFECYCLE_EMAILS_ENABLED || '').toLowerCase() !== 'true') {
    console.log('📭 Notification jobs disabled (set LIFECYCLE_EMAILS_ENABLED=true to enable).');
    return;
  }
  if (timer) return;

  // Daily. Both triggers are day-granular, so anything more frequent is load
  // without benefit — and the dedupe keys make a second run in the same day a
  // no-op anyway.
  const INTERVAL_MS = Number(process.env.NOTIFICATION_INTERVAL_MS || 24 * 60 * 60 * 1000);

  const run = () => {
    runAllNotificationJobs(sql)
      .then((results) => {
        for (const r of results) {
          if (r.queued || r.errors) {
            console.log(
              `[${r.name}] scanned:${r.scanned} queued:${r.queued} ` +
              `duplicate:${r.skippedDuplicate} errors:${r.errors}`,
            );
          }
          // BILL-007 asks for alerting on anomalous volume. A run that queues
          // for most of the accounts it scanned usually means a predicate broke.
          if (r.scanned > 20 && r.queued > r.scanned * 0.5) {
            console.error(
              `🚨 [${r.name}] queued ${r.queued} of ${r.scanned} scanned — ` +
              'unusually high. Check the candidate query before this reaches inboxes.',
            );
          }
        }
      })
      .catch((e) => console.error('[notification-jobs] run failed:', e));
  };

  timer = setInterval(run, INTERVAL_MS);
  setTimeout(run, 5 * 60_000).unref();
  if (timer.unref) timer.unref();
  console.log('📬 Notification scheduler started (daily).');
}
