/**
 * Where the billing period lives on a Stripe subscription.
 *
 * ── THE BUG THIS EXISTS TO END ──────────────────────────────────────────────
 * Five places read the period end like this:
 *
 *     const nextBillingTimestamp = (subscription as any).current_period_end
 *       || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
 *
 * On API version 2025-10-29.clover — the version this codebase pins —
 * `current_period_end` NO LONGER EXISTS on the Subscription object. It moved
 * onto each subscription ITEM, because items can now bill on different
 * schedules. Read from a live subscription:
 *
 *     sub.current_period_end   = undefined
 *     item.current_period_end  = 1790409310   (2026-09-26T07:55:10Z)
 *
 * So that expression was `undefined || now + 30 days` every single time, and
 * every stored next_billing_date became "whenever we last wrote this row, plus
 * thirty days" instead of Stripe's anchor. Every active subscription in
 * production was a day early, because a calendar month is 31 days and 30 is not.
 *
 * One of those five sites is the customer.subscription.updated webhook, which
 * fires on every plan change — so each upgrade pushed the stored date another
 * thirty days out from that moment. The customer-facing symptom was an upgrade
 * modal quoting "the 30 days left in this period" and "starting Sep 28" beside
 * amounts Stripe had prorated against a period ending Sep 26. The amounts were
 * right; the dates around them were not, and the mismatch made correct cents
 * look like a miscalculation.
 *
 * ── WHY THERE IS NO ARITHMETIC FALLBACK ─────────────────────────────────────
 * `now + 30 days` is not a fallback, it is a fabricated billing date, and
 * fabricating one is precisely what caused this. It also fails silently and
 * plausibly: nobody notices a date that is only a day out until a customer
 * reads it back to you.
 *
 * So this returns null when Stripe told us nothing, logs at error level, and
 * leaves the caller to keep whatever it already had. A stale date is recoverable
 * — the next webhook corrects it. An invented one is indistinguishable from a
 * real one, and gets written to the database as though it were.
 */
import type Stripe from 'stripe';

/** A subscription-shaped object. Loosely typed: webhook payloads arrive raw. */
type SubscriptionLike = Stripe.Subscription | Record<string, any>;

const asTimestamp = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

/**
 * The end of the current billing period, in unix SECONDS, or null.
 *
 * Items first (2025-10-29.clover and later), then the pre-2025 top-level field
 * so an older payload — a replayed webhook, a fixture written before the version
 * bump — still reads correctly.
 *
 * The MAXIMUM across items, not the first: with multiple items the subscription
 * renews when the last of them does, and the first item's period is only the
 * right answer by accident of ordering.
 */
export function periodEndOf(subscription: SubscriptionLike | null | undefined): number | null {
  if (!subscription) return null;

  const items: any[] = (subscription as any)?.items?.data ?? [];
  const itemEnds = items
    .map((item) => asTimestamp(item?.current_period_end))
    .filter((end): end is number => end !== null);
  if (itemEnds.length > 0) return Math.max(...itemEnds);

  return asTimestamp((subscription as any).current_period_end);
}

/**
 * The START of the current billing period, in unix SECONDS, or null.
 *
 * Same shape rules as periodEndOf. The MINIMUM across items, because the period
 * a proration has to fall inside began when the earliest item's did. Upgrade
 * proration is aligned to whole days counted from here — see
 * dayAlignedProrationDate.
 */
export function periodStartOf(subscription: SubscriptionLike | null | undefined): number | null {
  if (!subscription) return null;

  const items: any[] = (subscription as any)?.items?.data ?? [];
  const itemStarts = items
    .map((item) => asTimestamp(item?.current_period_start))
    .filter((start): start is number => start !== null);
  if (itemStarts.length > 0) return Math.min(...itemStarts);

  return asTimestamp((subscription as any).current_period_start);
}

/**
 * The same, but loud about coming back empty.
 *
 * Callers write this to next_billing_date, so "we could not tell" has to be
 * visible in the logs — that is the state where a customer is shown a date
 * nobody set. The subscription id is included because the recovery is to read
 * the period off that subscription by hand.
 */
export function periodEndOrWarn(
  subscription: SubscriptionLike | null | undefined,
  context = 'subscription',
): number | null {
  const end = periodEndOf(subscription);
  if (end === null) {
    const id = (subscription as any)?.id ?? 'unknown';
    console.error(
      `🚨 No billing period on ${context} ${id} — neither items[].current_period_end nor the ` +
      'legacy top-level field. next_billing_date is being left as it stands rather than guessed.',
    );
  }
  return end;
}
