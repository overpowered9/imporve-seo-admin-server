/**
 * Tests for the test doubles themselves.
 *
 * A fake that quietly lies makes every test built on it worthless — and the
 * rollback modelling in fake-sql is load-bearing for BILL-001's "a failure of
 * either leaves no partial state" criterion. So the doubles get their own
 * coverage before anything relies on them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from './fake-sql.js';
import { createFakeStripe, makeCard, makeCustomer, makeSubscription } from './fake-stripe.js';

describe('fake-sql', () => {
  test('records queries with their parameters', async () => {
    const sql = createFakeSql();
    await sql`SELECT * FROM users WHERE id = ${7}`;
    assert.equal(sql.queries.length, 1);
    assert.equal(sql.queries[0].text, 'SELECT * FROM users WHERE id = ?');
    assert.deepEqual(sql.queries[0].params, [7]);
  });

  test('returns canned rows for a matching pattern', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT .* FROM users/, [{ id: 7, email: 'a@b.c' }]);
    const rows = await sql`SELECT id, email FROM users WHERE id = ${7}`;
    assert.deepEqual(rows, [{ id: 7, email: 'a@b.c' }]);
  });

  test('unmatched queries return no rows rather than throwing', async () => {
    const sql = createFakeSql();
    assert.deepEqual(await sql`UPDATE users SET name = ${'x'}`, []);
  });

  test('a transaction that throws discards its queries', async () => {
    const sql = createFakeSql();
    await sql`SELECT 1`;
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`INSERT INTO a VALUES (${1})`;
        throw new Error('boom');
      }),
      /boom/,
    );
    // The INSERT must not be visible: that is what "no partial state" means.
    assert.equal(sql.countMatching(/INSERT INTO a/), 0);
    assert.equal(sql.rolledBack.length, 1);
    assert.equal(sql.queries.length, 1); // only the SELECT before the block
  });

  test('a transaction that commits publishes its queries', async () => {
    const sql = createFakeSql();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO a VALUES (${1})`;
      await tx`UPDATE b SET c = ${2}`;
    });
    assert.equal(sql.countMatching(/INSERT INTO a/), 1);
    assert.equal(sql.countMatching(/UPDATE b/), 1);
    assert.equal(sql.rolledBack.length, 0);
  });

  test('failCommit rolls back a body that itself succeeded', async () => {
    const sql = createFakeSql().failCommit();
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`INSERT INTO a VALUES (${1})`;
      }),
      /forced commit failure/,
    );
    assert.equal(sql.countMatching(/INSERT INTO a/), 0);
  });

  test('failOnce fails only the first matching query', async () => {
    const sql = createFakeSql().failOnce(/UPDATE users/);
    await assert.rejects(sql`UPDATE users SET a = ${1}`);
    await sql`UPDATE users SET a = ${2}`; // must not throw
  });
});

describe('fake-stripe', () => {
  test('models the customer default payment method as state', async () => {
    const s = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      cards: [makeCard({ id: 'pm_1', customer: 'cus_1' })],
    });
    let customer = await s.api.customers.retrieve('cus_1');
    assert.equal(customer.invoice_settings.default_payment_method, null);

    await s.api.customers.update('cus_1', {
      invoice_settings: { default_payment_method: 'pm_1' },
    });
    customer = await s.api.customers.retrieve('cus_1');
    assert.equal(customer.invoice_settings.default_payment_method, 'pm_1');
  });

  test('detaching the default card clears the default, as Stripe does', async () => {
    const s = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } })],
      cards: [makeCard({ id: 'pm_1', customer: 'cus_1' })],
    });
    await s.api.paymentMethods.detach('pm_1');
    const customer = await s.api.customers.retrieve('cus_1');
    assert.equal(customer.invoice_settings.default_payment_method, null);
    assert.equal((await s.api.paymentMethods.list({ customer: 'cus_1' })).data.length, 0);
  });

  test('subscription updates mutate state and are recorded', async () => {
    const s = createFakeStripe({
      subscriptions: [makeSubscription({ id: 'sub_1', cancel_at_period_end: true })],
    });
    await s.api.subscriptions.update('sub_1', { cancel_at_period_end: false });
    const sub = await s.api.subscriptions.retrieve('sub_1');
    assert.equal(sub.cancel_at_period_end, false);
    assert.equal(s.callsTo('subscriptions.update').length, 1);
  });

  test('armed failures throw for the named method only', async () => {
    const s = createFakeStripe({ customers: [makeCustomer({ id: 'cus_1' })] });
    s.failNext('customers.update', new Error('stripe is down'));
    await assert.rejects(
      s.api.customers.update('cus_1', { invoice_settings: { default_payment_method: 'pm_1' } }),
      /stripe is down/,
    );
    await s.api.customers.retrieve('cus_1'); // unaffected
  });
});
