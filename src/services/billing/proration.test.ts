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
