/**
 * BILL-003 — proration preview and disclosure audit.
 *
 * The isProrationLine tests are the important ones. That predicate is the single
 * point where a silent $0.00 can enter a customer's confirmation dialog, and it
 * has already been written wrong once: reading the pre-2025 top-level
 * `line.proration` field against a 2025-10-29 payload matches nothing, so every
 * upgrade quotes zero and every customer is then charged something else.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import { createFakeStripe } from '../../test/helpers/fake-stripe.js';
import {
  chargeProrationNow,
  dayAlignedProrationDate,
  groupProrationLines,
  nameChangeGroups,
  isProrationLine,
  sumProrationLines,
  describeProrationLines,
  recordDisclosure,
  settleDisclosure,
  previewUpgrade,
  type ProrationQuote,
} from './proration.js';

// A realistic 2025-10-29.clover preview: two proration adjustments due now,
// plus next cycle's recurring charge which is NOT due now.
const CLOVER_LINES = [
  {
    description: 'Unused time on Grow after 18 Aug 2026',
    amount: -1200,
    parent: { subscription_item_details: { proration: true } },
  },
  {
    description: 'Remaining time on Optimize after 18 Aug 2026',
    amount: 3613,
    parent: { subscription_item_details: { proration: true } },
  },
  {
    description: 'Optimize × 1 (2 Sep 2026 – 2 Oct 2026)',
    amount: 9900,
    parent: { subscription_item_details: { proration: false } },
  },
];

describe('isProrationLine', () => {
  test('recognises a proration under subscription_item_details (2025 shape)', () => {
    assert.equal(isProrationLine(CLOVER_LINES[0]), true);
  });

  test('recognises a proration under invoice_item_details', () => {
    assert.equal(isProrationLine({ parent: { invoice_item_details: { proration: true } } }), true);
  });

  test('EXCLUDES the next cycle recurring line', () => {
    assert.equal(isProrationLine(CLOVER_LINES[2]), false);
  });

  test('still understands the pre-2025 top-level flag', () => {
    assert.equal(isProrationLine({ proration: true, amount: 500 }), true);
    assert.equal(isProrationLine({ proration: false, amount: 9900 }), false);
  });

  test('a line with no proration signal at all is not counted', () => {
    assert.equal(isProrationLine({ description: 'mystery', amount: 100 }), false);
  });

  test('REGRESSION: a clover payload must never total zero', () => {
    // This is the bug in its exact form. Reading the top-level field alone —
    // `lines.filter(l => l.proration)` — yields [] here, and the customer is
    // quoted $0.00 for an upgrade that will charge them $24.13.
    const naive = CLOVER_LINES.filter((l: any) => l.proration);
    assert.equal(naive.length, 0, 'precondition: the naive filter is empty on this payload');

    assert.equal(sumProrationLines(CLOVER_LINES), 2413);
  });
});

describe('sumProrationLines', () => {
  test('nets the credit against the charge', () => {
    assert.equal(sumProrationLines(CLOVER_LINES), 2413);
  });

  test('can legitimately be negative (a downgrade producing credit)', () => {
    const lines = [
      { description: 'Unused time on Optimize', amount: -4000, parent: { subscription_item_details: { proration: true } } },
      { description: 'Remaining time on Grow', amount: 1500, parent: { subscription_item_details: { proration: true } } },
    ];
    assert.equal(sumProrationLines(lines), -2500);
  });

  test('no proration lines totals zero, not NaN', () => {
    assert.equal(sumProrationLines([CLOVER_LINES[2]]), 0);
  });
});

describe('describeProrationLines', () => {
  test('returns only the lines due now, with their descriptions', () => {
    const described = describeProrationLines(CLOVER_LINES);
    assert.equal(described.length, 2);
    assert.deepEqual(described[0], {
      description: 'Unused time on Grow after 18 Aug 2026',
      amount_cents: -1200,
      // Null, not absent: this fixture predates Stripe sending a period, and
      // the grouper has to cope with exactly that shape.
      period_start: null,
      price_id: null,
    });
  });
});

describe('previewUpgrade', () => {
  test('reads the amount from Stripe and pins the proration date', async () => {
    const stripe = createFakeStripe();
    stripe.preview.lines = CLOVER_LINES;

    const result = await previewUpgrade(stripe.api, {
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      subscriptionItemId: 'si_1',
      newPriceId: 'price_optimize',
      prorationDate: 1770000000,
    });

    assert.equal(result.amountDueCents, 2413);
    assert.equal(result.currency, 'usd');
    assert.equal(result.lines.length, 2);
    assert.equal(result.prorationDate, 1770000000);

    // The same instant must have been sent to Stripe, or the quote is not the
    // thing being priced.
    const call = stripe.callsTo('invoices.createPreview')[0];
    assert.equal(call.args[0].subscription_details.proration_date, 1770000000);
  });

  test('defaults the proration date to now when none is supplied', async () => {
    const stripe = createFakeStripe();
    stripe.preview.lines = CLOVER_LINES;
    const before = Math.floor(Date.now() / 1000);

    const result = await previewUpgrade(stripe.api, {
      customerId: 'cus_1', subscriptionId: 'sub_1', subscriptionItemId: 'si_1', newPriceId: 'price_x',
    });

    assert.ok(result.prorationDate >= before);
  });
});

const QUOTE: ProrationQuote = {
  is_upgrade: true,
  is_first_subscription: false,
  prorated: true,
  amount_due_cents: 2413,
  currency: 'usd',
  proration_date: 1770000000,
  effective: 'immediate',
  next_billing_date: '2026-09-02T00:00:00.000Z',
  next_amount_cents: 9900,
  new_plan: 'Optimize',
  description: 'test',
  lines: [{ description: 'Unused time on Grow', amount_cents: -1200 }],
  payment_method: { brand: 'visa', last4: '4242' },
};

describe('recordDisclosure', () => {
  test('persists what the customer will be shown, and returns a handle', async () => {
    const sql = createFakeSql();
    sql.when(/INSERT INTO billing_disclosures/, [{ disclosure_id: 'disc-abc' }]);

    const id = await recordDisclosure(sql, {
      userId: 7, fromPlanId: 2, toPlanId: 3, quote: QUOTE,
    });

    assert.equal(id, 'disc-abc');
    const insert = sql.matching(/INSERT INTO billing_disclosures/)[0];
    assert.ok(insert.params.includes(2413), 'the disclosed total must be stored');
    assert.ok(insert.params.includes('4242'), 'the card last four must be stored');
    assert.ok(insert.params.includes('USD'), 'currency must be stored explicitly');
  });

  test('stores only last four — never anything resembling a PAN', async () => {
    const sql = createFakeSql();
    sql.when(/INSERT INTO billing_disclosures/, [{ disclosure_id: 'disc-abc' }]);
    await recordDisclosure(sql, { userId: 7, fromPlanId: 2, toPlanId: 3, quote: QUOTE });

    const params = JSON.stringify(sql.matching(/INSERT INTO billing_disclosures/)[0].params);
    assert.ok(!/\b\d{13,19}\b/.test(params), 'something PAN-shaped reached the disclosure row');
  });

  test('a failure to record NEVER denies the customer a price', async () => {
    const sql = createFakeSql().failOn(/INSERT INTO billing_disclosures/);
    const id = await recordDisclosure(sql, { userId: 7, fromPlanId: 2, toPlanId: 3, quote: QUOTE });
    assert.equal(id, null); // logged, not thrown
  });
});

describe('settleDisclosure', () => {
  test('an exact match settles quietly', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, total_due_cents/, [
      { id: 1, user_id: 7, total_due_cents: 2413, currency: 'USD' },
    ]);

    const result = await settleDisclosure(sql, 'disc-abc', 2413);

    assert.equal(result.mismatch, false);
    assert.equal(result.disclosedCents, 2413);
    const update = sql.matching(/UPDATE billing_disclosures/)[0];
    assert.ok(update.params.includes(2413));
    assert.ok(update.params.includes(false));
  });

  test('one cent is rounding, not an incident', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, total_due_cents/, [
      { id: 1, user_id: 7, total_due_cents: 2413, currency: 'USD' },
    ]);
    assert.equal((await settleDisclosure(sql, 'disc-abc', 2414)).mismatch, false);
  });

  test('a real divergence is flagged and persisted as a mismatch', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, total_due_cents/, [
      { id: 1, user_id: 7, total_due_cents: 2413, currency: 'USD' },
    ]);

    const result = await settleDisclosure(sql, 'disc-abc', 9900);

    assert.equal(result.mismatch, true);
    const update = sql.matching(/UPDATE billing_disclosures/)[0];
    assert.ok(update.params.includes(true), 'the mismatch flag must be persisted, not only logged');
  });

  test('an unknown disclosure id is not an error', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, total_due_cents/, []);
    assert.deepEqual(await settleDisclosure(sql, 'nope', 100), { mismatch: false, disclosedCents: null });
  });
});

/**
 * BILL-003 — the stale-quote retry.
 *
 * Replaying the quoted proration_date is what makes the preview binding, but
 * Stripe rejects one outside the current period. This was previously behind a
 * flag defaulting to OFF, which left the ticket's central criterion unmet in
 * production. Handling the rejection is what allows it to be on by default,
 * so the classification of that error is now load-bearing.
 */
describe('stale proration_date classification', () => {
  /**
   * Mirrors the predicate in the /change-plan handler. Extracted here because
   * getting it wrong in either direction is expensive: too broad, and a genuine
   * decline is silently retried into a second charge attempt; too narrow, and a
   * stale dialog is a failed upgrade.
   */
  const isStaleQuote = (err: any): boolean =>
    err?.type === 'StripeInvalidRequestError'
    && /proration_date/i.test(String(err?.message || ''));

  test('an out-of-range proration_date IS retryable', () => {
    assert.equal(isStaleQuote({
      type: 'StripeInvalidRequestError',
      message: 'proration_date must be within the current subscription period',
    }), true);
  });

  test('a DECLINED CARD is not retried — that would attempt a second charge', () => {
    assert.equal(isStaleQuote({ type: 'StripeCardError', code: 'card_declined', message: 'Your card was declined.' }), false);
  });

  test('an unrelated invalid request is not retried', () => {
    assert.equal(isStaleQuote({
      type: 'StripeInvalidRequestError',
      message: 'No such price: price_nonexistent',
    }), false);
  });

  test('a network error is not misread as a stale quote', () => {
    assert.equal(isStaleQuote(new Error('socket hang up')), false);
    assert.equal(isStaleQuote(null), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grouping a double upgrade
//
// Stripe bills each subscription change as a PAIR — a credit for time unused on
// the old plan, a charge for time remaining on the new one. Change plan twice in
// a period and the preview carries four lines, which the confirmation dialog was
// listing raw for the customer to net out themselves.
//
// The amounts below are a real production disclosure: user 36 moved Grow →
// Optimize on 21 Aug for $15.24, then Optimize → Scale on 24 Aug for $22.19,
// and was quoted $37.43.
// ─────────────────────────────────────────────────────────────────────────────

const AUG_24 = 1787529600; // the change being previewed
const AUG_21 = 1787270400; // an earlier change in the same period

const DOUBLE_UPGRADE = [
  { description: 'Unused time on ImproveSEO Subscription after 24 Aug 2026', amount_cents: -2264, period_start: AUG_24 },
  { description: 'Remaining time on ImproveSEO Subscription after 24 Aug 2026', amount_cents: 4483, period_start: AUG_24 },
  { description: 'Unused time on ImproveSEO Subscription after 21 Aug 2026', amount_cents: -934, period_start: AUG_21 },
  { description: 'Remaining time on ImproveSEO Subscription after 21 Aug 2026', amount_cents: 2458, period_start: AUG_21 },
];

describe('groupProrationLines', () => {
  test('nets each change into one figure', () => {
    const groups = groupProrationLines(DOUBLE_UPGRADE, AUG_24);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].amount_cents, 2219, 'this change: 4483 - 2264');
    assert.equal(groups[1].amount_cents, 1524, 'the earlier one: 2458 - 934');
  });

  test('THE INVARIANT: the groups still add up to the total', () => {
    // The whole point of regrouping is that it changes the presentation and
    // nothing else. If these ever disagree the dialog is lying about a bill.
    const groups = groupProrationLines(DOUBLE_UPGRADE, AUG_24);
    const grouped = groups.reduce((n, g) => n + g.amount_cents, 0);
    const raw = DOUBLE_UPGRADE.reduce((n, l) => n + l.amount_cents, 0);
    assert.equal(grouped, raw);
    assert.equal(grouped, 3743);
  });

  test('the change being made now comes first and is flagged', () => {
    const groups = groupProrationLines(DOUBLE_UPGRADE, AUG_24);
    assert.equal(groups[0].is_current, true);
    assert.equal(groups[0].at, AUG_24);
    assert.equal(groups[1].is_current, false);
    // Exactly one, or the dialog cannot tell the customer which decision is
    // theirs to make right now.
    assert.equal(groups.filter((g) => g.is_current).length, 1);
  });

  test('keeps the charge and the credit halves apart', () => {
    // A single upgrade shows them itemised; only a multi-change quote nets
    // them. Both numbers have to survive the grouping for that to be possible.
    const [current] = groupProrationLines(DOUBLE_UPGRADE, AUG_24);
    assert.equal(current.charge_cents, 4483);
    assert.equal(current.credit_cents, -2264);
  });

  test('tolerates a proration_date that drifted by seconds', () => {
    // /change-plan retries WITHOUT the quoted date when Stripe calls it stale,
    // and prices at "now" instead. An exact match would then flag the WRONG
    // group as current and label this change as an old one.
    const groups = groupProrationLines(DOUBLE_UPGRADE, AUG_24 + 45);
    assert.equal(groups[0].at, AUG_24);
    assert.equal(groups[0].is_current, true);
  });

  test('a single change is one group', () => {
    const groups = groupProrationLines(DOUBLE_UPGRADE.slice(0, 2), AUG_24);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].amount_cents, 2219);
    assert.equal(groups[0].is_current, true);
  });

  test('lines with no period still render as the current change', () => {
    // The pre-2025 payload, and every fixture written before period_start
    // existed. Treating them as "some earlier change" would push the customer's
    // own decision out of the headline.
    const groups = groupProrationLines(describeProrationLines(CLOVER_LINES), null);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].is_current, true);
    assert.equal(groups[0].amount_cents, 2413);
    assert.equal(groups[0].at, null);
  });

  test('no lines, no groups', () => {
    assert.deepEqual(groupProrationLines([], AUG_24), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-day proration
//
// QA upgraded Optimize → Scale about half an hour into a 30-day period and was
// quoted $49.42 / −$24.97 for "the 30 days left". Stripe prorates to the second;
// aligning the proration instant to the start of the billing day makes the same
// arithmetic whole-day: $49.50 / −$25.00.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400;
const PERIOD_START = 1787817600; // 27 Aug 2026 08:00:00 UTC, say

describe('dayAlignedProrationDate', () => {
  test('half an hour into the period prices from the period start', () => {
    assert.equal(dayAlignedProrationDate(PERIOD_START, PERIOD_START + 1800), PERIOD_START);
  });

  test('counts whole days from the period start, not from UTC midnight', () => {
    const tenDaysAndFiveHours = PERIOD_START + 10 * DAY + 5 * 3600;
    assert.equal(dayAlignedProrationDate(PERIOD_START, tenDaysAndFiveHours), PERIOD_START + 10 * DAY);
  });

  test('exactly on a day boundary stays on it', () => {
    assert.equal(dayAlignedProrationDate(PERIOD_START, PERIOD_START + 3 * DAY), PERIOD_START + 3 * DAY);
  });

  test('THE POINT: day 0 of a 30-day period is exactly the full price and half of it', () => {
    // What Stripe does with the instant: price × (end − instant) / (end − start).
    const end = PERIOD_START + 30 * DAY;
    const at = dayAlignedProrationDate(PERIOD_START, PERIOD_START + 1800);
    const share = (cents: number) => Math.round(cents * (end - at) / (end - PERIOD_START));
    assert.equal(share(4950), 4950);
    assert.equal(-share(2500), -2500);
  });

  test('an unknown or future period start falls back to now rather than inventing a date', () => {
    const now = PERIOD_START + 1234;
    assert.equal(dayAlignedProrationDate(null, now), now);
    assert.equal(dayAlignedProrationDate(undefined, now), now);
    assert.equal(dayAlignedProrationDate(now + 10, now), now);
  });
});

describe('previewUpgrade — day alignment', () => {
  test('prices from the start of the billing day when the period start is known', async () => {
    const stripe = createFakeStripe();
    stripe.preview.lines = CLOVER_LINES;
    const periodStart = Math.floor(Date.now() / 1000) - 3 * DAY - 1800;

    const result = await previewUpgrade(stripe.api, {
      customerId: 'cus_1', subscriptionId: 'sub_1', subscriptionItemId: 'si_1', newPriceId: 'price_x',
      periodStart,
    });

    assert.equal(result.prorationDate, periodStart + 3 * DAY);
    const call = stripe.callsTo('invoices.createPreview')[0];
    assert.equal(call.args[0].subscription_details.proration_date, periodStart + 3 * DAY);
  });

  test('an explicit proration date (the replayed quote) still wins', async () => {
    const stripe = createFakeStripe();
    stripe.preview.lines = CLOVER_LINES;
    const result = await previewUpgrade(stripe.api, {
      customerId: 'cus_1', subscriptionId: 'sub_1', subscriptionItemId: 'si_1', newPriceId: 'price_x',
      prorationDate: 1770000000, periodStart: 1760000000,
    });
    assert.equal(result.prorationDate, 1770000000);
  });
});

describe('describeProrationLines — price', () => {
  test('reads the price from the clover pricing block, id or expanded', () => {
    const [a, b] = describeProrationLines([
      { amount: -100, parent: { subscription_item_details: { proration: true } }, pricing: { price_details: { price: 'price_grow' } } },
      { amount: 200, parent: { subscription_item_details: { proration: true } }, pricing: { price_details: { price: { id: 'price_optimize' } } } },
    ]);
    assert.equal(a.price_id, 'price_grow');
    assert.equal(b.price_id, 'price_optimize');
  });
});

// Two upgrades on the SAME day now share one proration instant. Grow → Optimize
// whose charge failed (so it is still pending), then Optimize → Scale.
const SAME_DAY = [
  { description: 'Unused time on ImproveSEO Subscription', amount_cents: -2500, period_start: PERIOD_START, price_id: 'price_optimize' },
  { description: 'Remaining time on ImproveSEO Subscription', amount_cents: 4950, period_start: PERIOD_START, price_id: 'price_scale' },
  { description: 'Unused time on ImproveSEO Subscription', amount_cents: -1000, period_start: PERIOD_START, price_id: 'price_grow' },
  { description: 'Remaining time on ImproveSEO Subscription', amount_cents: 2500, period_start: PERIOD_START, price_id: 'price_optimize' },
];
const SAME_DAY_PRICES = { newPriceId: 'price_scale', currentPriceId: 'price_optimize' };

describe('groupProrationLines — same-day changes', () => {
  test('separates this change from an earlier one sharing its instant', () => {
    const groups = groupProrationLines(SAME_DAY, PERIOD_START, SAME_DAY_PRICES);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].is_current, true);
    assert.equal(groups[0].charge_cents, 4950);
    assert.equal(groups[0].credit_cents, -2500);
    assert.equal(groups[0].amount_cents, 2450);
    assert.equal(groups[1].is_current, false);
    assert.equal(groups[1].amount_cents, 1500);
  });

  test('THE INVARIANT still holds: the groups add up to the total', () => {
    const groups = groupProrationLines(SAME_DAY, PERIOD_START, SAME_DAY_PRICES);
    assert.equal(
      groups.reduce((n, g) => n + g.amount_cents, 0),
      SAME_DAY.reduce((n, l) => n + l.amount_cents, 0),
    );
  });

  test('carries the prices each change moved between', () => {
    const [current, earlier] = groupProrationLines(SAME_DAY, PERIOD_START, SAME_DAY_PRICES);
    assert.equal(current.from_price_id, 'price_optimize');
    assert.equal(current.to_price_id, 'price_scale');
    assert.equal(earlier.from_price_id, 'price_grow');
    assert.equal(earlier.to_price_id, 'price_optimize');
  });

  test('an earlier same-day chain reads as its two ends', () => {
    // Grow → Optimize → Scale, both unpaid, then Scale → Pro now.
    const lines = [
      { description: '', amount_cents: -1000, period_start: PERIOD_START, price_id: 'price_grow' },
      { description: '', amount_cents: 2500, period_start: PERIOD_START, price_id: 'price_optimize' },
      { description: '', amount_cents: -2500, period_start: PERIOD_START, price_id: 'price_optimize' },
      { description: '', amount_cents: 4950, period_start: PERIOD_START, price_id: 'price_scale' },
      { description: '', amount_cents: -4950, period_start: PERIOD_START, price_id: 'price_scale' },
      { description: '', amount_cents: 9900, period_start: PERIOD_START, price_id: 'price_pro' },
    ];
    const [, earlier] = groupProrationLines(lines, PERIOD_START, { newPriceId: 'price_pro', currentPriceId: 'price_scale' });
    assert.equal(earlier.from_price_id, 'price_grow');
    assert.equal(earlier.to_price_id, 'price_scale');
  });

  test('without prices the old instant-based grouping is unchanged', () => {
    const groups = groupProrationLines(DOUBLE_UPGRADE, AUG_24, SAME_DAY_PRICES);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].amount_cents, 2219);
  });
});

describe('nameChangeGroups', () => {
  test('names earlier changes by price, monthly or yearly', async () => {
    const sql = createFakeSql();
    sql.when(/FROM subscription_plans/, [
      { name: 'Grow Plan', stripe_price_id: 'price_grow', stripe_price_id_yearly: 'price_grow_y' },
      { name: 'Starter Plan', stripe_price_id: 'price_optimize', stripe_price_id_yearly: null },
    ]);
    const groups = await nameChangeGroups(sql, [
      { at: PERIOD_START, is_current: true, amount_cents: 0, charge_cents: 0, credit_cents: 0, from_price_id: 'price_optimize', to_price_id: 'price_scale' },
      { at: PERIOD_START, is_current: false, amount_cents: 0, charge_cents: 0, credit_cents: 0, from_price_id: 'price_grow_y', to_price_id: 'price_optimize' },
    ]);
    assert.equal(groups[1].from_plan, 'Grow Plan');
    assert.equal(groups[1].to_plan, 'Starter Plan');
    assert.equal(groups[0].from_plan, undefined, 'the current change is named by the route, not here');
  });

  test('a price retired by migration 021 still names its plan', async () => {
    // Existing subscribers keep billing on the old shared-product prices.
    const sql = createFakeSql();
    sql.when(/FROM subscription_plans/, [
      { name: 'Grow', stripe_price_id: 'price_grow_new', stripe_price_id_yearly: null, legacy_stripe_price_ids: ['price_grow_old'] },
      { name: 'Starter Plan', stripe_price_id: 'price_optimize', stripe_price_id_yearly: null },
    ]);
    const groups = await nameChangeGroups(sql, [
      { at: PERIOD_START, is_current: false, amount_cents: 0, charge_cents: 0, credit_cents: 0, from_price_id: 'price_grow_old', to_price_id: 'price_optimize' },
    ]);
    assert.equal(groups[0].from_plan, 'Grow');
    assert.equal(groups[0].to_plan, 'Starter Plan');
  });

  test('a lookup failure still returns the groups unnamed', async () => {
    const sql = createFakeSql().failOn(/FROM subscription_plans/);
    const groups = await nameChangeGroups(sql, [
      { at: PERIOD_START, is_current: false, amount_cents: 1500, charge_cents: 2500, credit_cents: -1000, from_price_id: 'price_grow' },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].amount_cents, 1500);
  });
});

describe('chargeProrationNow', () => {
  const fakeInvoices = (amountDue: number) => {
    const calls: Record<string, any[]> = { create: [], pay: [], voidInvoice: [] };
    const api = {
      invoices: {
        async create(params: any) { calls.create.push(params); return { id: 'in_1', amount_due: amountDue, currency: 'usd' }; },
        async pay(id: string) {
          calls.pay.push(id);
          return { id, status: 'paid', amount_paid: amountDue, currency: 'usd', hosted_invoice_url: 'https://receipt' };
        },
        async voidInvoice(id: string) { calls.voidInvoice.push(id); return { id }; },
      },
    };
    return { api: api as any, calls };
  };

  test('REGRESSION: the invoice includes the pending proration items', async () => {
    // Without this flag Stripe excludes pending items, the invoice totals $0,
    // it is voided, and the upgrade is reported paid while nothing is collected.
    const { api, calls } = fakeInvoices(2450);
    await chargeProrationNow(api, { customerId: 'cus_1', subscriptionId: 'sub_1' });
    assert.equal(calls.create[0].pending_invoice_items_behavior, 'include');
    assert.equal(calls.create[0].subscription, 'sub_1');
  });

  test('pays what the invoice carries', async () => {
    const { api, calls } = fakeInvoices(2450);
    const charge = await chargeProrationNow(api, { customerId: 'cus_1', subscriptionId: 'sub_1' });
    assert.deepEqual(calls.pay, ['in_1']);
    assert.equal(charge.paid, true);
    assert.equal(charge.amountCents, 2450);
  });

  test('a genuinely empty invoice is voided, not paid', async () => {
    const { api, calls } = fakeInvoices(0);
    const charge = await chargeProrationNow(api, { customerId: 'cus_1', subscriptionId: 'sub_1' });
    assert.deepEqual(calls.voidInvoice, ['in_1']);
    assert.equal(calls.pay.length, 0);
    assert.equal(charge.amountCents, 0);
  });
});
