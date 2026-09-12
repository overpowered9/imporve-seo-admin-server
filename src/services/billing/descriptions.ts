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
/**
 * The name the CUSTOMER knows a plan by.
 *
 * ── WHY A MAPPING IS NEEDED AT ALL ──────────────────────────────────────────
 * `subscription_plans.name` holds the ORIGINAL names — "Starter Plan" and
 * "Pro Plan" — while every screen in the product, and every line QA specified,
 * calls those plans **Optimize** and **Scale**. Without this, feeding real rows
 * through the catalogue produces text no customer recognises, which is exactly
 * what the production ledger shows:
 *
 *     Upgraded Starter Plan → Pro Plan (prorated, …)
 *     Downgrade scheduled: Pro Plan → Starter Plan
 *
 * Keyed on both name and slug, canonically (case-insensitive, trailing "Plan"
 * dropped), so "Pro", "pro", "Pro Plan" and "PRO PLAN" all resolve. This is the
 * same table the CMS uses in utils/planUtils.js — the two must agree, or the
 * confirmation dialog names a plan differently from the card just clicked.
 */
const PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  grow: 'Grow',
  basic: 'Grow',
  starter: 'Optimize',
  premium: 'Optimize',
  pro: 'Scale',
  enterprise: 'Scale',
  free: 'Free',
});

/** Case-insensitive, and the decorative trailing "Plan" removed. */
const canonicalPlanKey = (value: string | null | undefined): string =>
  String(value ?? '').trim().replace(/\s+plan$/i, '').toLowerCase();

export const planLabel = (name: string | null | undefined): string => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '';
  // An unknown plan keeps its own name rather than becoming "Unknown" — a new
  // plan added to the table should read as itself, not as a placeholder.
  // The suffix is dropped either way: it is noise in a sentence that already
  // says the word "plan".
  return PLAN_DISPLAY_NAMES[canonicalPlanKey(trimmed)] ?? trimmed.replace(/\s+plan$/i, '');
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

/**
 * The last day the customer still holds their CURRENT plan.
 *
 * A scheduled change lands ON the renewal date — that is when the new plan
 * starts and when money moves — so the old plan's last day is the day before.
 *
 * The subtraction is done in UTC (setUTCDate on a UTC-read date), not by
 * building a local Date. `next_billing_date` is stored midnight UTC, and for
 * anyone west of Greenwich a local-time subtraction lands on the previous day
 * before it even starts, silently reporting a date two days early.
 */
const dayBeforeLabel = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return dayLabel(d);
};

/** Minor units to a display string, falling back if the currency code is junk. */
const formatMoneyCents = (cents: number, currency = 'usd'): string => {
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
      .format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
};

export const describeTrialStarted = (days: number): string =>
  `Free trial started — ${days} day${days === 1 ? '' : 's'}`;

// The free tier is sold as the Basic plan now (the CMS renamed it), so new
// activity rows name it the same way. Rows already written keep their text.
export const describeTrialEnded = (): string =>
  'Free trial ended — moved to Basic plan';

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
  `Credit pack purchase — ${credits.toLocaleString()} credits${atFreeRate ? ' (Basic plan rate)' : ''}`;

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

/**
 * Kept as an alias so the existing CMS-facing tests keep their import. New
 * callers should use the exported `planLabel` above — it is the same function,
 * and the double underscore wrongly suggests it is private.
 */
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
export interface UpgradeConfirmationParams {
  planName: string | null | undefined;
  chargedCents: number | null;
  currency?: string;
  nextBillingDate?: Date | string | null;
  creditsGranted?: number;
  creditsTotal?: number | null;
}

/**
 * The same confirmation as PARAGRAPHS, with the facts emphasised.
 *
 * Each paragraph leads with what the reader is scanning for and then explains
 * it: the plan they are now on, the amount taken, the credits received. The
 * lead is bold and the explanation is not, so the three answers can be found
 * without reading the sentences around them.
 *
 * "No charge today" is bold wherever it appears — here, on both downgrade
 * dialogs and on the reactivation — because it is the same question every time
 * and it should not have to be hunted for on one screen and not another.
 *
 * planUpgradeConfirmation is derived FROM this, so the string and the structure
 * can never disagree about what the message says.
 */
export function planUpgradeConfirmationParts(
  params: UpgradeConfirmationParams,
): MessageParagraph[] {
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
  const paragraphs: MessageParagraph[] = [
    plan
      // The plan name is the emphasis: it is the single fact that changed.
      ? [{ text: "You're now on the " }, { text: `${plan} plan`, strong: true }]
      : [{ text: "You're now on your new plan" }],
  ];

  const when = dayLabel(params.nextBillingDate);
  const resumes = when ? ` Full billing starts ${when}.` : '';

  if (params.chargedCents === null) {
    // Collection is deferred — say so rather than claim a charge that has not
    // happened. This is the honest version of the old sentence. Nothing is
    // emphasised: there is no figure yet to pick out.
    paragraphs.push([{
      text: `The prorated amount for the rest of this billing cycle will appear on your next invoice.${resumes}`,
    }]);
  } else if (params.chargedCents > 0) {
    paragraphs.push([
      { text: `We charged ${money(params.chargedCents)}`, strong: true },
      { text: ` — the prorated amount for the rest of this billing cycle.${resumes}` },
    ]);
  } else {
    paragraphs.push([
      { text: 'No charge today', strong: true },
      { text: ` — the unused part of your previous plan covered the change.${resumes}` },
    ]);
  }

  const granted = params.creditsGranted ?? 0;
  if (granted > 0) {
    const total = typeof params.creditsTotal === 'number'
      ? ` You now have a total of ${params.creditsTotal.toLocaleString()} credits.`
      : '';
    paragraphs.push([
      { text: `${granted.toLocaleString()} credits added.`, strong: true },
      ...(total ? [{ text: total }] : []),
    ]);
  } else if (typeof params.creditsTotal === 'number') {
    paragraphs.push([{ text: `You have ${params.creditsTotal.toLocaleString()} credits.` }]);
  }

  return paragraphs;
}

/**
 * The confirmation as a plain string, for anything that cannot render segments.
 *
 * Derived from the parts above rather than written twice, so the two cannot
 * drift into saying different things.
 */
export function planUpgradeConfirmation(params: UpgradeConfirmationParams): string {
  return planUpgradeConfirmationParts(params)
    .map((paragraph) => paragraph.map((seg) => seg.text).join(''))
    .join('\n');
}

/**
 * The confirmation shown after a downgrade is scheduled.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * A template string that interpolated a Date object directly:
 *
 *   `Plan downgrade scheduled for ${currentSub.next_billing_date}. No charge today.`
 *
 * which put "Sun Sep 20 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"
 * in front of the customer. The upgrade beside it had gone through
 * planUpgradeConfirmation for months; the downgrade was never given the same
 * treatment.
 *
 * Three lines, each answering one question in the order it gets asked:
 *   1. when do I lose the plan I am on, and when does the new one begin
 *   2. am I being charged, and what will I pay next
 *   3. what happens to the credits I already have
 *
 * ── TWO DATES, ON PURPOSE ───────────────────────────────────────────────────
 * The change lands ON the renewal date, so that is when the new plan starts and
 * when the next payment is taken. The only date that differs is "you stay on X
 * until", which is the day before — see dayBeforeLabel. Collapsing them to one
 * date would either claim the old plan ends a day early or that the new plan
 * starts a day late.
 */
export interface MessageSegment {
  text: string;
  /** Rendered bold by the CMS. See RichMessage in the CMS. */
  strong?: boolean;
}
/** One paragraph, as the segments it is made of. */
export type MessageParagraph = MessageSegment[];

export interface DowngradeConfirmationParams {
  fromPlan: string | null | undefined;
  toPlan: string | null | undefined;
  nextBillingDate?: Date | string | null;
  nextAmountCents?: number | null;
  currency?: string;
}

/**
 * The same confirmation as PARAGRAPHS, with the money sentence emphasised.
 *
 * ── WHY STRUCTURE AND NOT A STRING ──────────────────────────────────────────
 * The CMS rendered the string below with `whiteSpace: 'pre-line'`, which gets
 * line breaks and nothing else: the three lines sat flush together, and no part
 * of one could be weighted. "No charge today." is the first thing anyone reads
 * after committing to a billing change, so it carries weight — and that cannot
 * be expressed in a string without the renderer pattern-matching on the wording,
 * which would break silently the moment the wording changed.
 *
 * planDowngradeConfirmation is derived FROM this, so the string and the
 * structure can never disagree about what the message says.
 */
export function planDowngradeConfirmationParts(
  params: DowngradeConfirmationParams,
): MessageParagraph[] {
  const from = planLabel(params.fromPlan);
  const to = planLabel(params.toPlan);
  const starts = dayLabel(params.nextBillingDate);
  const lastDay = dayBeforeLabel(params.nextBillingDate);

  const paragraphs: MessageParagraph[] = [];

  // 1. Degrades one clause at a time rather than all-or-nothing: knowing the
  // plan names is useful even when the date is missing, and vice versa.
  const staysOn = from ? `You stay on the ${from} plan` : 'You stay on your current plan';
  const newPlanStarts = to ? `The ${to} plan starts` : 'Your new plan starts';
  paragraphs.push([{
    text: lastDay && starts
      ? `${staysOn} until ${lastDay}. ${newPlanStarts} on ${starts}.`
      : `${staysOn} until the end of your billing period. ${newPlanStarts} then.`,
  }]);

  // 2. "No charge today." leads AND is emphasised, because it is the first
  // thing anyone checks after committing to a billing change.
  const amount = params.nextAmountCents;
  const money = typeof amount === 'number' && Number.isFinite(amount) && starts
    ? ` Your next payment is ${formatMoneyCents(amount, params.currency)} on ${starts}.`
    : '';
  paragraphs.push(
    money
      ? [{ text: 'No charge today.', strong: true }, { text: money }]
      : [{ text: 'No charge today.', strong: true }],
  );

  // 3. Unconditional, and the reason this function exists as much as the date
  // formatting does: "am I about to lose the credits I paid for?" is what
  // people actually fear when they downgrade, and the old sentence never
  // answered it.
  paragraphs.push([
    { text: 'Your current credits are unaffected and keep their existing expiry dates.' },
  ]);

  return paragraphs;
}

/**
 * The confirmation as a plain string, for anything that cannot render segments.
 *
 * Derived from the parts above rather than written twice, so the two cannot
 * drift into saying different things.
 */
export function planDowngradeConfirmation(params: DowngradeConfirmationParams): string {
  return planDowngradeConfirmationParts(params)
    .map((paragraph) => paragraph.map((seg) => seg.text).join(''))
    .join('\n');
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
