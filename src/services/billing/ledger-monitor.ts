/**
 * Ledger gap detector.  (BILL-004: "alert if a subscription or credit-purchase
 * event completes without a corresponding transaction row within N minutes")
 *
 * WHAT IT ACTUALLY CHECKS
 * Two independent signals, because the two ways a row can go missing look
 * nothing alike:
 *
 *   1. A credit purchase applied (a stripe_webhook_events claim of type
 *      'credit_topup' marked processed) with no matching ledger row.
 *   2. An active subscription whose next_billing_date has passed with no
 *      renewal, upgrade or subscription_create row in the recent window — i.e.
 *      we believe they are being billed but have no record of a bill.
 *
 * WHY A QUERY AND NOT A COUNTER
 * A counter tells you how many rows you wrote. It cannot tell you about the row
 * you never attempted, which is the failure mode that produced this ticket. The
 * check is deliberately posed as "an event exists without its row", so it
 * detects silence rather than measuring noise.
 *
 * The grace window matters: the webhook and the request path race, and a row
 * written 200ms after the event is not a gap. Default 15 minutes — comfortably
 * longer than any retry, short enough to catch a broken deploy the same hour.
 */
import type { SqlLike } from './payment-methods.js';

export interface LedgerGap {
  kind: 'credit_purchase_without_row' | 'billing_cycle_without_row';
  userId: number | null;
  reference: string;
  detail: string;
}

export async function findLedgerGaps(
  sql: SqlLike,
  options: { graceMinutes?: number; limit?: number } = {},
): Promise<LedgerGap[]> {
  const grace = options.graceMinutes ?? 15;
  const limit = options.limit ?? 50;
  const gaps: LedgerGap[] = [];

  // 1. Credit top-ups that were applied but never recorded.
  const topups = await sql`
    SELECT e.event_id, e.processed_at
    FROM   stripe_webhook_events e
    WHERE  e.event_type = 'credit_topup'
      AND  e.processed = true
      AND  e.processed_at < NOW() - (${grace} || ' minutes')::interval
      AND  NOT EXISTS (
             SELECT 1 FROM billing_transactions t
             WHERE  t.provider_event_id = e.event_id
           )
    ORDER  BY e.processed_at DESC
    LIMIT  ${limit}
  `;
  for (const row of topups as any[]) {
    gaps.push({
      kind: 'credit_purchase_without_row',
      userId: null,
      reference: row.event_id,
      detail: `Credit purchase applied at ${new Date(row.processed_at).toISOString()} has no ledger row.`,
    });
  }

  // 2. Subscriptions past their billing date with no money recorded since.
  const cycles = await sql`
    SELECT s.user_id, s.next_billing_date
    FROM   subscriptions s
    WHERE  s.status = 'active'
      AND  s.next_billing_date IS NOT NULL
      AND  s.next_billing_date < NOW() - (${grace} || ' minutes')::interval
      AND  NOT EXISTS (
             SELECT 1 FROM billing_transactions t
             WHERE  t.user_id = s.user_id
               AND  t.type IN ('renewal', 'plan_upgrade', 'subscription_create', 'proration_charge')
               AND  t.occurred_at >= s.next_billing_date - INTERVAL '1 day'
           )
    ORDER  BY s.next_billing_date DESC
    LIMIT  ${limit}
  `;
  for (const row of cycles as any[]) {
    gaps.push({
      kind: 'billing_cycle_without_row',
      userId: row.user_id,
      reference: `user:${row.user_id}`,
      detail: `Billing date ${new Date(row.next_billing_date).toISOString()} passed with no charge recorded.`,
    });
  }

  return gaps;
}

/**
 * Run the check and log it. Structured, one line per gap, so it can be alerted
 * on by pattern without a metrics pipeline.
 *
 * Returns the count so a scheduler can decide whether to escalate.
 */
export async function reportLedgerGaps(
  sql: SqlLike,
  options: { graceMinutes?: number } = {},
): Promise<number> {
  try {
    const gaps = await findLedgerGaps(sql, options);
    if (gaps.length === 0) {
      console.log('[ledger-monitor] ok — no billing events missing a ledger row.');
      return 0;
    }
    console.error(`🚨 [ledger-monitor] ${gaps.length} billing event(s) have no ledger row:`);
    for (const gap of gaps) {
      console.error(`  [${gap.kind}] ${gap.reference} — ${gap.detail}`);
    }
    return gaps.length;
  } catch (err) {
    // The monitor failing is itself worth knowing about, but must never take
    // the process with it.
    console.error('[ledger-monitor] check failed:', err);
    return 0;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Hourly gap check. Off unless LEDGER_MONITOR_ENABLED=true, so merging this
 * changes nothing until it is deliberately switched on — and so it cannot start
 * logging alarms before the backfill has run.
 */
export function startLedgerMonitor(sql: SqlLike): void {
  if (String(process.env.LEDGER_MONITOR_ENABLED || '').toLowerCase() !== 'true') {
    console.log('📋 Ledger monitor disabled (set LEDGER_MONITOR_ENABLED=true to enable).');
    return;
  }
  if (timer) return;

  const graceMinutes = Number(process.env.LEDGER_MONITOR_GRACE_MINUTES || 15);
  const run = () => { void reportLedgerGaps(sql, { graceMinutes }); };

  timer = setInterval(run, 60 * 60 * 1000);
  // Delay the first pass so a cold start is not competing with it.
  setTimeout(run, 120_000).unref();
  if (timer.unref) timer.unref();
  console.log(`📋 Ledger monitor started (hourly, ${graceMinutes}m grace).`);
}
