/**
 * BILL-004 — the billing ledger.
 *
 * The scoping test is the one that matters most: BILL-004 calls a cross-account
 * read "a data-leak risk" and asks for it to be asserted explicitly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import {
  recordTransaction,
  transactionsFromInvoice,
  subscriptionIdFromInvoice,
  settlePendingPlanChanges,
  isRenewalInvoice,
  receiptUrlFromSession,
  fetchCheckoutReceiptUrl,
  readLedger,
} from './transactions.js';

const okInsert = (inserted = true) =>
  [{ id: 1, inserted }];

describe('recordTransaction', () => {
  test('writes a credit purchase with money in minor units and an explicit currency', async () => {
    const sql = createFakeSql();
    sql.when(/INSERT INTO billing_transactions/, okInsert());

    const result = await recordTransaction(sql, {
      userId: 7,
      type: 'credit_purchase',
      description: '10 Content Credits',
      amountCents: 2000,
      currency: 'usd',
      providerEventId: 'evt_1',
      creditType: 'content',
      creditDelta: 10,
    });

    assert.deepEqual(result, { recorded: true, duplicate: false });
    const q = sql.matching(/INSERT INTO billing_transactions/)[0];
    assert.ok(q.params.includes(2000), 'amount must be integer cents');
    assert.ok(q.params.includes('USD'), 'currency must be stored, uppercase');
  });

  test('reports a replayed event as a duplicate rather than a new row', async () => {
    const sql = createFakeSql();
    sql.when(/INSERT INTO billing_transactions/, okInsert(false));

    const result = await recordTransaction(sql, {
      userId: 7, type: 'renewal', description: 'Renewal',
      amountCents: 9900, currency: 'usd', providerEventId: 'evt_1',
    });

    assert.deepEqual(result, { recorded: true, duplicate: true });
  });

  test('IDEMPOTENCY: the same webhook delivered three times writes one row', async () => {
    // Model the unique index: the first insert wins, later ones update.
    const seen = new Set<string>();
    const sql = createFakeSql();
    sql.when(/INSERT INTO billing_transactions/, (params) => {
      const eventId = params[7]; // provider_event_id position
      const first = !seen.has(eventId);
      seen.add(eventId);
      return [{ id: 1, inserted: first }];
    });

    const input = {
      userId: 7, type: 'renewal' as const, description: 'Renewal',
      amountCents: 9900, currency: 'usd', providerEventId: 'evt_same',
    };
    const results = [
      await recordTransaction(sql, input),
      await recordTransaction(sql, input),
      await recordTransaction(sql, input),
    ];

    assert.equal(results.filter((r) => !r.duplicate).length, 1, 'exactly one insert');
    assert.equal(results.filter((r) => r.duplicate).length, 2);
  });

  test('a credit-only event carries no amount and no currency', async () => {
    const sql = createFakeSql();
    sql.when(/INSERT INTO billing_transactions/, okInsert());

    await recordTransaction(sql, {
      userId: 7, type: 'plan_grant', description: 'Plan credits refill',
      creditType: 'content', creditDelta: 50,
    });

    const q = sql.matching(/INSERT INTO billing_transactions/)[0];
    // The money CHECK constraint requires both or neither.
    assert.ok(q.params.includes(null));
    assert.ok(!q.params.includes('USD'));
  });

  test('a ledger failure NEVER propagates — the money already moved', async () => {
    const sql = createFakeSql().failOn(/INSERT INTO billing_transactions/);
    const result = await recordTransaction(sql, {
      userId: 7, type: 'renewal', description: 'Renewal',
      amountCents: 9900, currency: 'usd', providerEventId: 'evt_1',
    });
    assert.deepEqual(result, { recorded: false, duplicate: false });
  });
});

describe('settling a plan change that was waiting on an invoice', () => {
  // A plan change whose proration could not be collected on the day is written
  // `pending` with no receipt. Nothing used to change that, so the row stayed
  // pending for good and its Receipt column stayed blank — which is what QA
  // reported as "the Stripe link is missing" on the CSV export.
  const args = {
    userId: 7,
    subscriptionId: 'sub_1',
    receiptUrl: 'https://invoice.stripe.com/i/abc',
    paidAt: new Date('2026-09-20T00:00:00Z'),
  };
  const settleSql = (rows: any[]) => {
    const sql = createFakeSql();
    sql.when(/UPDATE billing_transactions/, rows);
    return sql;
  };

  test('marks the row succeeded and attaches the receipt', async () => {
    const sql = settleSql([{ id: 11 }]);
    assert.equal(await settlePendingPlanChanges(sql, args), 1);

    const q = sql.matching(/UPDATE billing_transactions/)[0];
    assert.match(q.text, /SET status\s*=\s*'succeeded'/);
    // COALESCE, so a row that already has a receipt keeps the one closest to
    // the event rather than being overwritten by a later invoice.
    assert.match(q.text, /receipt_url\s*=\s*COALESCE/);
    assert.ok(q.params.includes('https://invoice.stripe.com/i/abc'));
  });

  test('only PENDING plan upgrades, and only for this subscription', async () => {
    const sql = settleSql([]);
    await settlePendingPlanChanges(sql, args);
    const q = sql.matching(/UPDATE billing_transactions/)[0];
    assert.match(q.text, /status\s*=\s*'pending'/);
    assert.match(q.text, /type\s*=\s*'plan_upgrade'/);
    assert.match(q.text, /provider_object_id/);
    assert.ok(q.params.includes('sub_1'), 'scoped to the subscription');
    assert.ok(q.params.includes(7), 'scoped to the user');
  });

  test('never settles a row created AFTER the invoice', async () => {
    // A change made after this invoice was raised is not the one it collected.
    const sql = settleSql([]);
    await settlePendingPlanChanges(sql, args);
    assert.match(sql.matching(/UPDATE billing_transactions/)[0].text, /created_at\s*<=/);
  });

  test('reports how many rows it settled, so one invoice can close two changes', async () => {
    const sql = settleSql([{ id: 1 }, { id: 2 }]);
    assert.equal(await settlePendingPlanChanges(sql, args), 2);
  });

  test('a missing receipt still settles the status', async () => {
    // Being charged is the fact that matters; the link is a convenience.
    const sql = settleSql([{ id: 3 }]);
    assert.equal(await settlePendingPlanChanges(sql, { ...args, receiptUrl: null }), 1);
  });

  test('nothing to settle is not an error', async () => {
    const sql = settleSql([]);
    assert.equal(await settlePendingPlanChanges(sql, args), 0);
  });
});

describe('subscriptionIdFromInvoice', () => {
  // The regression this function exists for: both webhook branches guarded on
  // `invoice.subscription`, which does not exist on API version 2025-10-29.
  // The guard never opened, so renewals never refilled credits and failed
  // payments never suspended anyone — silently, because `as any` hid it.
  test('reads the current shape, where it lives under parent', () => {
    assert.equal(
      subscriptionIdFromInvoice({
        parent: { subscription_details: { subscription: 'sub_new' } },
      }),
      'sub_new',
    );
  });

  test('still reads the legacy top-level field', () => {
    // Stripe replays historical events, and a payload is serialised at the API
    // version in force when the event was CREATED — not the account's current
    // one. Dropping this fallback would re-break every redelivered event.
    assert.equal(subscriptionIdFromInvoice({ subscription: 'sub_old' }), 'sub_old');
  });

  test('prefers the current shape when both are present', () => {
    assert.equal(
      subscriptionIdFromInvoice({
        subscription: 'sub_old',
        parent: { subscription_details: { subscription: 'sub_new' } },
      }),
      'sub_new',
    );
  });

  test('unwraps an expanded object', () => {
    assert.equal(
      subscriptionIdFromInvoice({
        parent: { subscription_details: { subscription: { id: 'sub_expanded' } } },
      }),
      'sub_expanded',
    );
  });

  test('null for a one-off invoice, and for junk', () => {
    // Must be null, not undefined: the caller uses it as a guard and then as a
    // query parameter, and `undefined` in a tagged template is not a safe null.
    assert.equal(subscriptionIdFromInvoice({ billing_reason: 'manual' }), null);
    assert.equal(subscriptionIdFromInvoice({ parent: null }), null);
    assert.equal(subscriptionIdFromInvoice({}), null);
    assert.equal(subscriptionIdFromInvoice(null), null);
  });
});

describe('isRenewalInvoice — which invoices grant a fresh allotment', () => {
  // refillPlanCredits adds a WHOLE allotment and re-stamps cycle_started_at.
  // Every invoice attached to a subscription reaches the webhook, so without
  // this gate an upgrade would receive its prorated difference AND a full
  // month's credits, with the cycle anchor moved to mid-period.
  test('only a subscription_cycle invoice is a renewal', () => {
    assert.equal(isRenewalInvoice({ billing_reason: 'subscription_cycle' }), true);
  });

  for (const reason of ['subscription_create', 'subscription_update', 'manual', 'subscription_threshold']) {
    test(`${reason} does not refill`, () => {
      assert.equal(isRenewalInvoice({ billing_reason: reason }), false);
    });
  }

  test('an absent billing_reason does not refill', () => {
    // Fail closed. Granting a month of credits we were not asked for is worse
    // than granting them late, and the renewal case always carries the reason.
    assert.equal(isRenewalInvoice({}), false);
    assert.equal(isRenewalInvoice(null), false);
  });
});

describe('transactionsFromInvoice', () => {
  const prorationInvoice = {
    id: 'in_upgrade',
    created: 1770000000,
    currency: 'usd',
    status: 'paid',
    billing_reason: 'subscription_update',
    hosted_invoice_url: 'https://invoice.stripe.test/x',
    amount_paid: 2413,
    lines: {
      data: [
        {
          id: 'il_1',
          description: 'Unused time on Grow',
          amount: -1200,
          parent: { subscription_item_details: { proration: true } },
        },
        {
          id: 'il_2',
          description: 'Remaining time on Optimize',
          amount: 3613,
          parent: { subscription_item_details: { proration: true } },
        },
      ],
    },
  };

  test('proration charges and credits become their own labelled rows', () => {
    const rows = transactionsFromInvoice(prorationInvoice, 7, 3);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].type, 'proration_credit');
    assert.equal(rows[0].amountCents, -1200);
    assert.equal(rows[0].description, 'Unused time on Grow');
    assert.equal(rows[1].type, 'proration_charge');
    assert.equal(rows[1].amountCents, 3613);
  });

  test('each proration row gets its OWN event id so they cannot collide', () => {
    const rows = transactionsFromInvoice(prorationInvoice, 7, 3);
    assert.equal(rows[0].providerEventId, 'invoice_line:il_1');
    assert.equal(rows[1].providerEventId, 'invoice_line:il_2');
    assert.notEqual(rows[0].providerEventId, rows[1].providerEventId);
  });

  test('a plain renewal becomes exactly one row', () => {
    const rows = transactionsFromInvoice({
      id: 'in_renew', created: 1770000000, currency: 'usd', status: 'paid',
      billing_reason: 'subscription_cycle', amount_paid: 9900,
      lines: { data: [{ id: 'il_x', description: 'Optimize × 1', amount: 9900 }] },
    }, 7, 3);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'renewal');
    assert.equal(rows[0].amountCents, 9900);
    assert.equal(rows[0].providerEventId, 'invoice:in_renew');
  });

  test('a first subscription invoice is typed as such', () => {
    const rows = transactionsFromInvoice({
      id: 'in_first', created: 1, currency: 'usd', status: 'paid',
      billing_reason: 'subscription_create', amount_paid: 4900,
      lines: { data: [{ id: 'il', description: 'Grow × 1', amount: 4900 }] },
    }, 7, 2);
    assert.equal(rows[0].type, 'subscription_create');
  });

  test('a first subscription invoice keys on the SUBSCRIPTION, not the invoice — it settles the row activateSubscriptionInDb already wrote', () => {
    const rows = transactionsFromInvoice({
      id: 'in_first', created: 1, currency: 'usd', status: 'paid',
      billing_reason: 'subscription_create', amount_paid: 4900,
      parent: { subscription_details: { subscription: 'sub_new' } },
      lines: { data: [{ id: 'il', description: 'Grow × 1', amount: 4900 }] },
    }, 7, 2);
    // Same key activateSubscriptionInDb uses (`subscription_create:<sub id>`) —
    // recordTransaction's upsert merges this settled amount/receipt into that
    // row instead of inserting a second one for the same event.
    assert.equal(rows[0].providerEventId, 'subscription_create:sub_new');
  });

  test('a first subscription invoice with no readable subscription id falls back to the invoice id, rather than a null key', () => {
    const rows = transactionsFromInvoice({
      id: 'in_first', created: 1, currency: 'usd', status: 'paid',
      billing_reason: 'subscription_create', amount_paid: 4900,
      lines: { data: [{ id: 'il', description: 'Grow × 1', amount: 4900 }] },
    }, 7, 2);
    assert.equal(rows[0].providerEventId, 'subscription_create:in_first');
  });

  test('a renewal still keys on the invoice — nothing was written earlier for it to settle', () => {
    const rows = transactionsFromInvoice({
      id: 'in_renew_2', created: 1, currency: 'usd', status: 'paid',
      billing_reason: 'subscription_cycle', amount_paid: 9900,
      parent: { subscription_details: { subscription: 'sub_new' } },
      lines: { data: [{ id: 'il', description: 'Optimize × 1', amount: 9900 }] },
    }, 7, 3);
    assert.equal(rows[0].providerEventId, 'invoice:in_renew_2');
  });

  test('an unpaid invoice is recorded as pending, not succeeded', () => {
    const rows = transactionsFromInvoice({
      id: 'in_open', created: 1, currency: 'usd', status: 'open',
      billing_reason: 'subscription_cycle', amount_due: 9900,
      lines: { data: [{ id: 'il', description: 'x', amount: 9900 }] },
    }, 7);
    assert.equal(rows[0].status, 'pending');
  });
});

describe('readLedger', () => {
  const row = (id: number, when: string) => ({
    id,
    type: 'renewal',
    description: `Renewal ${id}`,
    amount_cents: 9900,
    currency: 'USD',
    status: 'succeeded',
    receipt_url: null,
    credit_type: null,
    credit_delta: null,
    plan_id: 3,
    occurred_at: when,
  });

  test('SCOPING: the query is constrained to the requested user (data-leak guard)', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, type, description/, []);

    await readLedger(sql, 7);

    const q = sql.matching(/FROM billing_transactions/)[0];
    assert.match(q.text, /WHERE user_id = \?/, 'the read must be scoped by user_id');
    assert.equal(q.params[0], 7, 'scoped to the requested user, and no other');
  });

  test('user A asking for a page never receives user B rows', async () => {
    // The fake answers with whatever it is given, so the assertion that matters
    // is that the ONLY user id reaching the database is the one asked for.
    const sql = createFakeSql();
    sql.when(/SELECT id, type, description/, [row(1, '2026-08-01T00:00:00Z')]);

    await readLedger(sql, 7);
    await readLedger(sql, 7, { cursor: '2026-08-01T00:00:00.000Z|1' });

    for (const q of sql.matching(/FROM billing_transactions/)) {
      assert.ok(q.params.includes(7), 'every read carried the caller user id');
      assert.ok(!q.params.includes(8), 'no other account id was ever queried');
    }
  });

  test('returns newest first and reports no more pages when short', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, type, description/, [
      row(3, '2026-08-03T00:00:00Z'),
      row(2, '2026-08-02T00:00:00Z'),
    ]);

    const page = await readLedger(sql, 7, { limit: 20 });

    assert.equal(page.events.length, 2);
    assert.equal(page.has_more, false);
    assert.equal(page.next_cursor, null);
    assert.equal(page.events[0].id, 'txn_3');
    assert.equal(page.events[0].currency, 'usd', 'currency is normalised for display');
  });

  test('PAGINATION: an over-full page reports has_more and a usable cursor', async () => {
    const sql = createFakeSql();
    // limit 2 → the function asks for 3 to detect the next page.
    sql.when(/SELECT id, type, description/, [
      row(3, '2026-08-03T00:00:00Z'),
      row(2, '2026-08-02T00:00:00Z'),
      row(1, '2026-08-01T00:00:00Z'),
    ]);

    const page = await readLedger(sql, 7, { limit: 2 });

    assert.equal(page.events.length, 2, 'the probe row must not be returned');
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, '2026-08-02T00:00:00.000Z|2');
  });

  test('the cursor pages on (occurred_at, id), so same-instant rows cannot repeat', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, type, description/, []);

    await readLedger(sql, 7, { cursor: '2026-08-02T00:00:00.000Z|2' });

    const q = sql.matching(/FROM billing_transactions/)[0];
    assert.match(q.text, /\(occurred_at, id\) < \(\?::timestamptz, \?\)/);
    assert.ok(q.params.includes(2));
  });

  test('a malformed cursor is ignored rather than throwing', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, type, description/, []);
    const page = await readLedger(sql, 7, { cursor: 'nonsense' });
    assert.deepEqual(page.events, []);
    // Fell back to the unfiltered first page.
    assert.ok(!/occurred_at, id\) </.test(sql.matching(/FROM billing_transactions/)[0].text));
  });

  test('limit is clamped so a caller cannot ask for the whole table', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, type, description/, []);
    await readLedger(sql, 7, { limit: 100000 });
    const q = sql.matching(/FROM billing_transactions/)[0];
    assert.ok(q.params.includes(101), 'clamped to 100 (+1 probe row)');
  });
});

describe('receipt links for credit purchases', () => {
  // Every credit_purchase row in the database had receipt_url NULL while Stripe
  // held the link, because nothing ever looked for it. The Account Activity CSV
  // therefore had an empty Receipt column on exactly the rows people expense.

  test('reads the receipt off the charge behind the payment intent', () => {
    const session = {
      id: 'cs_test_1',
      payment_intent: { latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/abc' } },
    };
    assert.equal(receiptUrlFromSession(session), 'https://pay.stripe.com/receipts/abc');
  });

  test('an UNEXPANDED payment_intent reads as absent, not as a receipt', () => {
    // This is the shape the webhook actually receives — a bare id string. Had
    // this returned something truthy, we would have stored an id as a URL.
    assert.equal(receiptUrlFromSession({ id: 'cs_1', payment_intent: 'pi_123' }), null);
    assert.equal(
      receiptUrlFromSession({ id: 'cs_1', payment_intent: { latest_charge: 'ch_123' } }),
      null,
    );
  });

  test('a session with no payment at all yields null', () => {
    assert.equal(receiptUrlFromSession({ id: 'cs_1' }), null);
    assert.equal(receiptUrlFromSession(null), null);
    assert.equal(
      receiptUrlFromSession({ payment_intent: { latest_charge: { receipt_url: null } } }),
      null,
    );
  });

  test('fetches with payment_intent.latest_charge expanded', async () => {
    const calls: any[] = [];
    const stripe = {
      checkout: {
        sessions: {
          async retrieve(id: string, params?: any) {
            calls.push({ id, params });
            return { id, payment_intent: { latest_charge: { receipt_url: 'https://r/1' } } };
          },
        },
      },
    };
    assert.equal(await fetchCheckoutReceiptUrl(stripe, 'cs_1'), 'https://r/1');
    // Without the expand the retrieve returns a bare id and this whole thing is
    // a no-op that silently keeps storing null.
    assert.deepEqual(calls[0].params, { expand: ['payment_intent.latest_charge'] });
  });

  test('a Stripe failure returns null instead of throwing', async () => {
    // THE point of the guard: this runs in the webhook that grants credits the
    // customer has already paid for. Throwing here would abort that handler.
    const stripe = {
      checkout: {
        sessions: {
          async retrieve() { throw new Error('stripe is down'); },
        },
      },
    };
    assert.equal(await fetchCheckoutReceiptUrl(stripe, 'cs_1'), null);
  });

  test('no session id means no call and no receipt', async () => {
    let called = false;
    const stripe = {
      checkout: { sessions: { async retrieve() { called = true; return {}; } } },
    };
    assert.equal(await fetchCheckoutReceiptUrl(stripe, null), null);
    assert.equal(called, false, 'must not call Stripe with an empty id');
  });
});
