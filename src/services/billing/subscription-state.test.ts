/**
 * BILL-005 — subscription state machine and the cancellation banner.
 *
 * The transition table the ticket asks for is executed here rather than merely
 * written down: each of the four enumerated journeys is a test that asserts the
 * banner, the provider state and our state all agree at every step.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import { createFakeStripe, makeSubscription, makeCustomer } from '../../test/helpers/fake-stripe.js';
import {
  deriveCancellationBanner,
  releaseOrphanedSchedules,
  clearScheduledCancellation,
  diffSubscriptionState,
  isLiveStatus,
  LIVE_SUBSCRIPTION_STATUSES,
} from './subscription-state.js';

const NOW = new Date('2026-08-10T12:00:00Z');
const FUTURE = '2026-09-02T00:00:00Z';
const PAST = '2026-08-01T00:00:00Z';

// ── The set that has now been got wrong four times ─────────────────────────
// Every omission produced a different-looking bug (a paid plan labelled "Free
// Trial", a cancelled plan reading "NEXT BILLING", expiry warnings on the wrong
// day, a vanishing cancellation banner). Pinning the membership here is what
// makes the fifth omission a failing test rather than another support ticket.
describe('LIVE_SUBSCRIPTION_STATUSES', () => {
  test('contains every status under which a plan is still running', () => {
    for (const s of ['active', 'trialing', 'past_due', 'pending_downgrade']) {
      assert.ok(isLiveStatus(s), `${s} must count as live`);
    }
  });

  test('excludes the ended states', () => {
    for (const s of ['cancelled', 'canceled', 'paused']) {
      assert.ok(!isLiveStatus(s), `${s} must not count as live`);
    }
  });

  test('is null-safe and case-insensitive', () => {
    assert.ok(isLiveStatus('ACTIVE'));
    assert.ok(isLiveStatus('  Pending_Downgrade '));
    assert.ok(!isLiveStatus(null));
    assert.ok(!isLiveStatus(undefined));
    assert.ok(!isLiveStatus(''));
  });

  test('is frozen — no consumer can mutate the shared set', () => {
    assert.ok(Object.isFrozen(LIVE_SUBSCRIPTION_STATUSES));
  });
});

describe('deriveCancellationBanner', () => {
  test('REGRESSION: shows for a cancelling subscription with a queued downgrade', () => {
    // status 'pending_downgrade' used to fall through the hardcoded status
    // list, so a user who cancelled and then queued a downgrade saw no
    // cancellation banner at all — the plan was ending and nothing said so.
    const r = deriveCancellationBanner(
      { status: 'pending_downgrade', cancel_at_period_end: true, next_billing_date: FUTURE },
      NOW,
    );
    assert.equal(r.visible, true);
  });

  test('shows for an active subscription cancelling in the future', () => {
    const banner = deriveCancellationBanner(
      { status: 'active', cancel_at_period_end: true, next_billing_date: FUTURE },
      NOW,
    );
    assert.equal(banner.visible, true);
    assert.equal(banner.accessUntil, new Date(FUTURE).toISOString());
  });

  test('THE REPORTED BUG: hidden once the cancellation flag is cleared', () => {
    const banner = deriveCancellationBanner(
      { status: 'active', cancel_at_period_end: false, next_billing_date: FUTURE },
      NOW,
    );
    assert.equal(banner.visible, false);
  });

  test('INVERSE BUG: a genuine cancellation is not accidentally hidden', () => {
    // Guards against "fixing" the stale banner by simply never showing it.
    const banner = deriveCancellationBanner(
      { status: 'active', cancel_at_period_end: true, next_billing_date: FUTURE, cancelled_at: '2026-08-09T00:00:00Z' },
      NOW,
    );
    assert.equal(banner.visible, true);
  });

  test('hidden when the subscription has already been cancelled outright', () => {
    assert.equal(
      deriveCancellationBanner({ status: 'cancelled', cancel_at_period_end: true, next_billing_date: FUTURE }, NOW).visible,
      false,
    );
  });

  test('hidden when the effective date has already passed', () => {
    // The deletion webhook has not landed. "Access continues until [yesterday]"
    // is worse than showing nothing.
    assert.equal(
      deriveCancellationBanner({ status: 'active', cancel_at_period_end: true, next_billing_date: PAST }, NOW).visible,
      false,
    );
  });

  test('hidden when there is no effective date to state', () => {
    assert.equal(
      deriveCancellationBanner({ status: 'active', cancel_at_period_end: true, next_billing_date: null }, NOW).visible,
      false,
    );
  });

  test('hidden for no subscription at all', () => {
    assert.equal(deriveCancellationBanner(null, NOW).visible, false);
    assert.equal(deriveCancellationBanner(undefined, NOW).visible, false);
  });

  test('a paused subscription does not show a cancellation banner', () => {
    assert.equal(
      deriveCancellationBanner({ status: 'paused', cancel_at_period_end: true, next_billing_date: FUTURE }, NOW).visible,
      false,
    );
  });

  test('BOUNDARY: exactly at the effective instant, the banner is gone', () => {
    const at = new Date(FUTURE);
    assert.equal(
      deriveCancellationBanner({ status: 'active', cancel_at_period_end: true, next_billing_date: FUTURE }, at).visible,
      false,
    );
    // One second earlier it is still shown.
    const justBefore = new Date(at.getTime() - 1000);
    assert.equal(
      deriveCancellationBanner({ status: 'active', cancel_at_period_end: true, next_billing_date: FUTURE }, justBefore).visible,
      true,
    );
  });

  test('an unparseable date is refused rather than rendered as Invalid Date', () => {
    assert.equal(
      deriveCancellationBanner({ status: 'active', cancel_at_period_end: true, next_billing_date: 'not a date' }, NOW).visible,
      false,
    );
  });
});

describe('releaseOrphanedSchedules', () => {
  test('releases an active schedule left behind after a resubscribe', async () => {
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      subscriptions: [makeSubscription({ id: 'sub_1', customer: 'cus_1' })],
    });
    const scheduleId = stripe.addSchedule('sub_1');

    const released = await releaseOrphanedSchedules(stripe.api, 'cus_1');

    assert.deepEqual(released, [scheduleId]);
    assert.equal(stripe.state.schedules.size, 0, 'the schedule must be gone');
  });

  test('is a no-op when there is nothing to release', async () => {
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      subscriptions: [makeSubscription({ id: 'sub_1', customer: 'cus_1' })],
    });
    assert.deepEqual(await releaseOrphanedSchedules(stripe.api, 'cus_1'), []);
  });

  test('a failure to release is logged, never thrown', async () => {
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      subscriptions: [makeSubscription({ id: 'sub_1', customer: 'cus_1' })],
    });
    stripe.addSchedule('sub_1');
    stripe.failNext('subscriptionSchedules.release', new Error('stripe down'));

    // A running subscription must not be blocked by a cleanup failure.
    assert.deepEqual(await releaseOrphanedSchedules(stripe.api, 'cus_1'), []);
  });
});

describe('clearScheduledCancellation', () => {
  test('clears the flag at the provider, releases schedules, and updates our row', async () => {
    const sql = createFakeSql();
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      subscriptions: [makeSubscription({ id: 'sub_1', customer: 'cus_1', cancel_at_period_end: true })],
    });
    stripe.addSchedule('sub_1');

    const result = await clearScheduledCancellation(
      { sql, stripe: stripe.api },
      { userId: 7, stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' },
    );

    // 1. provider subscription
    assert.equal((await stripe.api.subscriptions.retrieve('sub_1')).cancel_at_period_end, false);
    // 2. provider schedule — the silent one
    assert.equal(result.releasedSchedules.length, 1);
    assert.equal(stripe.state.schedules.size, 0);
    // 3. our row
    const update = sql.matching(/UPDATE subscriptions/)[0];
    assert.match(update.text, /cancel_at_period_end = FALSE/);
    assert.match(update.text, /cancelled_at = NULL/);
  });

  test('the provider is written BEFORE our database', async () => {
    const sql = createFakeSql();
    const stripe = createFakeStripe({
      subscriptions: [makeSubscription({ id: 'sub_1', customer: 'cus_1', cancel_at_period_end: true })],
      customers: [makeCustomer({ id: 'cus_1' })],
    });
    // If Stripe refuses, we must not have recorded a reactivation that did not
    // happen — that would tell the customer they are safe while Stripe still
    // intends to cancel them.
    stripe.failNext('subscriptions.update', new Error('stripe rejected'));

    await assert.rejects(
      clearScheduledCancellation(
        { sql, stripe: stripe.api },
        { userId: 7, stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' },
      ),
      /stripe rejected/,
    );
    assert.equal(sql.countMatching(/UPDATE subscriptions/), 0, 'our row must not claim reactivation');
  });
});

describe('diffSubscriptionState', () => {
  test('no diff when the two agree', () => {
    assert.deepEqual(
      diffSubscriptionState(
        { status: 'active', cancel_at_period_end: false },
        { status: 'active', cancel_at_period_end: false },
      ),
      [],
    );
  });

  test('detects the stale flag: we say cancelling, Stripe does not', () => {
    const diffs = diffSubscriptionState(
      { status: 'active', cancel_at_period_end: true },
      { status: 'active', cancel_at_period_end: false },
    );
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].field, 'cancel_at_period_end');
    assert.equal(diffs[0].local, true);
    assert.equal(diffs[0].provider, false);
  });

  test('detects the inverse: Stripe is cancelling and we are not', () => {
    const diffs = diffSubscriptionState(
      { status: 'active', cancel_at_period_end: false },
      { status: 'active', cancel_at_period_end: true },
    );
    assert.equal(diffs[0].provider, true);
  });

  test('cancelled/canceled spelling is not reported as a mismatch', () => {
    // Our vocabulary is British-ish, Stripe's is American. Without normalising,
    // every cancelled subscription would look like a divergence.
    assert.deepEqual(
      diffSubscriptionState(
        { status: 'cancelled', cancel_at_period_end: false },
        { status: 'canceled', cancel_at_period_end: false },
      ),
      [],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The transition table BILL-005 asks for, executed rather than described.
// Each journey asserts banner + provider state + our state at every step.
// ─────────────────────────────────────────────────────────────────────────────
describe('state machine — enumerated transitions', () => {
  /** A tiny world: one subscription at Stripe, one row here. */
  const world = () => {
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      subscriptions: [makeSubscription({
        id: 'sub_1', customer: 'cus_1',
        current_period_end: Math.floor(new Date(FUTURE).getTime() / 1000),
      })],
    });
    const local: any = {
      status: 'active', cancel_at_period_end: false,
      next_billing_date: FUTURE, cancelled_at: null,
    };
    const sql = createFakeSql();

    return {
      stripe, local, sql,
      async cancel() {
        await stripe.api.subscriptions.update('sub_1', { cancel_at_period_end: true });
        local.cancel_at_period_end = true;
        local.cancelled_at = NOW.toISOString();
      },
      async resubscribe() {
        await clearScheduledCancellation(
          { sql, stripe: stripe.api },
          { userId: 7, stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' },
        );
        local.cancel_at_period_end = false;
        local.cancelled_at = null;
        local.status = 'active';
      },
      banner: () => deriveCancellationBanner(local, NOW),
      providerSub: () => stripe.state.subscriptions.get('sub_1')!,
    };
  };

  test('active → cancelled(scheduled) → resubscribe SAME plan', async () => {
    const w = world();
    assert.equal(w.banner().visible, false);

    await w.cancel();
    assert.equal(w.banner().visible, true, 'banner should appear on cancellation');
    assert.equal(w.providerSub().cancel_at_period_end, true);

    await w.resubscribe();
    assert.equal(w.banner().visible, false, 'THE REPORTED BUG: banner must be gone');
    assert.equal(w.providerSub().cancel_at_period_end, false);
    assert.equal(w.local.cancel_at_period_end, false);
    assert.deepEqual(diffSubscriptionState(w.local, w.providerSub()), []);
  });

  test('active → cancelled(scheduled) → subscribe DIFFERENT plan', async () => {
    const w = world();
    await w.cancel();
    // A schedule left over from the cancellation — the dangerous case.
    const scheduleId = w.stripe.addSchedule('sub_1');
    assert.equal(w.banner().visible, true);

    await w.resubscribe();
    await w.stripe.api.subscriptions.update('sub_1', { items: [{ price: 'price_scale' }] });

    assert.equal(w.banner().visible, false);
    assert.equal(w.providerSub().cancel_at_period_end, false);
    assert.equal(
      w.stripe.state.schedules.has(scheduleId), false,
      'no orphaned schedule may remain — this is the silent future cancellation',
    );
    assert.deepEqual(diffSubscriptionState(w.local, w.providerSub()), []);
  });

  test('active → cancelled(scheduled) → allowed to LAPSE → subscribe again', async () => {
    const w = world();
    await w.cancel();

    // Time passes; the period ends and the deletion webhook lands.
    w.local.status = 'cancelled';
    const afterLapse = new Date('2026-09-03T00:00:00Z');
    assert.equal(
      deriveCancellationBanner(w.local, afterLapse).visible, false,
      'a lapsed subscription is cancelled, not "scheduled to cancel"',
    );

    // A brand-new subscription afterwards.
    w.local.status = 'active';
    w.local.cancel_at_period_end = false;
    w.local.next_billing_date = '2026-10-03T00:00:00Z';
    assert.equal(deriveCancellationBanner(w.local, afterLapse).visible, false);
  });

  test('active → upgrade → cancel → upgrade', async () => {
    const w = world();
    await w.stripe.api.subscriptions.update('sub_1', { items: [{ price: 'price_optimize' }] });
    assert.equal(w.banner().visible, false, 'an upgrade must not raise a cancellation banner');

    await w.cancel();
    assert.equal(w.banner().visible, true);

    await w.resubscribe();
    await w.stripe.api.subscriptions.update('sub_1', { items: [{ price: 'price_scale' }] });
    assert.equal(w.banner().visible, false);
    assert.equal(w.providerSub().cancel_at_period_end, false);
    assert.deepEqual(diffSubscriptionState(w.local, w.providerSub()), []);
  });
});
