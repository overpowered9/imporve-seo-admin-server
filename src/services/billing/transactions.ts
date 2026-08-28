/**
 * The billing ledger — one row per billable event.  (BILL-004)
 *
 * ── DIAGNOSIS, IN THE ORDER THE TICKET ASKED ────────────────────────────────
 * The reported symptom: bought credits, upgraded to Grow, upgraded to
 * Optimize, and "Recent Transactions" stayed empty.
 *
 *  1. WRITE — no transaction rows are created, because there is no transactions
 *     table. This is the root cause. `credit_transactions` exists but is a
 *     CREDIT ledger, not a billing one: it records credit movements with no
 *     amount, no currency and no provider reference.
 *  2. ASSOCIATION — n/a. No rows to be misattributed.
 *  3. READ — the endpoint was ALSO absent originally; a later round added
 *     /billing-history, which assembles a view at read time by merging live
 *     Stripe invoices with credit_transactions rows. That is why the list is
 *     no longer literally empty, and why it is still not a ledger.
 *  4. FILTER — the merge keys credit rows on `generation_id IS NULL`, which is
 *     a sound discriminator but means the label depends on a free-text
 *     `reason` column. Reword a reason string and the history silently changes.
 *  5. WEBHOOK — deliveries are verified and idempotent on event id, but the
 *     handlers only move credits and subscription state. Nothing records that
 *     money moved. A webhook that fires while Stripe is later unreachable
 *     leaves no trace at all.
 *
 * So the deeper answer to "which layer is broken" is: the write layer never
 * existed, and the read layer was papering over it with a live provider query.
 * That fails the moment Stripe is slow, and it can never answer "what did we
 * charge this account in May?" from our own records.
 *
 * ── WHY THE WRITER IS AN UPSERT ─────────────────────────────────────────────
 * The ticket requires that we neither rely solely on the in-request write nor
 * solely on webhooks, and that a replayed webhook does not duplicate. Both fall
 * out of one thing: ON CONFLICT on the provider event id. Whichever path
 * arrives first inserts; the second updates in place. No coordination, no
 * ordering assumption, no distributed lock.
 */
import type { SqlLike } from './payment-methods.js';
import {
  describeSubscriptionStarted,
  describeSubscriptionRenewed,
  describePlanUpgraded,
} from './descriptions.js';

export type TransactionType =
  | 'credit_purchase'
  | 'subscription_create'
  | 'plan_upgrade'
  | 'plan_downgrade'
  | 'proration_charge'
  | 'proration_credit'
  | 'renewal'
  | 'refund'
  | 'payment_failed'
  | 'credit_expiry'
  | 'plan_grant';

export type TransactionStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

export interface RecordTransactionInput {
  userId: number;
  type: TransactionType;
  description: string;
  /** Integer minor units. Omit for credit-only events; never a float. */
  amountCents?: number | null;
  currency?: string | null;
  status?: TransactionStatus;
  /** Stripe event id, or a synthetic key such as `session:cs_123`. */
  providerEventId?: string | null;
  /** The invoice / charge / session the row describes. */
  providerObjectId?: string | null;
  receiptUrl?: string | null;
  planId?: number | null;
  creditType?: string | null;
  creditDelta?: number | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | string | null;
}

/**
 * Write one billable event. Idempotent on (provider, provider_event_id).
 *
 * Returns whether this call created the row, so callers can log meaningfully
 * ("webhook arrived first" vs "we already had it") without a second query.
 *
 * Never throws. A ledger write must not be able to fail a payment that has
 * already succeeded — the money moved whether or not we recorded it, and an
 * exception here would turn a completed upgrade into an error response. Failures
 * are logged at error level because a missing row IS a real problem; it is just
 * not the customer's problem.
 */
export async function recordTransaction(
  sql: SqlLike,
  input: RecordTransactionInput,
): Promise<{ recorded: boolean; duplicate: boolean }> {
  const {
    userId, type, description,
    amountCents = null, currency = null, status = 'succeeded',
    providerEventId = null, providerObjectId = null, receiptUrl = null,
    planId = null, creditType = null, creditDelta = null,
    metadata = {}, occurredAt = null,
  } = input;

  // The money CHECK constraint rejects an amount without a currency. Default
  // rather than let a caller's omission become a failed insert at 2am.
  const normalisedCurrency = amountCents === null ? null : (currency || 'usd').toUpperCase();

  try {
    const rows = await sql`
      INSERT INTO billing_transactions (
        user_id, type, description,
        amount_cents, currency, status,
        provider, provider_event_id, provider_object_id, receipt_url,
        plan_id, credit_type, credit_delta,
        metadata, occurred_at
      ) VALUES (
        ${userId}, ${type}, ${description},
        ${amountCents}, ${normalisedCurrency}, ${status},
        'stripe', ${providerEventId}, ${providerObjectId}, ${receiptUrl},
        ${planId}, ${creditType}, ${creditDelta},
        ${JSON.stringify(metadata)}, ${occurredAt ? new Date(occurredAt) : new Date()}
      )
      ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL
      DO UPDATE SET
        -- A later arrival may know more than the first (a webhook carries the
        -- receipt URL and the settled status; the in-request write does not).
        -- COALESCE so a re-delivery can only ADD detail, never blank it out.
        status       = EXCLUDED.status,
        receipt_url  = COALESCE(EXCLUDED.receipt_url, billing_transactions.receipt_url),
        amount_cents = COALESCE(EXCLUDED.amount_cents, billing_transactions.amount_cents),
        currency     = COALESCE(EXCLUDED.currency, billing_transactions.currency),
        updated_at   = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `;

    const row = rows[0];
    // xmax = 0 distinguishes an INSERT from an ON CONFLICT UPDATE without a
    // second round trip.
    const inserted = row?.inserted === true;
    return { recorded: true, duplicate: !inserted };
  } catch (err) {
    console.error(
      `❌ Could not record billing transaction (type=${type}, user=${userId}, ` +
      `event=${providerEventId}). The billing operation itself was unaffected.`,
      err,
    );
    return { recorded: false, duplicate: false };
  }
}

/**
 * The receipt link for a one-off Checkout payment.
 *
 * Invoice-backed rows get theirs from `hosted_invoice_url` (see
 * transactionsFromInvoice). A credit top-up has no invoice — it is a Checkout
 * Session in `payment` mode — so its receipt lives one level down, on the
 * charge behind the payment intent. Nothing was reading it, which is why every
 * credit_purchase row in the ledger has a null receipt_url while Stripe has had
 * the URL all along. Those are precisely the rows a customer wants a receipt
 * for; a plan change at least appears on the next invoice.
 *
 * Pure, and separate from the fetch below, so the shape-handling is testable
 * without a network: the webhook payload carries `payment_intent` as a bare id
 * string, and an unexpanded field must read as "absent", not as a receipt.
 */
export function receiptUrlFromSession(session: any): string | null {
  const intent = session?.payment_intent;
  if (!intent || typeof intent === 'string') return null;
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') return null;
  return charge.receipt_url || null;
}

/** The minimum of a Stripe client this needs — structural, like SqlLike. */
type CheckoutRetriever = {
  checkout: { sessions: { retrieve: (id: string, params?: any) => Promise<any> } };
};

/**
 * Re-read a Checkout Session with enough expanded to find its receipt.
 *
 * NEVER THROWS, for the same reason recordTransaction does not: this runs in
 * the webhook that grants purchased credits. The customer has already paid. A
 * Stripe hiccup while fetching a convenience link must not abort that handler
 * and leave the credits ungranted — the worst acceptable outcome is the null
 * receipt_url we store today, and recordTransaction's COALESCE upsert means a
 * later backfill can still fill it in.
 */
export async function fetchCheckoutReceiptUrl(
  stripe: CheckoutRetriever,
  sessionId: string | null | undefined,
): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.latest_charge'],
    });
    return receiptUrlFromSession(session);
  } catch (error) {
    console.error(`[billing] could not fetch receipt for session ${sessionId}:`, error);
    return null;
  }
}

/**
 * Turn a Stripe invoice into ledger rows.
 *
 * An upgrade invoice carries BOTH a credit for unused time and a charge for the
 * new plan, and BILL-004 asks for "proration charges and credits [as] their own
 * labeled entries". So one invoice can legitimately produce several rows, each
 * with its own event id derived from the line id — which keeps every row
 * individually idempotent.
 */
/**
 * Settle plan-change rows that were waiting on this invoice.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * A plan change is recorded on the day it happens. When the proration cannot be
 * collected there and then, that row is written `pending` with no receipt,
 * because at that moment there is no payment and nothing to link to.
 *
 * Nothing ever changed that. The money arrived later, on the next subscription
 * invoice, and the row stayed pending for good — so Account Activity and its
 * CSV export showed a charge with a blank Receipt column indefinitely, which
 * reads as a missing link rather than as "not collected yet". QA reported
 * exactly that.
 *
 * Matching is on the SUBSCRIPTION, not on an invoice id, because the pending
 * row cannot know which future invoice will carry it — `provider_object_id`
 * holds the subscription precisely when no invoice existed. An invoice with
 * proration lines settles whatever plan changes were outstanding for that
 * subscription, and two changes settled by one invoice legitimately share its
 * receipt.
 *
 * `receipt_url` is COALESCEd so a row that somehow already has one keeps it:
 * the first receipt is the one closest to the event.
 */
export async function settlePendingPlanChanges(
  sql: SqlLike,
  params: {
    userId: number;
    subscriptionId: string;
    receiptUrl: string | null;
    /** The invoice's timestamp; only rows that predate it can be settled by it. */
    paidAt: Date;
  },
): Promise<number> {
  const rows = await sql`
    UPDATE billing_transactions
       SET status      = 'succeeded',
           receipt_url = COALESCE(receipt_url, ${params.receiptUrl}),
           updated_at  = NOW()
     WHERE user_id            = ${params.userId}
       AND type               = 'plan_upgrade'
       AND status             = 'pending'
       AND provider_object_id = ${params.subscriptionId}
       AND created_at        <= ${params.paidAt}
    RETURNING id
  `;
  return (rows as any[]).length;
}

/**
 * The subscription an invoice belongs to, or null for a one-off invoice.
 *
 * ── WHY THIS IS NOT JUST `invoice.subscription` ─────────────────────────────
 * It was, at two call sites, written as `(invoice as any).subscription`. On the
 * API version this account is pinned to (2025-10-29.clover) that field does not
 * exist — Stripe moved it under `parent.subscription_details`. The cast to
 * `any` is what stopped the compiler saying so, and the field silently read
 * `undefined` on every invoice.
 *
 * Both webhook branches guarded on it, so both were unreachable: renewals never
 * refilled plan credits, renewals wrote no ledger row, and failed payments
 * neither suspended an account nor recorded anything. None of it errored — the
 * guard simply never opened.
 *
 * The legacy field is still read as a fallback. Stripe replays historical
 * events, webhook payloads are serialised at the API version in force when the
 * event was CREATED, and nothing here should depend on the account's version
 * staying where it is.
 */
export function subscriptionIdFromInvoice(invoice: any): string | null {
  const parent = invoice?.parent?.subscription_details?.subscription;
  const legacy = invoice?.subscription;
  // Either may arrive expanded into an object rather than an id string.
  const pick = (v: any): string | null =>
    (typeof v === 'string' ? v : (typeof v?.id === 'string' ? v.id : null));
  return pick(parent) ?? pick(legacy);
}

/**
 * Does this invoice represent a new billing period starting?
 *
 * ONLY `subscription_cycle` grants a fresh monthly allotment. The distinction
 * matters because refillPlanCredits adds a whole allotment AND re-stamps
 * cycle_started_at, and three other kinds of invoice are attached to a
 * subscription:
 *
 *   subscription_create  the first invoice — checkout has already granted
 *   subscription_update  a proration from a plan change
 *   manual               our own invoice from chargeProrationNow
 *
 * An upgrade adds the DIFFERENCE between the two plans, via
 * upgradeIncludedCredits, at the moment the plan changes. Refilling on its
 * invoice too would hand out a second, full allowance on top of that and move
 * the cycle anchor to the middle of the period — so the customer's balance and
 * every date derived from the cycle would both be wrong.
 */
export function isRenewalInvoice(invoice: any): boolean {
  return invoice?.billing_reason === 'subscription_cycle';
}

export function transactionsFromInvoice(
  invoice: any,
  userId: number,
  planId: number | null = null,
  /**
   * The plan this invoice is for.
   *
   * Passed in because the row's wording should come from OUR catalogue, not
   * from Stripe's invoice-line text. Without it the ledger showed lines like
   * "1 × ImproveSEO Subscription (at $25.00 / month)" — Stripe's internal
   * product wording leaking into a customer-facing statement, in a grammar
   * shared with nothing else in the column.
   */
  planName: string | null = null,
): RecordTransactionInput[] {
  const lines = invoice?.lines?.data ?? [];
  const currency = invoice.currency || 'usd';
  const occurredAt = new Date((invoice.created || 0) * 1000);
  const receiptUrl = invoice.hosted_invoice_url || invoice.invoice_pdf || null;

  const isProration = (line: any): boolean =>
    !!(line?.parent?.invoice_item_details?.proration
      || line?.parent?.subscription_item_details?.proration
      || line?.proration);

  const prorationLines = lines.filter(isProration);

  // A prorated change: each adjustment is its own labelled row.
  if (prorationLines.length > 0) {
    return prorationLines.map((line: any) => ({
      userId,
      type: (line.amount >= 0 ? 'proration_charge' : 'proration_credit') as TransactionType,
      description: line.description || (line.amount >= 0 ? 'Prorated charge' : 'Prorated credit'),
      amountCents: line.amount,
      currency,
      status: 'succeeded' as TransactionStatus,
      // Per LINE, so two adjustments on one invoice do not collide.
      providerEventId: `invoice_line:${line.id}`,
      providerObjectId: invoice.id,
      receiptUrl,
      planId,
      occurredAt,
    }));
  }

  // An ordinary invoice: one row.
  const reason = invoice.billing_reason;
  const type: TransactionType =
    reason === 'subscription_create' ? 'subscription_create'
      : reason === 'subscription_update' ? 'plan_upgrade'
        : 'renewal';

  // One wording for the whole ledger — see ./descriptions.ts. The Stripe line
  // description is the last resort, used only when we cannot name the plan.
  const description = type === 'subscription_create'
    ? (planName ? describeSubscriptionStarted(planName) : 'Subscription started')
    : type === 'renewal'
      ? (planName ? describeSubscriptionRenewed(planName) : 'Subscription renewed')
      // A subscription_update invoice IS the prorated upgrade being billed.
      : (planName ? describePlanUpgraded(null, planName) : 'Plan upgraded (prorated)');

  return [{
    userId,
    type,
    description,
    amountCents: invoice.amount_paid ?? invoice.amount_due ?? 0,
    currency,
    status: (invoice.status === 'paid' ? 'succeeded' : 'pending') as TransactionStatus,
    providerEventId: `invoice:${invoice.id}`,
    providerObjectId: invoice.id,
    receiptUrl,
    planId,
    occurredAt,
  }];
}

export interface LedgerPage {
  events: any[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * One account's history, newest first, paginated.
 *
 * Keyset pagination on (occurred_at, id) rather than OFFSET: a ledger gains
 * rows at the head while a user is reading it, and OFFSET would repeat and skip
 * rows as they page. The composite key breaks ties between rows written in the
 * same instant, which webhook bursts routinely produce.
 *
 * SCOPING IS A SECURITY BOUNDARY, not a filter. The caller must pass a user id
 * it has authenticated; this function will happily return whatever it is asked
 * for. See the route for the authorisation check.
 */
export async function readLedger(
  sql: SqlLike,
  userId: number,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<LedgerPage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  // Cursor encodes the last row seen: "<iso occurred_at>|<id>".
  let cursorTime: string | null = null;
  let cursorId: number | null = null;
  if (options.cursor) {
    const [t, i] = String(options.cursor).split('|');
    const parsedId = Number(i);
    if (t && Number.isFinite(parsedId)) {
      cursorTime = t;
      cursorId = parsedId;
    }
  }

  // Fetch one extra to establish has_more without a second COUNT query.
  const rows = cursorTime
    ? await sql`
        SELECT id, type, description, amount_cents, currency, status,
               receipt_url, credit_type, credit_delta, plan_id, occurred_at
        FROM   billing_transactions
        WHERE  user_id = ${userId}
          AND  (occurred_at, id) < (${cursorTime}::timestamptz, ${cursorId})
        ORDER  BY occurred_at DESC, id DESC
        LIMIT  ${limit + 1}
      `
    : await sql`
        SELECT id, type, description, amount_cents, currency, status,
               receipt_url, credit_type, credit_delta, plan_id, occurred_at
        FROM   billing_transactions
        WHERE  user_id = ${userId}
        ORDER  BY occurred_at DESC, id DESC
        LIMIT  ${limit + 1}
      `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    events: page.map((r: any) => ({
      id: `txn_${r.id}`,
      type: r.type,
      date: r.occurred_at,
      description: r.description,
      amount_cents: r.amount_cents === null ? null : Number(r.amount_cents),
      currency: r.currency ? String(r.currency).toLowerCase() : null,
      status: r.status,
      receipt_url: r.receipt_url,
      credit_type: r.credit_type,
      credit_delta: r.credit_delta === null ? null : Number(r.credit_delta),
    })),
    has_more: hasMore,
    next_cursor: hasMore && last
      ? `${new Date(last.occurred_at).toISOString()}|${last.id}`
      : null,
  };
}
