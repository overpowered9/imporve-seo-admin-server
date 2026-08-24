/**
 * How a billing event is described to the customer.
 *
 * ── WHY THESE ARE HERE AND NOT AT THE CALL SITES ────────────────────────────
 * Every description used to be built inline, in whichever handler happened to
 * write the row. That produced a ledger where each line was phrased by a
 * different author, in a different grammar:
 *
 *     "60 ISEO credits"
 *     "Upgraded Grow → Optimize (prorated, billed on your next invoice)"
 *     "Downgrade scheduled: Optimize → Grow"
 *     "Payment failed — subscription suspended"
 *     "1 × ImproveSEO Subscription (at $25.00 / month)"     ← straight from Stripe
 *
 * Read as a column, that is not a statement of account. Some lines name the
 * plan, some do not; some are past tense, some are imperative; one is Stripe's
 * own invoice-line wording leaking through. And because the strings lived at
 * the call sites, changing the wording meant finding all of them — which is how
 * the phrase "billed on your next invoice" survived after the billing behaviour
 * changed to charge immediately, actively contradicting the receipt beside it.
 *
 * One shape for every line: `<Event> — <detail>`. The event names what happened
 * in words the customer would use; the detail carries the plan, the quantity or
 * the date. An em dash separates them, so the column scans as two aligned parts
 * rather than a paragraph.
 *
 * These are pure functions over plain data. They are unit-tested, and the tests
 * are the specification — if the wording is meant to change, change it there
 * first and the failure will point at every producer that needs updating.
 */

/**
 * Plan names arrive from the DB in several shapes ("Grow", "Grow Plan").
 *
 * Returns '' when there is no name, so callers can drop the detail rather than
 * print a placeholder — "Subscription started" is a true, readable line;
 * "Subscription started — your plan plan" is neither.
 */
const planLabel = (name: string | null | undefined): string => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '';
  // "Grow Plan" and "Grow" are the same plan; the suffix is noise in a sentence
  // that already says the word "plan".
  return trimmed.replace(/\s+plan$/i, '');
};

/** `<Event> — <plan> plan`, or just `<Event>` when the plan is unknown. */
const withPlan = (event: string, name: string | null | undefined): string => {
  const label = planLabel(name);
  return label ? `${event} — ${label} plan` : event;
};

/** `<Event> — <from> → <to>`, degrading as gracefully as the data allows. */
const withTransition = (
  event: string,
  from: string | null | undefined,
  to: string | null | undefined,
): string => {
  const a = planLabel(from);
  const b = planLabel(to);
  if (a && b) return `${event} — ${a} → ${b}`;
  if (b) return `${event} — ${b}`;
  return event;
};

/** A date the customer can act on, or null when there is nothing definite to say. */
const dayLabel = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
};

export const describeTrialStarted = (days: number): string =>
  `Free trial started — ${days} day${days === 1 ? '' : 's'}`;

export const describeTrialEnded = (): string =>
  'Free trial ended — moved to Free plan';

export const describeSubscriptionStarted = (plan: string | null | undefined): string =>
  withPlan('Subscription started', plan);

export const describeSubscriptionRenewed = (plan: string | null | undefined): string =>
  withPlan('Subscription renewed', plan);

export const describeSubscriptionCancelled = (plan: string | null | undefined): string =>
  withPlan('Subscription canceled', plan);

export const describeSubscriptionReactivated = (plan: string | null | undefined): string =>
  withPlan('Subscription reactivated', plan);

/**
 * An upgrade that has been billed.
 *
 * "(prorated)" and nothing about invoices: the charge happens at the moment of
 * the change now, so the row is settled the instant it is written. The previous
 * wording promised a future invoice that no longer exists.
 */
export const describePlanUpgraded = (
  from: string | null | undefined,
  to: string | null | undefined,
): string => `${withTransition('Plan upgraded', from, to)} (prorated)`;

/**
 * A downgrade takes effect at the period end, so the date is the whole point:
 * without it the customer cannot tell whether they still hold the higher plan.
 */
export const describePlanDowngradeScheduled = (
  from: string | null | undefined,
  to: string | null | undefined,
  effectiveAt: Date | string | null | undefined,
): string => {
  const when = dayLabel(effectiveAt);
  const base = withTransition('Plan downgrade scheduled', from, to);
  return when ? `${base}, effective ${when}` : `${base}, effective at the end of your billing period`;
};

/** The downgrade has actually landed — a different event from scheduling it. */
export const describePlanDowngraded = (
  from: string | null | undefined,
  to: string | null | undefined,
): string => withTransition('Plan downgraded', from, to);

/**
 * A credit top-up.
 *
 * `atFreeRate` exists because the same 60 credits cost different money on the
 * free plan, and a customer comparing two identical-looking rows months apart
 * needs to see why the amounts differ.
 */
export const describeCreditPurchase = (credits: number, atFreeRate = false): string =>
  `Credit purchase — ${credits.toLocaleString()} credits${atFreeRate ? ' (Free plan rate)' : ''}`;

export const describeRefund = (): string => 'Refund — issued by support';

/**
 * A manual adjustment. The sign is carried by the WORD, not by a minus that is
 * easy to miss at the end of a long line.
 */
export const describeCreditAdjustment = (delta: number): string => {
  const amount = Math.abs(delta).toLocaleString();
  return delta < 0
    ? `Credit adjustment — ${amount} credits removed by support`
    : `Credit adjustment — ${amount} credits added by support`;
};

export const describePaymentFailed = (): string =>
  'Payment failed — subscription suspended';

export const describeCreditsExpired = (credits: number): string =>
  `Credits expired — ${Math.abs(credits).toLocaleString()} credits`;

/** Exposed for the CMS-facing tests and for anything that needs the same normalisation. */
export const __planLabel = planLabel;

/**
 * The confirmation shown after a plan change.
 *
 * The old upgrade text was "Plan upgraded! Prorated charge applied. Credits
 * have been added to your account." Three claims, none of them checkable by the
 * reader: how much was charged, how many credits arrived, what happens next.
 * And the first was not even true at the time — the charge was deferred to the
 * next invoice, which is the contradiction the customer reported.
 *
 * This states the numbers. Each line answers one question:
 *   1. which plan am I on now
 *   2. what did you just take, and when does normal billing resume
 *   3. what did I get, and what do I have in total
 *
 * `chargedCents` of 0 is not "free" — it means the unused portion of the old
 * plan covered the change, and saying so prevents the reader concluding we
 * failed to bill them. `chargedCents` of null means collection did not happen
 * now, so the sentence must not claim it did.
 */
export function planUpgradeConfirmation(params: {
  planName: string | null | undefined;
  chargedCents: number | null;
  currency?: string;
  nextBillingDate?: Date | string | null;
  creditsGranted?: number;
  creditsTotal?: number | null;
}): string {
  const money = (cents: number) => {
    const code = (params.currency || 'usd').toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
        .format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  };

  const plan = planLabel(params.planName);
  const lines: string[] = [
    plan ? `You're now on the ${plan} plan` : "You're now on your new plan",
  ];

  const when = dayLabel(params.nextBillingDate);
  const resumes = when ? ` Full billing starts ${when}.` : '';

  if (params.chargedCents === null) {
    // Collection is deferred — say so rather than claim a charge that has not
    // happened. This is the honest version of the old sentence.
    lines.push(
      `The prorated amount for the rest of this billing cycle will appear on your next invoice.${resumes}`,
    );
  } else if (params.chargedCents > 0) {
    lines.push(
      `We charged ${money(params.chargedCents)} — the prorated amount for the rest of this billing cycle.${resumes}`,
    );
  } else {
    lines.push(
      `No charge today — the unused part of your previous plan covered the change.${resumes}`,
    );
  }

  const granted = params.creditsGranted ?? 0;
  if (granted > 0) {
    const total = typeof params.creditsTotal === 'number'
      ? ` You now have a total of ${params.creditsTotal.toLocaleString()} credits.`
      : '';
    lines.push(`${granted.toLocaleString()} credits added.${total}`);
  } else if (typeof params.creditsTotal === 'number') {
    lines.push(`You have ${params.creditsTotal.toLocaleString()} credits.`);
  }

  return lines.join('\n');
}

/**
 * The confirmation after a cancellation is undone.
 *
 * Mirrors the CMS's reactivationConfirmedMessage, because reactivation can be
 * reached two ways — the Reactivate Plan button on the Credits page, and
 * choosing the current plan again in Manage Plans. The first builds its copy
 * locally; the second shows whatever this endpoint returns. They must say the
 * same thing, or the same action reads differently depending on which button
 * was pressed.
 *
 * Replaces "X is active again. Billing continues as normal and you were not
 * charged today." — which named a plan but not the date money next moves, and
 * offered reassurance ("as normal") with nothing checkable in it.
 */
export function reactivationConfirmation(params: {
  planName: string | null | undefined;
  nextBillingDate?: Date | string | null;
  credits?: number | null;
}): string {
  const plan = planLabel(params.planName);
  const when = dayLabel(params.nextBillingDate);

  const back = plan ? `You're back on the ${plan} plan.` : "You're back on your plan.";
  const charge = when
    ? `No charge today — your next payment is due on ${when}.`
    : 'No charge today — billing continues on your usual date.';

  const lines = [`${back} ${charge}`];

  // Omitted rather than printed as zero: "Your 0 credits were preserved" would
  // alarm the reader and, on a reactivation, is almost certainly wrong.
  if (typeof params.credits === 'number' && Number.isFinite(params.credits) && params.credits > 0) {
    lines.push(`Your ${params.credits.toLocaleString()} credits were preserved.`);
  }

  return lines.join('\n');
}
