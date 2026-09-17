/**
 * Reading the billing period off a Stripe subscription.
 *
 * The bug these guard: on 2025-10-29.clover `current_period_end` is not on the
 * Subscription object at all — it is on each item. Five call sites read the old
 * location, got undefined, and fell through to `now + 30 days`, so every stored
 * billing date in production was a fabricated one about a day early. The webhook
 * that fires on plan changes did it again on every upgrade.
 *
 * The first test is written against a payload shaped like the live one I read
 * from Stripe while diagnosing this, so it fails against the old code rather
 * than merely describing the new.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { periodEndOf, periodEndOrWarn, periodStartOf } from './subscription-period.js';

/** The live shape: period on the item, nothing at the top level. */
const CLOVER_SUBSCRIPTION = {
  id: 'sub_1U8bfxH9ZX6nSShrCVpSo84I',
  status: 'active',
  items: {
    data: [{
      id: 'si_test',
      price: { id: 'price_current' },
      current_period_start: 1787729710,
      current_period_end: 1790409310, // 2026-09-26T07:55:10Z
    }],
  },
};

describe('periodEndOf', () => {
  test('reads the period from the item, where Stripe now puts it', () => {
    assert.equal(periodEndOf(CLOVER_SUBSCRIPTION), 1790409310);
  });

  test('the top-level field is genuinely absent on that payload', () => {
    // Stated explicitly because it is the whole reason the old expression
    // failed: `sub.current_period_end || <guess>` always took the guess.
    assert.equal((CLOVER_SUBSCRIPTION as any).current_period_end, undefined);
  });

  test('still reads a pre-2025 payload from the top level', () => {
    // Replayed webhooks and older fixtures carry the legacy shape; dropping
    // support for it would swap one silent wrong answer for another.
    assert.equal(periodEndOf({ id: 'sub_old', current_period_end: 1790409310 }), 1790409310);
  });

  test('prefers the item over a stale top-level copy', () => {
    assert.equal(periodEndOf({
      id: 'sub_both',
      current_period_end: 1,
      items: { data: [{ current_period_end: 1790409310 }] },
    }), 1790409310);
  });

  test('with several items, the subscription renews when the LAST one does', () => {
    // Taking items.data[0] would make the answer depend on array ordering.
    assert.equal(periodEndOf({
      id: 'sub_multi',
      items: { data: [{ current_period_end: 100 }, { current_period_end: 900 }, { current_period_end: 500 }] },
    }), 900);
  });

  test('returns null rather than inventing a date when Stripe says nothing', () => {
    // THE contract. `now + 30 days` is not a fallback, it is a fabricated
    // billing date that is indistinguishable from a real one once written.
    assert.equal(periodEndOf({ id: 'sub_empty', items: { data: [] } }), null);
    assert.equal(periodEndOf({ id: 'sub_bare' }), null);
    assert.equal(periodEndOf(null), null);
    assert.equal(periodEndOf(undefined), null);
  });

  test('rejects values that are not usable timestamps', () => {
    for (const bad of [0, -1, null, undefined, 'soon', NaN, Infinity]) {
      assert.equal(
        periodEndOf({ id: 'sub_bad', items: { data: [{ current_period_end: bad }] } }),
        null,
        `expected ${String(bad)} to be rejected`,
      );
    }
  });
});

describe('periodStartOf', () => {
  test('reads the start from the items, earliest first', () => {
    assert.equal(periodStartOf({
      items: { data: [{ current_period_start: 1787900000 }, { current_period_start: 1787817600 }] },
    }), 1787817600);
  });

  test('falls back to the pre-2025 top-level field', () => {
    assert.equal(periodStartOf({ current_period_start: 1787817600, items: { data: [{}] } }), 1787817600);
  });

  test('null when Stripe said nothing', () => {
    assert.equal(periodStartOf({ items: { data: [{}] } }), null);
    assert.equal(periodStartOf(null), null);
  });
});

describe('periodEndOrWarn', () => {
  test('returns the period and says nothing when there is one', () => {
    const errors = captureErrors(() => periodEndOrWarn(CLOVER_SUBSCRIPTION, 'test'));
    assert.equal(errors.result, 1790409310);
    assert.equal(errors.logged.length, 0);
  });

  test('shouts, with the subscription id, when it cannot tell', () => {
    // A missing period means a customer may be shown a date nobody set, so it
    // has to be findable in the logs — the recovery is to read the period off
    // that subscription by hand.
    const errors = captureErrors(() => periodEndOrWarn({ id: 'sub_empty', items: { data: [] } }, 'subscription.updated'));
    assert.equal(errors.result, null);
    assert.equal(errors.logged.length, 1);
    assert.match(errors.logged[0], /sub_empty/);
    assert.match(errors.logged[0], /subscription\.updated/);
  });
});

/** Run fn with console.error captured. */
function captureErrors(fn: () => number | null) {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: any[]) => { logged.push(args.join(' ')); };
  try {
    return { result: fn(), logged };
  } finally {
    console.error = original;
  }
}
