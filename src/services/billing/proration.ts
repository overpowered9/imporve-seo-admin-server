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
}

export interface ProrationQuote {
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
  }));

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
