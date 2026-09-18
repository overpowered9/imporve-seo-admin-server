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
  /**
   * The Stripe price this line prorates. A charge line carries the plan moved
   * TO, a credit line the plan moved FROM.
   *
   * Needed since proration became day-aligned: two upgrades on the same day
   * share one proration instant, so `period_start` alone can no longer tell
   * this change's pair from an earlier one. The price, read with the sign,
   * can — and it names the plans exactly, with no lookup by time.
   */
  price_id?: string | null;
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
  /** The price credited back (plan left) and charged (plan joined), when known. */
  from_price_id?: string | null;
  to_price_id?: string | null;
  /** Filled in from subscription_plans by price; Stripe's line names only the product. */
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
    price_id: priceIdOf(line),
  }));

/**
 * The price a previewed line prorates, across API shapes: clover puts it under
 * pricing.price_details (an id, or the object when expanded); older payloads
 * carry a top-level `price`.
 */
const priceIdOf = (line: any): string | null => {
  const candidate = line?.pricing?.price_details?.price ?? line?.price ?? null;
  if (typeof candidate === 'string') return candidate;
  if (candidate && typeof candidate.id === 'string') return candidate.id;
  return null;
};

const DAY_SECONDS = 86_400;

/**
 * The proration instant for a plan change: the start of today's BILLING day.
 *
 * ── WHY NOT "NOW" ───────────────────────────────────────────────────────────
 * Stripe prorates to the second. Priced at "now", an upgrade made half an hour
 * into a 30-day period quoted "Scale plan for the 30 days left — $49.42" and
 * "Unused time on Optimize — −$24.97": correct to the second, and read by
 * everyone as a miscalculation, because the label counts whole days and the
 * amounts did not.
 *
 * Stripe has no whole-day proration setting, but it accepts any
 * `proration_date` inside the current period. Snapping to a whole number of
 * days after the period start makes Stripe's own arithmetic whole-day: the
 * change counts from the start of today, so the customer pays for today on the
 * new plan and is credited today on the old one. Day 0 of a 30-day period is
 * then exactly $49.50 and −$25.00.
 *
 * Periods that are not 30 days still produce cents (30 of 31 days of $49.50 is
 * $47.90). That is whole-day maths, not drift.
 *
 * Returns `nowSec` unchanged when the period start is unknown or in the future,
 * so a malformed subscription degrades to the old per-second pricing rather
 * than to a date Stripe would reject.
 */
export function dayAlignedProrationDate(periodStart: number | null | undefined, nowSec: number): number {
  if (typeof periodStart !== 'number' || !Number.isFinite(periodStart) || periodStart > nowSec) {
    return nowSec;
  }
  const wholeDays = Math.floor((nowSec - periodStart) / DAY_SECONDS);
  return periodStart + wholeDays * DAY_SECONDS;
}

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
 *
 * ── SAME-DAY CHANGES ────────────────────────────────────────────────────────
 * Proration is day-aligned (dayAlignedProrationDate), so two upgrades made on
 * the same day carry the SAME instant and cannot be told apart by time. When
 * `prices` is given, this change's pair is picked out by price and sign
 * instead: the charge on the plan being bought, the credit on the plan being
 * left. Anything else at that instant is an earlier change still unpaid.
 */
export function groupProrationLines(
  lines: PreviewLine[],
  currentProrationDate?: number | null,
  prices?: { newPriceId?: string | null; currentPriceId?: string | null },
): ChangeGroup[] {
  // Matched with a tolerance because /change-plan may retry with a re-aligned
  // proration_date when Stripe rejects the quoted one as out of range.
  const TOLERANCE_SECONDS = 120;
  const nearCurrent = (at: number | null) =>
    typeof currentProrationDate === 'number' && at != null
    && Math.abs(at - currentProrationDate) <= TOLERANCE_SECONDS;

  const newPriceId = prices?.newPriceId ?? null;
  const currentPriceId = prices?.currentPriceId ?? null;
  const isCurrentPair = (line: PreviewLine, at: number | null) =>
    !!newPriceId && !!currentPriceId && nearCurrent(at) && (
      (line.amount_cents >= 0 && line.price_id === newPriceId)
      || (line.amount_cents < 0 && line.price_id === currentPriceId)
    );
  const matchesByPrice = lines.some((line) =>
    isCurrentPair(line, typeof line.period_start === 'number' ? line.period_start : null));

  const byKey = new Map<string, ChangeGroup & { credited: string[]; charged: string[] }>();

  for (const line of lines) {
    const at = typeof line.period_start === 'number' ? line.period_start : null;
    const key = matchesByPrice && isCurrentPair(line, at) ? 'current' : `at:${at}`;
    const existing = byKey.get(key) ?? {
      at,
      is_current: false,
      amount_cents: 0,
      charge_cents: 0,
      credit_cents: 0,
      credited: [],
      charged: [],
    };
    existing.amount_cents += line.amount_cents;
    // Split by SIGN rather than by Stripe's wording, which is prose and
    // localised. A negative line is time the customer already paid for.
    if (line.amount_cents < 0) {
      existing.credit_cents += line.amount_cents;
      if (line.price_id) existing.credited.push(line.price_id);
    } else {
      existing.charge_cents += line.amount_cents;
      if (line.price_id) existing.charged.push(line.price_id);
    }
    byKey.set(key, existing);
  }

  const groups: ChangeGroup[] = [...byKey.entries()].map(([key, { credited, charged, ...group }]) => {
    // A group holding a chain (Grow → Optimize → Scale, both earlier the same
    // day) reads as its ends: the price only ever credited is where it started,
    // the price only ever charged is where it finished.
    const from = credited.find((p) => !charged.includes(p)) ?? credited[0] ?? null;
    const to = charged.find((p) => !credited.includes(p)) ?? charged[charged.length - 1] ?? null;
    return {
      ...group,
      is_current: key === 'current',
      ...(from ? { from_price_id: from } : {}),
      ...(to ? { to_price_id: to } : {}),
    };
  });

  let current = groups.find((g) => g.is_current);
  if (!current && typeof currentProrationDate === 'number') {
    current = groups
      .filter((g) => nearCurrent(g.at))
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
 *
 * Without an explicit `prorationDate`, the instant is the start of today's
 * billing day (dayAlignedProrationDate) when `periodStart` is known, so the
 * quote is whole-day rather than per-second.
 */
export async function previewUpgrade(
  stripe: Pick<Stripe, 'invoices'> | any,
  params: {
    customerId: string;
    subscriptionId: string;
    subscriptionItemId: string;
    newPriceId: string;
    prorationDate?: number;
    periodStart?: number | null;
  },
): Promise<{ amountDueCents: number; currency: string; lines: PreviewLine[]; prorationDate: number }> {
  const prorationDate = params.prorationDate
    ?? dayAlignedProrationDate(params.periodStart, Math.floor(Date.now() / 1000));

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
    // ── `subscription` IS THE SWEEP — DO NOT ALSO SEND A BEHAVIOUR FLAG ─────
    // An invoice created FOR a subscription already picks up that
    // subscription's pending items; `pending_invoice_items_behavior` is for
    // customer-level invoices that have no subscription, and sending both is
    // rejected. The rejection is the worst possible shape: `invoices.create`
    // throws, so no invoice exists to pay, and the catch below reports a
    // charge that never happened.
    //
    // It was added on the belief that the default `exclude` was leaving the
    // draft empty. The ledger disproves that. With this call UNCHANGED except
    // for that one parameter:
    //
    //   Sep 12  no flag    → in_1UEv1a…, $15.49 collected, row succeeded
    //   Sep 17  flag added → no invoice on the customer at all, both proration
    //                        items (−$9.50 and +$25.00) still pending, and the
    //                        row stuck at `pending` with the subscription id
    //                        where an invoice id belongs
    //
    // Two accounts, same day, same result. Whatever produced the $0 drafts the
    // flag was meant to cure, it was not this call missing it.
    //
    // A REGRESSION TEST CANNOT CATCH THIS from the fake Stripe — the fake
    // accepts any parameters, so the test that locked the flag in passed
    // while production could not raise an invoice. The assertion now runs the
    // other way; the fake still cannot prove Stripe's rule, only that we
    // stopped breaking it.
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
 * Name the plans behind each earlier change group.
 *
 * Stripe's line says "ImproveSEO Subscription" — the product, not the plan — so
 * "your change from Grow to Optimize" cannot come from the description. It
 * comes from the PRICE on each line, looked up against subscription_plans
 * (monthly, yearly, or a price the plan was sold at before migration 021).
 * That is an exact lookup.
 *
 * It replaced a join on billing_disclosures.proration_date, which stopped being
 * able to work once proration became day-aligned: two changes on the same day
 * share one instant, so a match by time names the wrong one.
 *
 * Best effort throughout. An unnamed adjustment still shows its amount and its
 * date, which is enough to recognise; failing the whole quote because a label
 * could not be found would be a far worse trade.
 */
export async function nameChangeGroups(
  sql: SqlLike,
  groups: ChangeGroup[],
): Promise<ChangeGroup[]> {
  const earlier = groups.filter((g) => !g.is_current && (g.from_price_id || g.to_price_id));
  if (earlier.length === 0) return groups;

  try {
    // Every plan row, matched here rather than in SQL: a subscriber who joined
    // before migration 021 is still billed on a price now listed only in
    // `legacy_stripe_price_ids`, and reading the column off `*` keeps this
    // working on a database where that migration has not run yet. The table
    // holds a handful of rows.
    const rows = await sql`SELECT * FROM subscription_plans`;

    const nameFor = (priceId?: string | null): string | null => {
      if (!priceId) return null;
      const row = (rows as any[]).find(
        (r) => r.stripe_price_id === priceId
          || r.stripe_price_id_yearly === priceId
          || (Array.isArray(r.legacy_stripe_price_ids) && r.legacy_stripe_price_ids.includes(priceId)),
      );
      return row?.name ?? null;
    };

    for (const group of earlier) {
      group.from_plan = nameFor(group.from_price_id);
      group.to_plan = nameFor(group.to_price_id);
    }
  } catch (err) {
    console.error('⚠️ Could not name earlier plan changes (quote still served):', err);
  }

  return groups;
}
