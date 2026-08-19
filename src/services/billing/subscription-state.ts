/**
 * Subscription state, and the banner derived from it.  (BILL-005)
 *
 * ── WHY THE BANNER IS COMPUTED, NOT STORED ──────────────────────────────────
 * The reported bug: cancel Optimize, subscribe to Scale, and "Cancellation
 * Scheduled: Access continues until Sep 2, 2026." is still on screen.
 *
 * The ticket asks for the banner to be derived from current state rather than
 * from a flag someone forgot to reset, and that is right — but it is worth
 * being precise about what was actually broken, because the CMS was ALREADY
 * deriving it (`isCancelling = !!subscription.cancel_at_period_end`). The stale
 * banner was not a frontend caching bug. The flag itself was genuinely still
 * true in our database and at Stripe, because:
 *
 *   • Re-picking the SAME plan while cancelling priced as equal, so isUpgrade
 *     was false, so it fell into the DOWNGRADE branch: it queued a pointless
 *     pending_plan change and never cleared cancel_at_period_end. (Fixed in an
 *     earlier round, but it is the origin of the report.)
 *   • Choosing a DIFFERENT plan cleared the flag on the subscription — but left
 *     any subscription SCHEDULE object in place at Stripe. A schedule is a
 *     separate object that can carry its own cancellation, and it survives a
 *     subscriptions.update. That is the silent failure the ticket flags: the
 *     banner goes away, and then months later the subscription cancels itself.
 *
 * So the fix is two-part: derive the banner from one predicate everywhere
 * (below), and release orphaned schedules at the provider (releaseOrphanedSchedules).
 *
 * ── THE PREDICATE ───────────────────────────────────────────────────────────
 * Show the banner only when an ACTIVE subscription carries a pending
 * cancellation whose effective date is in the future. Each clause earns its
 * place — see the tests, which cover the inverse bug too (a genuine
 * cancellation that fails to show).
 */
import type Stripe from 'stripe';
import type { SqlLike } from './payment-methods.js';

/**
 * The statuses under which a paid plan is still RUNNING.
 *
 * ── WHY THIS IS A SHARED CONSTANT ───────────────────────────────────────────
 * This set has now been got wrong FOUR separate times, each time by someone
 * writing the list out again and omitting a member:
 *
 *   • `trialing` omitted → a customer who upgraded mid-trial was labelled
 *     "Free Trial" and shown free-tier wording on a paid plan.
 *   • `pending_downgrade` omitted in the CMS → a cancelled subscription read
 *     "NEXT BILLING" instead of "PLAN ENDS", offered Cancel on something
 *     already cancelling, and hid the only route back (Reactivate).
 *   • `pending_downgrade` omitted in the credit-expiry job → warnings timed off
 *     the credit cycle instead of the real billing date.
 *   • `pending_downgrade` omitted below → the cancellation banner vanished for
 *     anyone holding a queued downgrade.
 *
 * Four bugs, one cause: a list that is data was written as a literal, four
 * times. Every consumer imports THIS now, so adding a status is one edit rather
 * than a hunt for copies.
 *
 * `pending_downgrade` belongs here — the plan runs normally, only its FUTURE
 * plan is settled. `past_due` belongs — the plan has not lapsed, a payment
 * failed. Ended states live in ENDED_SUBSCRIPTION_STATUSES.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = Object.freeze([
  'active',
  'trialing',
  'past_due',
  'pending_downgrade',
]);

/** Statuses meaning the plan is no longer running. */
export const ENDED_SUBSCRIPTION_STATUSES: readonly string[] = Object.freeze([
  'cancelled',
  'canceled',
  'paused',
]);

/** Is this subscription still running? Case-insensitive and null-safe. */
export const isLiveStatus = (status: string | null | undefined): boolean =>
  LIVE_SUBSCRIPTION_STATUSES.includes(String(status || '').trim().toLowerCase());

export interface SubscriptionStateInput {
  status?: string | null;
  cancel_at_period_end?: boolean | null;
  next_billing_date?: string | Date | null;
  cancelled_at?: string | Date | null;
}

export interface CancellationBanner {
  visible: boolean;
  /** ISO instant access ends. Null when the banner is not shown. */
  accessUntil: string | null;
  reason: string;
}

/**
 * Should the "Cancellation Scheduled" banner be shown?
 *
 * `now` is injectable so the boundary cases can be tested without waiting.
 */
export function deriveCancellationBanner(
  sub: SubscriptionStateInput | null | undefined,
  now: Date = new Date(),
): CancellationBanner {
  const hide = (reason: string): CancellationBanner => ({ visible: false, accessUntil: null, reason });

  if (!sub) return hide('no subscription');

  // A subscription that has already ended is not "scheduled to cancel" — it is
  // cancelled. Showing a future-tense banner there is the inverse error.
  const status = (sub.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return hide('already cancelled');
  // Uses the shared set — this line previously spelled the statuses out and
  // omitted `pending_downgrade`, so a user who cancelled and then queued a
  // downgrade saw no cancellation banner at all.
  if (!isLiveStatus(status)) {
    return hide(`status is ${status || 'unknown'}`);
  }

  if (!sub.cancel_at_period_end) return hide('no cancellation scheduled');

  // A cancellation with no end date cannot be described honestly. Say nothing
  // rather than inventing a date, and let the subscription status speak.
  if (!sub.next_billing_date) return hide('no effective date');

  const endsAt = new Date(sub.next_billing_date);
  if (Number.isNaN(endsAt.getTime())) return hide('unparseable effective date');

  // The date has passed but the row still says active: the deletion webhook has
  // not landed yet. "Access continues until [yesterday]" is worse than silence.
  if (endsAt.getTime() <= now.getTime()) return hide('effective date already passed');

  return {
    visible: true,
    accessUntil: endsAt.toISOString(),
    reason: 'active subscription with a future scheduled cancellation',
  };
}

/**
 * Release any subscription schedule left attached to a customer.
 *
 * THE DANGEROUS SILENT FAILURE. A Stripe subscription schedule is a separate
 * object from the subscription. Setting cancel_at_period_end = false on the
 * subscription does NOT touch a schedule, and a schedule whose final phase ends
 * the subscription will still end it — weeks or months later, with the customer
 * having every reason to believe they resubscribed.
 *
 * Called on every resubscribe path. Returns the ids released, so the caller can
 * log that it happened; silence here would make an important repair invisible.
 *
 * Never throws: a subscription that IS running must not be blocked because a
 * cleanup call failed. Failures are logged loudly because an unreleased
 * schedule is a future outage for that customer.
 */
export async function releaseOrphanedSchedules(
  stripe: Pick<Stripe, 'subscriptionSchedules'> | any,
  customerId: string,
): Promise<string[]> {
  const released: string[] = [];
  try {
    const schedules = await stripe.subscriptionSchedules.list({ customer: customerId });
    for (const schedule of schedules?.data ?? []) {
      // 'released' and 'canceled' schedules are already inert. Releasing a
      // completed one errors, so skip them rather than generating noise.
      if (schedule.status === 'released' || schedule.status === 'canceled' || schedule.status === 'completed') {
        continue;
      }
      try {
        await stripe.subscriptionSchedules.release(schedule.id);
        released.push(schedule.id);
        console.log(`🧹 Released orphaned subscription schedule ${schedule.id} for ${customerId}`);
      } catch (err) {
        console.error(`⚠️ Could not release schedule ${schedule.id} for ${customerId} — this may cause an unexpected future cancellation:`, err);
      }
    }
  } catch (err) {
    console.error(`⚠️ Could not list subscription schedules for ${customerId}:`, err);
  }
  return released;
}

/**
 * Clear a scheduled cancellation everywhere it is recorded.
 *
 * "Everywhere" is three places, and missing any one leaves the states
 * disagreeing:
 *   1. the subscription at Stripe (cancel_at_period_end)
 *   2. any schedule object at Stripe (the silent one)
 *   3. our subscriptions row
 *
 * Provider first, then our database: if Stripe rejects, we have not recorded a
 * reactivation that did not happen. The reverse ordering would tell the
 * customer they are safe while Stripe still intends to cancel them.
 */
export async function clearScheduledCancellation(
  deps: { sql: SqlLike; stripe: any },
  params: { userId: number; stripeSubscriptionId?: string | null; stripeCustomerId?: string | null },
): Promise<{ releasedSchedules: string[] }> {
  const { sql, stripe } = deps;
  const { userId, stripeSubscriptionId, stripeCustomerId } = params;

  let releasedSchedules: string[] = [];

  if (stripeSubscriptionId) {
    await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: false });
  }

  if (stripeCustomerId) {
    releasedSchedules = await releaseOrphanedSchedules(stripe, stripeCustomerId);
  }

  await sql`
    UPDATE subscriptions
    SET    cancel_at_period_end = FALSE,
           cancelled_at = NULL,
           status = 'active'
    WHERE  user_id = ${userId}
  `;

  return { releasedSchedules };
}

/**
 * Compare what we believe against what the provider says.
 *
 * Used by the backfill and available for reconciliation. Returns null when the
 * two agree, or a description of the disagreement — deliberately shaped as
 * data rather than a log line so the backfill can count and report it.
 */
export function diffSubscriptionState(
  local: SubscriptionStateInput | null,
  provider: { status?: string; cancel_at_period_end?: boolean } | null,
): { field: string; local: unknown; provider: unknown }[] {
  const diffs: { field: string; local: unknown; provider: unknown }[] = [];
  if (!local || !provider) return diffs;

  if (Boolean(local.cancel_at_period_end) !== Boolean(provider.cancel_at_period_end)) {
    diffs.push({
      field: 'cancel_at_period_end',
      local: Boolean(local.cancel_at_period_end),
      provider: Boolean(provider.cancel_at_period_end),
    });
  }

  // Our vocabulary uses 'cancelled'; Stripe uses 'canceled'. Normalise before
  // comparing, or every cancelled subscription reads as a mismatch.
  const normalise = (s?: string | null) => (s || '').toLowerCase().replace('cancelled', 'canceled');
  if (normalise(local.status) !== normalise(provider.status)) {
    diffs.push({ field: 'status', local: local.status, provider: provider.status });
  }

  return diffs;
}
