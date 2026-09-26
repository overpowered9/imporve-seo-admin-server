/**
 * Every billing, credit and subscription email.
 *
 * ── THE RULE THESE ALL FOLLOW ───────────────────────────────────────────────
 * A template receives a payload and formats it. It does NOT compute money,
 * dates, plan names or balances — those are captured at enqueue time from the
 * billing event, so a receipt cannot drift from what was actually charged even
 * if the worker sends it hours later after an outage.
 *
 * Consequently every numeric field arrives as an ALREADY-FORMATTED string
 * ("$49.00", "October 18, 2026"). Templates that did their own arithmetic were
 * how a receipt and the confirmation dialog came to tell different stories.
 *
 * ── EVERY TEMPLATE RETURNS BOTH PARTS ───────────────────────────────────────
 * html and text, built from the same payload. The text part is not a courtesy:
 * mail without one scores worse with spam filters, and the broken receipt that
 * started this work was found in a spam folder.
 *
 * ── NEVER EMIT THE WORD "null" OR "undefined" ───────────────────────────────
 * The worker refuses to send any email whose subject or text contains them
 * (see unrenderedTokensIn). So an optional field is BRANCHED ON, never
 * interpolated with a fallback of `?? null`. That guard is what makes this
 * whole file safe to extend.
 */
import {
  emailShell, p, small, row, dataTable, callout, list, signoff, textBody, escapeHtml, BRAND,
} from './layout.js';

export interface RenderedEmail { subject: string; html: string; text: string }

/** Money/date rows shared by the receipt-shaped emails. */
export interface LineItem { description: string; amount: string }

const FOOTER_SUPPORT =
  'Questions about this charge? Reply to this email and a person will answer.';

const lineRows = (lines: LineItem[] | undefined): string =>
  (lines ?? []).map((l) => row(escapeHtml(l.description), escapeHtml(l.amount))).join('');

const lineText = (lines: LineItem[] | undefined): string[] =>
  (lines ?? []).map((l) => `  ${l.description}: ${l.amount}`);

/** "VISA ending 4242", or an honest generic when the card is not known. */
const cardLabel = (brand?: string | null, last4?: string | null): string =>
  last4 ? `${(brand || 'card').toUpperCase()} ending ${last4}` : 'your card on file';

// ═══════════════════════════════════════════════════════════════════════════
// Subscription lifecycle
// ═══════════════════════════════════════════════════════════════════════════

export interface PlanChangedPayload {
  firstName: string;
  /** null for a first subscription — the copy branches rather than saying "null". */
  oldPlan: string | null;
  newPlan: string;
  amountCharged: string;
  lines?: LineItem[];
  nextAmount: string | null;
  nextBillingDate: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  billingUrl: string;
  timezone?: string;
  /** Credits granted with this change, already worded. Optional. */
  creditsNote?: string | null;
}

/**
 * Upgrade / first subscription receipt.
 *
 * The proration breakdown mirrors what the confirmation dialog showed before
 * the click, so the receipt and the dialog cannot disagree.
 */
export const billingPlanChanged = (pl: PlanChangedPayload): RenderedEmail => {
  const tz = pl.timezone ? ` (${pl.timezone})` : '';
  const card = cardLabel(pl.cardBrand, pl.cardLast4);
  const isFirst = !pl.oldPlan;

  const heading = isFirst ? `Welcome to ${escapeHtml(pl.newPlan)}` : `You're now on ${escapeHtml(pl.newPlan)}`;

  const html = emailShell({
    heading,
    preheader: isFirst
      ? `Your ${pl.newPlan} plan is active and your credits are ready.`
      : `Moved from ${pl.oldPlan} to ${pl.newPlan}. Here's what you were charged.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(isFirst
        ? `Your <strong>${escapeHtml(pl.newPlan)}</strong> subscription is active. Your credits are already on your account, so you can start generating right away.`
        : `Your subscription has moved from <strong>${escapeHtml(pl.oldPlan!)}</strong> to <strong>${escapeHtml(pl.newPlan)}</strong>, effective immediately.`) +
      (pl.creditsNote ? callout(escapeHtml(pl.creditsNote)) : '') +
      dataTable(
        lineRows(pl.lines) +
        row('<strong>Charged today</strong>', `<strong>${escapeHtml(pl.amountCharged)}</strong>`, true) +
        (pl.nextAmount && pl.nextBillingDate
          ? row('Then', `${escapeHtml(pl.nextAmount)} on ${escapeHtml(pl.nextBillingDate)}${tz}`)
          : '') +
        row('Payment method', escapeHtml(card)),
      ),
    cta: { label: 'View billing history', url: pl.billingUrl },
    footnote: FOOTER_SUPPORT,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    isFirst
      ? `Your ${pl.newPlan} subscription is active. Your credits are already on your account.`
      : `Your subscription has moved from ${pl.oldPlan} to ${pl.newPlan}, effective immediately.`,
    '',
    pl.creditsNote || '',
    ...lineText(pl.lines),
    `Charged today: ${pl.amountCharged}`,
    pl.nextAmount && pl.nextBillingDate ? `Then ${pl.nextAmount} on ${pl.nextBillingDate}${tz}` : '',
    `Payment method: ${card}`,
    '',
    `View your billing history: ${pl.billingUrl}`,
    '',
    FOOTER_SUPPORT,
  ]);

  return {
    subject: isFirst ? `Your ${pl.newPlan} subscription is active` : `Your plan changed to ${pl.newPlan}`,
    html,
    text,
  };
};

export interface DowngradePayload {
  firstName: string;
  oldPlan: string;
  newPlan: string;
  /** When the new, cheaper plan actually starts. */
  effectiveDate: string;
  /** What they will pay then. */
  nextAmount: string;
  /** How credits are affected, already worded. */
  creditsNote: string;
  billingUrl: string;
  timezone?: string;
}

/**
 * Downgrade confirmation.
 *
 * Previously sent NOTHING: the receipt was guarded by `if (isUpgrade)`, so the
 * one plan change that REDUCES what someone gets was also the one we never
 * confirmed. That is the change most likely to be disputed later, and the
 * credits question ("do I lose what I already have?") is the first thing the
 * customer asks support.
 *
 * Deliberately not apologetic and with no win-back pitch — this is a receipt.
 */
export const billingDowngraded = (pl: DowngradePayload): RenderedEmail => {
  const tz = pl.timezone ? ` (${pl.timezone})` : '';

  const html = emailShell({
    heading: `Your plan changes to ${escapeHtml(pl.newPlan)}`,
    preheader: `${pl.oldPlan} → ${pl.newPlan}, effective ${pl.effectiveDate}. Nothing charged today.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`You've changed your subscription from <strong>${escapeHtml(pl.oldPlan)}</strong> to <strong>${escapeHtml(pl.newPlan)}</strong>.`) +
      callout(`You keep everything in <strong>${escapeHtml(pl.oldPlan)}</strong> until <strong>${escapeHtml(pl.effectiveDate)}${tz}</strong>. You've already paid for this period, so nothing is charged today and nothing changes before then.`) +
      dataTable(
        row('New plan', escapeHtml(pl.newPlan)) +
        row('Starts', `${escapeHtml(pl.effectiveDate)}${tz}`) +
        row('Charged today', 'Nothing') +
        row('<strong>From then</strong>', `<strong>${escapeHtml(pl.nextAmount)}</strong>`, true),
      ) +
      p(escapeHtml(pl.creditsNote)) +
      small(`Changed your mind? Switch back any time before ${escapeHtml(pl.effectiveDate)} and this never takes effect.`),
    cta: { label: 'Manage subscription', url: pl.billingUrl },
    footnote: FOOTER_SUPPORT,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `You've changed your subscription from ${pl.oldPlan} to ${pl.newPlan}.`,
    '',
    `You keep everything in ${pl.oldPlan} until ${pl.effectiveDate}${tz}. Nothing is charged today.`,
    '',
    `New plan: ${pl.newPlan}`,
    `Starts: ${pl.effectiveDate}${tz}`,
    `Charged today: Nothing`,
    `From then: ${pl.nextAmount}`,
    '',
    pl.creditsNote,
    '',
    `Changed your mind? Switch back any time before ${pl.effectiveDate}.`,
    `Manage your subscription: ${pl.billingUrl}`,
  ]);

  return { subject: `Your plan changes to ${pl.newPlan} on ${pl.effectiveDate}`, html, text };
};

export interface CancelledPayload {
  firstName: string;
  planName: string;
  accessUntil: string;
  creditsNote: string;
  resubscribeUrl: string;
  billingUrl: string;
  timezone?: string;
}

/** Cancellation confirmation — the email customers most expect to receive. */
export const billingCancelled = (pl: CancelledPayload): RenderedEmail => {
  const tz = pl.timezone ? ` (${pl.timezone})` : '';

  const html = emailShell({
    heading: 'Your subscription is set to end',
    preheader: `You keep full ${pl.planName} access until ${pl.accessUntil}.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`Your <strong>${escapeHtml(pl.planName)}</strong> subscription has been cancelled. Nothing further will be charged.`) +
      callout(`You keep full access until <strong>${escapeHtml(pl.accessUntil)}${tz}</strong>.`) +
      p(escapeHtml(pl.creditsNote)) +
      p(`Changed your mind? Reactivate any time before that date and nothing will be charged — your account carries on as if nothing happened.`),
    cta: { label: 'Reactivate my plan', url: pl.resubscribeUrl },
    footnote: `If you cancelled because something wasn't working, reply and tell us — we read every one of these.`,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `Your ${pl.planName} subscription has been cancelled. Nothing further will be charged.`,
    `You keep full access until ${pl.accessUntil}${tz}.`,
    '',
    pl.creditsNote,
    '',
    `Changed your mind? Reactivate any time before that date: ${pl.resubscribeUrl}`,
    `Billing history: ${pl.billingUrl}`,
    '',
    `If you cancelled because something wasn't working, reply and tell us.`,
  ]);

  return { subject: `Your ${pl.planName} subscription ends ${pl.accessUntil}`, html, text };
};

export interface PausePayload {
  firstName: string;
  planName: string;
  /** Worded date, or null when the pause is open-ended. */
  resumesOn: string | null;
  creditsNote: string;
  billingUrl: string;
}

/** Subscription paused. */
export const billingPaused = (pl: PausePayload): RenderedEmail => {
  const resumeLine = pl.resumesOn
    ? `Billing restarts automatically on <strong>${escapeHtml(pl.resumesOn)}</strong>.`
    : `Billing stays paused until you resume it — there's no automatic restart date.`;

  const html = emailShell({
    heading: 'Your subscription is paused',
    preheader: pl.resumesOn ? `No charges until ${pl.resumesOn}.` : `No charges until you resume.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`Your <strong>${escapeHtml(pl.planName)}</strong> subscription is paused. You won't be charged while it stays that way.`) +
      callout(resumeLine) +
      p(escapeHtml(pl.creditsNote)) +
      p(`You can resume any time — it takes one click and picks up exactly where you left off.`),
    cta: { label: 'Resume my subscription', url: pl.billingUrl },
    footnote: FOOTER_SUPPORT,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `Your ${pl.planName} subscription is paused. You won't be charged while it stays that way.`,
    pl.resumesOn ? `Billing restarts automatically on ${pl.resumesOn}.` : `Billing stays paused until you resume it.`,
    '',
    pl.creditsNote,
    '',
    `Resume any time: ${pl.billingUrl}`,
  ]);

  return { subject: `Your ${pl.planName} subscription is paused`, html, text };
};

export interface ResumePayload {
  firstName: string;
  planName: string;
  nextAmount: string;
  nextBillingDate: string;
  creditsNote: string;
  billingUrl: string;
  timezone?: string;
}

/** Subscription resumed. */
export const billingResumed = (pl: ResumePayload): RenderedEmail => {
  const tz = pl.timezone ? ` (${pl.timezone})` : '';

  const html = emailShell({
    heading: 'Your subscription is active again',
    preheader: `${pl.planName} is back on. Next charge ${pl.nextAmount} on ${pl.nextBillingDate}.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`Welcome back — your <strong>${escapeHtml(pl.planName)}</strong> subscription is active again.`) +
      dataTable(
        row('Plan', escapeHtml(pl.planName)) +
        row('<strong>Next charge</strong>', `<strong>${escapeHtml(pl.nextAmount)} on ${escapeHtml(pl.nextBillingDate)}${tz}</strong>`, true),
      ) +
      p(escapeHtml(pl.creditsNote)),
    cta: { label: 'Go to my dashboard', url: pl.billingUrl },
    footnote: FOOTER_SUPPORT,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `Welcome back — your ${pl.planName} subscription is active again.`,
    '',
    `Plan: ${pl.planName}`,
    `Next charge: ${pl.nextAmount} on ${pl.nextBillingDate}${tz}`,
    '',
    pl.creditsNote,
    '',
    `Dashboard: ${pl.billingUrl}`,
  ]);

  return { subject: `Your ${pl.planName} subscription is active again`, html, text };
};

// ═══════════════════════════════════════════════════════════════════════════
// Money in, money out
// ═══════════════════════════════════════════════════════════════════════════

export interface CreditPurchasePayload {
  firstName: string;
  /** e.g. "Starter pack — 20 pieces of content". */
  packName: string;
  creditsAdded: string;
  /** Balance AFTER the purchase, already worded. */
  newBalance: string;
  amountCharged: string;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Stripe's hosted receipt, when the event carried one. */
  receiptUrl?: string | null;
  /** When these credits lapse. Purchased credits last 12 months. */
  expiresOn: string | null;
  creditsUrl: string;
}

/**
 * Credit pack receipt.
 *
 * Sent NOTHING before this. A customer could be charged for a pack and receive
 * no confirmation of any kind — the single largest source of "did my payment
 * go through?" tickets, and in most jurisdictions a receipt is not optional.
 *
 * States the expiry date on the receipt rather than only in the expiry warning
 * email, because "I didn't know they expired" is not a defensible position when
 * the purchase confirmation could have said so.
 */
export const creditPurchase = (pl: CreditPurchasePayload): RenderedEmail => {
  const card = cardLabel(pl.cardBrand, pl.cardLast4);

  const html = emailShell({
    heading: 'Your credits are ready',
    preheader: `${pl.creditsAdded} added. New balance: ${pl.newBalance}.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`Thanks — your purchase went through and <strong>${escapeHtml(pl.creditsAdded)}</strong> have been added to your account.`) +
      dataTable(
        row(escapeHtml(pl.packName), escapeHtml(pl.amountCharged)) +
        row('Credits added', escapeHtml(pl.creditsAdded)) +
        row('<strong>New balance</strong>', `<strong>${escapeHtml(pl.newBalance)}</strong>`, true) +
        (pl.expiresOn ? row('Use them by', escapeHtml(pl.expiresOn)) : '') +
        row('Payment method', escapeHtml(card)),
      ) +
      (pl.receiptUrl ? small(`A detailed receipt is available <a href="${pl.receiptUrl}" style="color:${BRAND.teal};">here</a>.`) : ''),
    cta: { label: 'Start generating', url: pl.creditsUrl },
    footnote: FOOTER_SUPPORT,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `Thanks — your purchase went through and ${pl.creditsAdded} have been added to your account.`,
    '',
    `${pl.packName}: ${pl.amountCharged}`,
    `Credits added: ${pl.creditsAdded}`,
    `New balance: ${pl.newBalance}`,
    pl.expiresOn ? `Use them by: ${pl.expiresOn}` : '',
    `Payment method: ${card}`,
    '',
    pl.receiptUrl ? `Detailed receipt: ${pl.receiptUrl}` : '',
    `Go to your account: ${pl.creditsUrl}`,
    '',
    FOOTER_SUPPORT,
  ]);

  return { subject: `Receipt: ${pl.creditsAdded} added to your account`, html, text };
};

export interface RenewalPayload {
  firstName: string;
  planName: string;
  amountCharged: string;
  periodLabel: string;
  creditsNote: string;
  nextBillingDate: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  receiptUrl?: string | null;
  billingUrl: string;
  timezone?: string;
}

/**
 * Renewal receipt.
 *
 * Quiet by design: a recurring charge the customer expects needs to be
 * confirmed, not celebrated. No CTA fanfare, no upsell — the job is to be
 * findable in a search six months later when someone reconciles a statement.
 */
export const renewalReceipt = (pl: RenewalPayload): RenderedEmail => {
  const tz = pl.timezone ? ` (${pl.timezone})` : '';
  const card = cardLabel(pl.cardBrand, pl.cardLast4);

  const html = emailShell({
    heading: `${escapeHtml(pl.planName)} renewed`,
    preheader: `${pl.amountCharged} charged. Your credits have been topped back up.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`Your <strong>${escapeHtml(pl.planName)}</strong> plan renewed for ${escapeHtml(pl.periodLabel)}.`) +
      dataTable(
        row(`${escapeHtml(pl.planName)} — ${escapeHtml(pl.periodLabel)}`, escapeHtml(pl.amountCharged)) +
        row('<strong>Charged</strong>', `<strong>${escapeHtml(pl.amountCharged)}</strong>`, true) +
        (pl.nextBillingDate ? row('Next charge', `${escapeHtml(pl.nextBillingDate)}${tz}`) : '') +
        row('Payment method', escapeHtml(card)),
      ) +
      p(escapeHtml(pl.creditsNote)) +
      (pl.receiptUrl ? small(`A detailed receipt is available <a href="${pl.receiptUrl}" style="color:${BRAND.teal};">here</a>.`) : ''),
    cta: { label: 'View billing history', url: pl.billingUrl },
    footnote: FOOTER_SUPPORT,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `Your ${pl.planName} plan renewed for ${pl.periodLabel}.`,
    '',
    `${pl.planName} — ${pl.periodLabel}: ${pl.amountCharged}`,
    `Charged: ${pl.amountCharged}`,
    pl.nextBillingDate ? `Next charge: ${pl.nextBillingDate}${tz}` : '',
    `Payment method: ${card}`,
    '',
    pl.creditsNote,
    '',
    pl.receiptUrl ? `Detailed receipt: ${pl.receiptUrl}` : '',
    `Billing history: ${pl.billingUrl}`,
  ]);

  return { subject: `Receipt: ${pl.planName} renewed — ${pl.amountCharged}`, html, text };
};

export interface RefundPayload {
  firstName: string;
  amountRefunded: string;
  /** What the refund was for, already worded. */
  reasonLabel: string;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Banks take days; saying so prevents the "where is it?" follow-up. */
  arrivalWindow: string;
  creditsNote: string | null;
  billingUrl: string;
}

/** Refund confirmation. */
export const refundIssued = (pl: RefundPayload): RenderedEmail => {
  const card = cardLabel(pl.cardBrand, pl.cardLast4);

  const html = emailShell({
    heading: `${escapeHtml(pl.amountRefunded)} refunded`,
    preheader: `On its way back to ${card}. Expect it ${pl.arrivalWindow}.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`We've refunded <strong>${escapeHtml(pl.amountRefunded)}</strong> for ${escapeHtml(pl.reasonLabel)}.`) +
      dataTable(
        row('Refund amount', escapeHtml(pl.amountRefunded)) +
        row('Back to', escapeHtml(card)) +
        row('<strong>Expected</strong>', `<strong>${escapeHtml(pl.arrivalWindow)}</strong>`, true),
      ) +
      (pl.creditsNote ? p(escapeHtml(pl.creditsNote)) : '') +
      small(`The exact timing is up to your bank, not us. If it hasn't appeared after that window, reply to this email and we'll chase it with you.`),
    cta: { label: 'View billing history', url: pl.billingUrl },
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `We've refunded ${pl.amountRefunded} for ${pl.reasonLabel}.`,
    '',
    `Refund amount: ${pl.amountRefunded}`,
    `Back to: ${card}`,
    `Expected: ${pl.arrivalWindow}`,
    '',
    pl.creditsNote || '',
    `The exact timing is up to your bank. If it hasn't appeared after that window, reply and we'll chase it.`,
    '',
    `Billing history: ${pl.billingUrl}`,
  ]);

  return { subject: `Refund issued: ${pl.amountRefunded}`, html, text };
};

export interface PaymentFailedPayload {
  firstName: string;
  planName: string;
  amountDue: string;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Which attempt this was — drives how urgent the copy is. */
  attemptNumber: number;
  /** When Stripe will try again, or null when this was the last attempt. */
  nextAttemptDate: string | null;
  /** When access actually stops, if they do nothing. */
  accessEndsOn: string | null;
  updatePaymentUrl: string;
  /** Stripe's hosted invoice, where they can pay immediately. */
  invoiceUrl?: string | null;
  /**
   * What has ALREADY happened to their credits, in our words.
   *
   * Not optional decoration. This product suspends plan credits on the FIRST
   * failure, before Stripe has finished retrying — so copy saying "your credits
   * will stop if this isn't fixed" would be describing a future that already
   * arrived, and the customer is reading the email precisely because their
   * credits stopped working. The caller states the truth; the template shows it.
   */
  creditsNote?: string | null;
}

/**
 * Payment failed — the dunning email.
 *
 * Sent NOTHING before this. `invoice.payment_failed` updated our records
 * silently, so the first a customer knew of it was their credits not working.
 * A failed card is almost always an expiry or a bank block, not a decision —
 * treating it as a billing emergency the customer chose is both wrong and
 * expensive.
 *
 * ── WHY THE TONE ESCALATES BY ATTEMPT ───────────────────────────────────────
 * A first failure is routine and the copy says so. The final attempt is the
 * only one that leads with what will be lost, because by then it is true and a
 * customer who ignored two gentle emails needs the actual consequence. Sending
 * the same alarming email three times trains people to ignore all three.
 */
export const paymentFailed = (pl: PaymentFailedPayload): RenderedEmail => {
  const card = cardLabel(pl.cardBrand, pl.cardLast4);
  const isFinal = pl.nextAttemptDate === null;

  const heading = isFinal ? 'Last try: your payment failed' : 'We couldn\'t process your payment';

  const openingLine = isFinal
    ? `We've tried <strong>${escapeHtml(card)}</strong> ${pl.attemptNumber} times and it hasn't gone through. This was the last automatic attempt.`
    : `We tried to charge <strong>${escapeHtml(card)}</strong> for your <strong>${escapeHtml(pl.planName)}</strong> plan and it didn't go through. This happens most often when a card has expired or a bank has flagged the payment — it usually takes a minute to sort out.`;

  const consequence = pl.accessEndsOn
    ? (isFinal
      ? `Without a working payment method, your <strong>${escapeHtml(pl.planName)}</strong> plan ends on <strong>${escapeHtml(pl.accessEndsOn)}</strong>.`
      : `If it still hasn't gone through by <strong>${escapeHtml(pl.accessEndsOn)}</strong>, your plan will end and your plan credits will stop being renewed.`)
    : `Until it goes through, your plan credits won't renew.`;

  const html = emailShell({
    heading,
    preheader: `${pl.amountDue} for ${pl.planName} didn't go through. Updating your card takes a minute.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(openingLine) +
      dataTable(
        row('Plan', escapeHtml(pl.planName)) +
        row('<strong>Amount due</strong>', `<strong>${escapeHtml(pl.amountDue)}</strong>`, true) +
        row('Card', escapeHtml(card)) +
        (pl.nextAttemptDate ? row('We\'ll try again', escapeHtml(pl.nextAttemptDate)) : ''),
      ) +
      callout(consequence, isFinal ? 'warning' : 'accent') +
      (pl.creditsNote ? p(escapeHtml(pl.creditsNote)) : '') +
      p(`Updating your card fixes it immediately — we'll retry the charge as soon as you do.`) +
      (pl.invoiceUrl ? small(`You can also <a href="${pl.invoiceUrl}" style="color:${BRAND.teal};">pay this invoice directly</a>.`) : ''),
    cta: { label: 'Update payment method', url: pl.updatePaymentUrl },
    footnote: `Already fixed it? You can ignore this — nothing else is needed.`,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    isFinal
      ? `We've tried ${card} ${pl.attemptNumber} times and it hasn't gone through. This was the last automatic attempt.`
      : `We tried to charge ${card} for your ${pl.planName} plan and it didn't go through. This is usually an expired card or a bank block.`,
    '',
    `Plan: ${pl.planName}`,
    `Amount due: ${pl.amountDue}`,
    `Card: ${card}`,
    pl.nextAttemptDate ? `We'll try again: ${pl.nextAttemptDate}` : '',
    '',
    pl.accessEndsOn
      ? (isFinal
        ? `Without a working payment method, your ${pl.planName} plan ends on ${pl.accessEndsOn}.`
        : `If it still hasn't gone through by ${pl.accessEndsOn}, your plan will end.`)
      : `Until it goes through, your plan credits won't renew.`,
    '',
    pl.creditsNote || '',
    `Update your card: ${pl.updatePaymentUrl}`,
    pl.invoiceUrl ? `Or pay this invoice directly: ${pl.invoiceUrl}` : '',
    '',
    `Already fixed it? You can ignore this.`,
  ]);

  return {
    subject: isFinal
      ? `Action needed: last attempt to charge your card failed`
      : `Your payment didn't go through — ${pl.amountDue}`,
    html,
    text,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle (suppressible by a marketing opt-out — see suppressionReason)
// ═══════════════════════════════════════════════════════════════════════════

export interface CreditExpiryPayload {
  firstName: string;
  /** Already worded, e.g. "214 plan credits". */
  expiringAmount: string;
  expiryDate: string;
  remainingAfter: string;
  ctaUrl: string;
  leadTimeLabel: string;
  /** Complete articles-with-image the expiring balance would buy. */
  pieces?: number;
  planExpiring?: number;
  purchasedExpiring?: number;
  unsubscribeUrl?: string | null;
}

/**
 * Credits about to expire. Final copy — this replaced a [PLACEHOLDER] template
 * that was one account away from reaching a customer.
 *
 * Leads with what the credits would BUY rather than the number, because "214
 * credits" means nothing to someone who has not memorised the pricing table,
 * and "about 7 complete articles" is the same fact in a form that prompts
 * action.
 */
export const creditsExpiring = (pl: CreditExpiryPayload): RenderedEmail => {
  const piecesLine = typeof pl.pieces === 'number' && pl.pieces > 0
    ? `That's about <strong>${pl.pieces} complete ${pl.pieces === 1 ? 'article' : 'articles'}</strong>, images included.`
    : '';

  const whyLine = pl.purchasedExpiring && pl.planExpiring
    ? `Plan credits lapse at the end of each billing cycle; purchased credits last twelve months from the day you bought them.`
    : pl.purchasedExpiring
      ? `Purchased credits last twelve months from the day you bought them.`
      : `Plan credits lapse at the end of each billing cycle and are replaced by your next allowance.`;

  const html = emailShell({
    heading: pl.leadTimeLabel === 'today' ? 'Your credits expire today' : `Your credits expire ${escapeHtml(pl.leadTimeLabel)}`,
    preheader: `${pl.expiringAmount} expire on ${pl.expiryDate}. ${pl.remainingAfter} will remain.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`You have <strong>${escapeHtml(pl.expiringAmount)}</strong> expiring on <strong>${escapeHtml(pl.expiryDate)}</strong>. ${piecesLine}`) +
      callout(`After they expire you'll have <strong>${escapeHtml(pl.remainingAfter)}</strong> left.`) +
      p(whyLine) +
      p(`If you've been meaning to get a batch of pages done, now is the moment — generating takes a few minutes and the credits are already paid for.`),
    cta: { label: 'Use my credits', url: pl.ctaUrl },
    unsubscribeUrl: pl.unsubscribeUrl,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `You have ${pl.expiringAmount} expiring on ${pl.expiryDate}.`,
    typeof pl.pieces === 'number' && pl.pieces > 0
      ? `That's about ${pl.pieces} complete ${pl.pieces === 1 ? 'article' : 'articles'}, images included.` : '',
    '',
    `After they expire you'll have ${pl.remainingAfter} left.`,
    '',
    whyLine.replace(/<[^>]+>/g, ''),
    '',
    `Use your credits: ${pl.ctaUrl}`,
  ]);

  return {
    subject: pl.leadTimeLabel === 'today'
      ? `Your ${pl.expiringAmount} expire today`
      : `Your ${pl.expiringAmount} expire ${pl.leadTimeLabel}`,
    html,
    text,
  };
};

export interface InactivityPayload {
  firstName: string;
  creditBalance: string;
  nearestExpiry: string | null;
  planName: string;
  ctaUrl: string;
  pieces?: number;
  daysInactive?: number;
  unsubscribeUrl?: string | null;
}

/**
 * Inactivity nudge — paid credits sitting unused.
 *
 * Deliberately short and free of guilt. The reader already knows they haven't
 * used it; the useful thing is to remove whatever friction stopped them, which
 * is why this offers the reply rather than another feature tour.
 */
export const inactivityNudge = (pl: InactivityPayload): RenderedEmail => {
  const piecesLine = typeof pl.pieces === 'number' && pl.pieces > 0
    ? ` — around <strong>${pl.pieces} complete ${pl.pieces === 1 ? 'article' : 'articles'}</strong>`
    : '';

  const html = emailShell({
    heading: 'Your credits are waiting',
    preheader: `${pl.creditBalance} sitting unused on your ${pl.planName} account.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`You have <strong>${escapeHtml(pl.creditBalance)}</strong>${piecesLine} on your ${escapeHtml(pl.planName)} account, and they haven't been touched in a while.`) +
      (pl.nearestExpiry ? callout(`The first of them expire on <strong>${escapeHtml(pl.nearestExpiry)}</strong>.`) : '') +
      p(`If you got stuck somewhere, reply to this email and tell me where — I read these myself and it's the fastest way to get it unstuck.`) +
      signoff(),
    cta: { label: 'Create a page', url: pl.ctaUrl },
    unsubscribeUrl: pl.unsubscribeUrl,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `You have ${pl.creditBalance} on your ${pl.planName} account, and they haven't been touched in a while.`,
    pl.nearestExpiry ? `The first of them expire on ${pl.nearestExpiry}.` : '',
    '',
    `If you got stuck somewhere, reply and tell me where — I read these myself.`,
    '',
    `Create a page: ${pl.ctaUrl}`,
    '',
    `Best,`,
    `Nathan`,
    `CEO, ImproveSEO`,
  ]);

  return { subject: `You have ${pl.creditBalance} waiting`, html, text };
};

export interface TrialEndedPayload {
  firstName: string;
  ctaUrl: string;
  /** What they made during the trial, when we know it. */
  pagesCreated?: number;
  /** Credits left on the free plan, already worded. */
  freeBalance?: string | null;
  unsubscribeUrl?: string | null;
}

/**
 * Trial ended, account moved to Free.
 *
 * Says what changed and what still works, in that order. A trial-ended email
 * that only sells the upgrade reads as a gate; one that first confirms nothing
 * was lost is the one people actually act on.
 */
export const trialEnded = (pl: TrialEndedPayload): RenderedEmail => {
  const madeLine = typeof pl.pagesCreated === 'number' && pl.pagesCreated > 0
    ? p(`You created <strong>${pl.pagesCreated} ${pl.pagesCreated === 1 ? 'page' : 'pages'}</strong> during your trial — those stay exactly where they are, live and yours.`)
    : p(`Anything you created during the trial stays exactly where it is, live and yours.`);

  const html = emailShell({
    heading: 'Your free trial has ended',
    preheader: `Your account moved to the Free plan. Everything you created is still there.`,
    body:
      p(`Hi ${escapeHtml(pl.firstName)},`) +
      p(`Your seven-day trial has finished and your account has moved to the <strong>Free</strong> plan. Nothing was deleted and you weren't charged.`) +
      madeLine +
      (pl.freeBalance ? callout(`You have <strong>${escapeHtml(pl.freeBalance)}</strong> on the Free plan.`) : '') +
      p(`On a paid plan you get a monthly credit allowance, bulk generation, and the keyword tools — pick the smallest one that fits and change it whenever you like.`) +
      signoff(),
    cta: { label: 'See the plans', url: pl.ctaUrl },
    unsubscribeUrl: pl.unsubscribeUrl,
  });

  const text = textBody([
    `Hi ${pl.firstName},`,
    '',
    `Your seven-day trial has finished and your account has moved to the Free plan. Nothing was deleted and you weren't charged.`,
    '',
    typeof pl.pagesCreated === 'number' && pl.pagesCreated > 0
      ? `You created ${pl.pagesCreated} ${pl.pagesCreated === 1 ? 'page' : 'pages'} during your trial — those stay live and yours.`
      : `Anything you created during the trial stays live and yours.`,
    pl.freeBalance ? `You have ${pl.freeBalance} on the Free plan.` : '',
    '',
    `On a paid plan you get a monthly credit allowance, bulk generation, and the keyword tools.`,
    '',
    `See the plans: ${pl.ctaUrl}`,
    '',
    `Best,`,
    `Nathan`,
    `CEO, ImproveSEO`,
  ]);

  return { subject: `Your trial has ended — here's what happens now`, html, text };
};

/**
 * The public registry.
 *
 * Kept as one object because the worker's RENDERERS map and several call sites
 * import it by name. The individual functions are exported too, for tests that
 * want to render one without going through the registry.
 */
export const billingEmailTemplates = {
  billingPlanChanged,
  billingDowngraded,
  billingCancelled,
  billingPaused,
  billingResumed,
  creditPurchase,
  renewalReceipt,
  refundIssued,
  paymentFailed,
  creditsExpiring,
  inactivityNudge,
  trialEnded,
};
