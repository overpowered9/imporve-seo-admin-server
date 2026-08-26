/**
 * Proration preview, and the record of what was disclosed.  (BILL-003)
 *
 * ── WHY NONE OF THIS IS ARITHMETIC ──────────────────────────────────────────
 * Not one figure here is computed. Every amount comes from Stripe's
 * upcoming-invoice preview, because the number we show has to BE the number
 * that gets charged, and any second implementation of proration — however
 * careful — is a second answer that can disagree with the first. The only
 * defensible source is the system that will raise the invoice.
 *
 * What this module does is select, label and record.
 *
 * ── THE LINE-ITEM FILTER IS THE SUBTLE PART ─────────────────────────────────
 * A previewed invoice contains BOTH the proration adjustments (due now) and the
 * next cycle's recurring charge (due later). Presenting their sum as "total due
 * today" overstates it by a whole month.
 *
 * On API version 2025-10-29.clover `proration` is NOT a top-level field on the
 * line item — it lives under parent.invoice_item_details or
 * parent.subscription_item_details. Reading `line.proration` returns undefined
 * for every line, the filter matches nothing, and every upgrade quotes $0.00.
 * That bug was written, caught by reading the SDK's type definitions, and is
 * the reason isProrationLine has tests of its own: it is the single point where
 * a silent zero can enter the customer's confirmation dialog.
 */
import type Stripe from 'stripe';

export type SqlLike = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  begin<T>(fn: (tx: any) => Promise<T>): Promise<T>;
};

export interface PreviewLine {
  description: string;
  amount_cents: number;
  /**
   * The proration instant this line belongs to, in unix SECONDS.
   *
   * Stripe stamps every line created by one subscription change with the same
   * `period.start`, so this is what tells the four lines of a double upgrade
   * apart: two belong to the change being previewed, two to an earlier one.
   * Without it the only discriminator is the date inside Stripe's English
   * sentence, which means parsing prose to lay out a bill.
   *
   * SECONDS, not milliseconds, and that is load-bearing: the disclosure row
   * stores these lines verbatim, and a test guards that nothing PAN-shaped
   * (13–19 digits) is written there. A millisecond timestamp is 13 digits.
   */
  period_start?: number | null;
}

/**
 * One subscription change, with its proration lines netted.
 *
 * Stripe bills a change as a PAIR — a credit for the time unused on the old
 * plan, and a charge for the time remaining on the new one. Read individually
 * they are accountancy; read as a pair they are "this change cost X".
 *
 * A second upgrade in the same period produces a second pair, and the customer
 * was being shown all four lines with no indication that they came from two
 * different decisions.
 */
export interface ChangeGroup {
  /** The proration instant, unix seconds. Null when Stripe sent no period. */
  at: number | null;
  /** True for the change being previewed right now, false for earlier ones. */
  is_current: boolean;
  /** The pair, netted — what this change costs. */
  amount_cents: number;
  /** The charge half (time on the new plan). */
  charge_cents: number;
  /** The credit half (time unused on the old plan), negative. */
  credit_cents: number;
  /** Filled in by the route from our own records; Stripe does not know them. */
  from_plan?: string | null;
  to_plan?: string | null;
}

/**
 * What the customer RECEIVES, alongside what they pay. (BILL-003, extended)
 *
 * A prorated upgrade charges for the days left in the cycle and grants a
 * matching share of the credit difference. Disclosing only the money told half
 * the story: the customer saw "$8.40 today" with no way to know whether that
 * bought 360 credits or 180. Every field here comes from the same function that
 * performs the grant (previewUpgradeCreditGrant), so the figure shown is the
 * figure added.
 */
export interface CreditDisclosure {
  /** Credits added the moment the change is confirmed. */
  granted_now: number;
  /**
   * What the balance becomes once granted_now lands.
   *
   * Supplied by the server because ProrationSummary's standing rule is that it
   * calculates nothing — "a figure we worked out ourselves is a figure that can
   * disagree with the invoice". Null when the balance could not be read.
   */
  balance_after?: number | null;
  /** The monthly allotment being left behind, for "from the Optimize plan". */
  previous_allotment?: number;
  /** What a whole cycle's difference would have been. */
  full_difference: number;
  /** Monthly allotment once the change is in effect. */
  new_allotment: number;
  /** True when granted_now was scaled down for the part-cycle. */
  prorated: boolean;
  /** When the new allotment starts, when that is not today. */
  effective_date?: string | null;
}

export interface ProrationQuote {
  /**
   * The proration lines grouped by the change that produced them, current
   * first. The dialog renders these instead of the raw lines; `lines` is kept
   * so an un-redeployed client keeps working.
   */
  changes?: ChangeGroup[];
  /** Whole days left in the billing period, for "the N days left". */
  days_remaining?: number | null;
  is_upgrade: boolean;
  is_first_subscription: boolean;
  is_reactivation?: boolean;
  prorated: boolean;
  amount_due_cents: number;
  tax_cents?: number | null;
  currency: string;
  proration_date: number | null;
  effective: 'immediate' | 'period_end';
  effective_date?: string | null;
  next_billing_date?: string | null;
  next_amount_cents?: number | null;
  current_plan?: string | null;
  new_plan?: string | null;
  description: string;
  lines: PreviewLine[];
  payment_method?: { brand: string | null; last4: string | null } | null;
  /** What this change does to the credit balance. Null when it changes nothing. */
  credits?: CreditDisclosure | null;
  /**
   * The balance the customer holds RIGHT NOW, before this change.
   *
   * Set on the scheduled-downgrade quote, whose whole reassurance is that the
   * credits already bought survive the change. Null when the balance could not
   * be read, so the dialog drops that clause rather than claiming zero.
   */
  current_credits?: number | null;
  disclosure_id?: string;
}

/**
 * Is this previewed line part of what the customer owes RIGHT NOW?
 *
 * See the module note: the shape of this flag moved between API versions, and
 * getting it wrong quotes zero rather than failing loudly.
 */
export const isProrationLine = (line: any): boolean => {
  const parent = line?.parent;
  if (parent) {
    if (parent.invoice_item_details?.proration) return true;
    if (parent.subscription_item_details?.proration) return true;
    // A parent exists but neither detail flags a proration → it is a recurring
    // line for the next cycle, not part of today's total.
    if (parent.invoice_item_details || parent.subscription_item_details) return false;
  }
  return !!line?.proration; // pre-2025 shape
};

/** Sum the lines the customer is being asked to pay today. */
export const sumProrationLines = (lines: any[]): number =>
  lines.filter(isProrationLine).reduce((sum, line) => sum + (line.amount || 0), 0);

/** The lines, in the shape the confirmation dialog renders. */
export const describeProrationLines = (lines: any[]): PreviewLine[] =>
  lines.filter(isProrationLine).map((line) => ({
    description: line.description ?? 'Adjustment',
    amount_cents: line.amount ?? 0,
    // Carried so the dialog can group a double upgrade by change instead of
    // listing four raw lines. Optional because older previews — and the test
    // fixtures written before this existed — have no period at all.
    period_start: typeof line?.period?.start === 'number' ? line.period.start : null,
  }));

/**
 * The proration lines, grouped into the changes that produced them.
 *
 * Ordered with the CURRENT change first, then earlier ones most-recent-first —
 * the order the confirmation dialog reads them out, and the order that puts the
 * decision being made now at the top.
 *
 * `currentProrationDate` is the instant this preview was priced at, which
 * Stripe stamps onto the lines it is about to create. Anything stamped earlier
 * belongs to a change the customer already made in this period.
 *
 * Lines with no period at all collapse into one group with `at: null`. That is
 * the pre-2025 payload shape and the older test fixtures; treating them as the
 * current change keeps the single-upgrade case rendering exactly as before.
 */
export function groupProrationLines(
  lines: PreviewLine[],
  currentProrationDate?: number | null,
): ChangeGroup[] {
  const byInstant = new Map<number | null, ChangeGroup>();

  for (const line of lines) {
    const at = typeof line.period_start === 'number' ? line.period_start : null;
    const existing = byInstant.get(at) ?? {
      at,
      is_current: false,
      amount_cents: 0,
      charge_cents: 0,
      credit_cents: 0,
    };
    existing.amount_cents += line.amount_cents;
    // Split by SIGN rather than by Stripe's wording, which is prose and
    // localised. A negative line is time the customer already paid for.
    if (line.amount_cents < 0) existing.credit_cents += line.amount_cents;
    else existing.charge_cents += line.amount_cents;
    byInstant.set(at, existing);
  }

  const groups = [...byInstant.values()];

  // Which group is the change being made now. Matched with a tolerance because
  // /change-plan retries WITHOUT the quoted proration_date when Stripe rejects
  // it as out of range, and Stripe then prices at "now" — seconds adrift.
  const TOLERANCE_SECONDS = 120;
  let current: ChangeGroup | undefined;
  if (typeof currentProrationDate === 'number') {
    current = groups
      .filter((g) => g.at != null && Math.abs(g.at - currentProrationDate) <= TOLERANCE_SECONDS)
      .sort((a, b) => Math.abs((a.at ?? 0) - currentProrationDate)
        - Math.abs((b.at ?? 0) - currentProrationDate))[0];
  }
  // No usable instant anywhere: the whole preview is one change, which is the
  // single-upgrade case and every pre-period fixture.
  if (!current) current = groups.find((g) => g.at == null) ?? groups[groups.length - 1];
  if (current) current.is_current = true;

  return groups.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    return (b.at ?? 0) - (a.at ?? 0);
  });
}

/**
 * Record what we are about to show the customer, before they see it.
 *
 * Returns the opaque disclosure_id handed to the client and replayed on
 * confirm. Written BEFORE the quote is returned so that a disclosure always
 * exists for any quote a customer could have acted on — recording it after the
 * response would leave exactly the cases we most need evidence for (the ones
 * where something then went wrong) unrecorded.
 *
 * Never throws: a failure to write the audit row must not deny the customer a
 * price. It is logged loudly instead, and the quote goes out without an id,
 * which the commit path treats as "no disclosure to reconcile against".
 */
export async function recordDisclosure(
  sql: SqlLike,
  params: {
    userId: number;
    fromPlanId: number | null;
    toPlanId: number;
    quote: ProrationQuote;
  },
): Promise<string | null> {
  const { userId, fromPlanId, toPlanId, quote } = params;
  try {
    const rows = await sql`
      INSERT INTO billing_disclosures (
        user_id, from_plan_id, to_plan_id,
        total_due_cents, currency,
        next_amount_cents, next_billing_date,
        payment_method_brand, payment_method_last4,
        line_items, proration_date
      ) VALUES (
        ${userId}, ${fromPlanId}, ${toPlanId},
        ${quote.amount_due_cents}, ${quote.currency.toUpperCase()},
        ${quote.next_amount_cents ?? null}, ${quote.next_billing_date ?? null},
        ${quote.payment_method?.brand ?? null}, ${quote.payment_method?.last4 ?? null},
        ${JSON.stringify(quote.lines)}, ${quote.proration_date ?? null}
      )
      RETURNING disclosure_id
    `;
    return rows[0]?.disclosure_id ?? null;
  } catch (err) {
    console.error('⚠️ Could not record billing disclosure (quote still served):', err);
    return null;
  }
}

/**
 * Close out a disclosure once the charge is known, and shout if they disagree.
 *
 * BILL-003: "If the actual charged amount ever differs from the previewed
 * amount by more than rounding, that is an incident: log it at error level with
 * both values." A one-cent difference is rounding; anything larger means the
 * customer was shown a price they were not charged, which is the whole failure
 * this ticket exists to prevent recurring silently.
 */
export async function settleDisclosure(
  sql: SqlLike,
  disclosureId: string,
  chargedCents: number,
): Promise<{ mismatch: boolean; disclosedCents: number | null }> {
  try {
    const rows = await sql`
      SELECT id, user_id, total_due_cents, currency
      FROM   billing_disclosures
      WHERE  disclosure_id = ${disclosureId}
      LIMIT  1
    `;
    const row = rows[0];
    if (!row) return { mismatch: false, disclosedCents: null };

    const disclosed = Number(row.total_due_cents);
    const mismatch = Math.abs(disclosed - chargedCents) > 1;

    await sql`
      UPDATE billing_disclosures
      SET    confirmed_at = NOW(),
             charged_cents = ${chargedCents},
             mismatch = ${mismatch}
      WHERE  disclosure_id = ${disclosureId}
    `;

    if (mismatch) {
      console.error(
        `🚨 BILLING DISCLOSURE MISMATCH — user ${row.user_id} was shown ` +
        `${disclosed} ${row.currency} but was charged ${chargedCents}. ` +
        `disclosure_id=${disclosureId}. Investigate before responding to any dispute.`,
      );
    }
    return { mismatch, disclosedCents: disclosed };
  } catch (err) {
    console.error('⚠️ Could not settle billing disclosure:', err);
    return { mismatch: false, disclosedCents: null };
  }
}

/**
 * Read what a plan change will actually cost, from Stripe.
 *
 * `prorationDate` pins the instant priced against and is returned so the commit
 * path can replay it: preview at 10:00:00, commit at 10:00:07, and the amounts
 * differ because seven more seconds of the old plan have been consumed. Showing
 * one number and charging another — even by a cent — is what generates disputes.
 */
export async function previewUpgrade(
  stripe: Pick<Stripe, 'invoices'> | any,
  params: {
    customerId: string;
    subscriptionId: string;
    subscriptionItemId: string;
    newPriceId: string;
    prorationDate?: number;
  },
): Promise<{ amountDueCents: number; currency: string; lines: PreviewLine[]; prorationDate: number }> {
  const prorationDate = params.prorationDate ?? Math.floor(Date.now() / 1000);

  const preview = await stripe.invoices.createPreview({
    customer: params.customerId,
    subscription: params.subscriptionId,
    subscription_details: {
      items: [{ id: params.subscriptionItemId, price: params.newPriceId }],
      proration_behavior: 'create_prorations',
      proration_date: prorationDate,
    },
  });

  const all = preview.lines?.data ?? [];
  return {
    amountDueCents: sumProrationLines(all),
    currency: preview.currency || 'usd',
    lines: describeProrationLines(all),
    prorationDate,
  };
}

/** What actually happened when we tried to bill the proration at upgrade time. */
export interface ProrationCharge {
  /** True only when Stripe reports the invoice as paid. */
  paid: boolean;
  /** What was billed, in minor units. 0 when there was nothing to bill. */
  amountCents: number;
  currency: string;
  invoiceId: string | null;
  receiptUrl: string | null;
  /** Set when billing was attempted and did not succeed. */
  error: string | null;
}

/**
 * Bill the pending proration for an upgrade NOW, instead of at the next cycle.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `proration_behavior: 'create_prorations'` does not raise an invoice. It
 * attaches the adjustment as a PENDING invoice item to be swept up by the next
 * regular invoice. That is a legitimate Stripe mode, but it did not match a
 * single thing the product told the customer:
 *
 *   • the upgrade preview said "You will be charged this prorated amount now"
 *   • the success dialog said "Prorated charge applied"
 *   • the ledger row said "billed on your next invoice", status `pending`
 *
 * Three statements about one payment, and the only true one was the third. The
 * customer reported exactly that contradiction. Worse, nothing ever settled the
 * pending row: when the next invoice finally paid, its lines arrived under a
 * different idempotency namespace and landed as SEPARATE `proration_charge`
 * rows, so the upgrade appeared twice and the first copy stayed `pending`
 * forever.
 *
 * Charging now collapses all of it: the money moves when we say it does, the
 * row is `succeeded` with a real amount and a real receipt, and there is no
 * second row later because the items have already been billed.
 *
 * ── WHY IT NEVER THROWS ─────────────────────────────────────────────────────
 * The subscription has ALREADY been moved to the new plan by the time this
 * runs, and the credits have been granted. Throwing here would report failure
 * for an upgrade that demonstrably happened. So a billing failure degrades to
 * exactly the old behaviour — the charge stays pending on the subscription and
 * Stripe's own dunning collects it on the next invoice — and the caller records
 * the row as pending, which is then the truth rather than a contradiction.
 */
export async function chargeProrationNow(
  stripe: Stripe,
  params: { customerId: string; subscriptionId: string; idempotencyKey?: string },
): Promise<ProrationCharge> {
  const nothingToBill: ProrationCharge = {
    paid: true, amountCents: 0, currency: 'usd', invoiceId: null, receiptUrl: null, error: null,
  };

  try {
    // `subscription` scopes the draft to this subscription's pending items, so
    // an unrelated pending item on the customer cannot be swept into it.
    const draft = await stripe.invoices.create({
      customer: params.customerId,
      subscription: params.subscriptionId,
      // We pay it explicitly below; letting Stripe advance it too invites a
      // race where both attempt collection.
      auto_advance: false,
      collection_method: 'charge_automatically',
      description: 'Prorated charge for your plan upgrade',
    }, params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined);

    // A same-plan or fully-credited change produces a zero invoice. Paying it
    // is a no-op that still leaves a $0 invoice in the customer's history, so
    // void it and report the honest "nothing was charged".
    if (!draft.id) return nothingToBill;
    if ((draft.amount_due ?? 0) <= 0) {
      try { await stripe.invoices.voidInvoice(draft.id); } catch { /* a draft may simply be deleted */ }
      return { ...nothingToBill, currency: draft.currency || 'usd' };
    }

    const paid = await stripe.invoices.pay(draft.id);
    return {
      paid: paid.status === 'paid',
      amountCents: paid.amount_paid ?? paid.amount_due ?? 0,
      currency: paid.currency || 'usd',
      invoiceId: paid.id ?? null,
      receiptUrl: paid.hosted_invoice_url || paid.invoice_pdf || null,
      error: paid.status === 'paid' ? null : `invoice status ${paid.status}`,
    };
  } catch (err: any) {
    // Card declined, no payment method, Stripe unreachable — all the same shape
    // to the caller: the plan changed, the money did not move yet.
    const message = err?.message || String(err);
    console.error(`⚠️ Could not bill the upgrade proration now (${params.subscriptionId}):`, message);
    return { paid: false, amountCents: 0, currency: 'usd', invoiceId: null, receiptUrl: null, error: message };
  }
}

/**
 * Name the plans behind each change group.
 *
 * Stripe's line says "ImproveSEO Subscription" — the product, not the plan — so
 * "your change from Grow to Optimize" cannot come from the invoice. It comes
 * from our own disclosure record, which stores from_plan_id and to_plan_id and,
 * crucially, the same `proration_date` Stripe stamped onto the lines. That makes
 * this an exact join rather than a guess from the dates in the prose.
 *
 * ── ONLY CONFIRMED DISCLOSURES ──────────────────────────────────────────────
 * A row is written every time the modal is opened, so the table holds far more
 * abandoned quotes than real changes. Only settleDisclosure sets confirmed_at,
 * so that column is what separates "what the customer did" from "what they
 * looked at". Matching an abandoned quote would name a plan they never moved to.
 *
 * Tolerance rather than equality: /change-plan retries WITHOUT the quoted
 * proration_date when Stripe rejects it as stale, and Stripe then prices at
 * "now" — a few seconds adrift from what was recorded.
 *
 * Best effort throughout. An unnamed adjustment still shows its amount and its
 * date, which is enough to recognise; failing the whole quote because a label
 * could not be found would be a far worse trade.
 */
export async function nameChangeGroups(
  sql: SqlLike,
  userId: number,
  groups: ChangeGroup[],
): Promise<ChangeGroup[]> {
  const earlier = groups.filter((g) => !g.is_current && g.at != null);
  if (earlier.length === 0) return groups;

  try {
    const rows = await sql`
      SELECT d.proration_date,
             fp.name AS from_plan,
             tp.name AS to_plan
      FROM   billing_disclosures d
      LEFT   JOIN subscription_plans fp ON fp.id = d.from_plan_id
      LEFT   JOIN subscription_plans tp ON tp.id = d.to_plan_id
      WHERE  d.user_id = ${userId}
        AND  d.confirmed_at IS NOT NULL
        AND  d.proration_date IS NOT NULL
      ORDER  BY d.confirmed_at DESC
      LIMIT  50
    `;

    const TOLERANCE_SECONDS = 120;
    for (const group of earlier) {
      const match = (rows as any[])
        .map((r) => ({ r, delta: Math.abs(Number(r.proration_date) - (group.at as number)) }))
        .filter((c) => c.delta <= TOLERANCE_SECONDS)
        .sort((a, b) => a.delta - b.delta)[0];
      if (match) {
        group.from_plan = match.r.from_plan ?? null;
        group.to_plan = match.r.to_plan ?? null;
      }
    }
  } catch (err) {
    console.error('⚠️ Could not name earlier plan changes (quote still served):', err);
  }

  return groups;
}
