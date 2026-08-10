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
