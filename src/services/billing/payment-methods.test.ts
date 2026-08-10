/**
 * BILL-001 — default payment method.
 *
 * The regression test the ticket asks for is `first card added → default set in
 * BOTH our DB and Stripe`. On the pre-fix code the local half could not pass:
 * there was no local column and no write, so the assertion on
 * users.default_payment_method_id fails by construction. It passes now.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import { createFakeStripe, makeCard, makeCustomer } from '../../test/helpers/fake-stripe.js';
import {
  chooseDefaultPaymentMethod,
  describePaymentMethod,
  describePaymentError,
  ensureDefaultPaymentMethod,
  getLocalDefaultPaymentMethod,
} from './payment-methods.js';

/**
 * A fake DB whose users row behaves like a real one for these columns.
 *
 * The stored default is DERIVED FROM THE COMMITTED QUERY LOG rather than from a
 * mutable variable the responder pokes. That distinction matters: a responder
 * that mutates on every write would record changes made inside a transaction
 * that later rolled back, making the rollback test assert something true of the
 * fake and false of Postgres. Reading the committed log gives the answer a real
 * database would give.
 *
 * Read-your-own-write within a transaction is not modelled, and need not be:
 * ensureDefaultPaymentMethod reads the row before it writes it, so no SELECT
 * has to observe an uncommitted UPDATE from the same block.
 */
function sqlWithUser(initial: string | null = null) {
  const sql = createFakeSql();

  const storedDefault = (): string | null => {
    const writes = sql.matching(/UPDATE users SET default_payment_method_id/);
    if (writes.length === 0) return initial;
    const last = writes[writes.length - 1];
    // `SET … = NULL` is inlined in the SQL text and carries no parameter.
    return /= NULL/.test(last.text) ? null : (last.params[0] ?? null);
  };

  sql.when(/SELECT id, default_payment_method_id FROM users/, () => [
    { id: 1, default_payment_method_id: storedDefault() },
  ]);
  sql.when(/SELECT default_payment_method_id/, () => {
    const id = storedDefault();
    return [id ? { id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } : { id: null }];
  });

  return { sql, storedDefault };
}

describe('chooseDefaultPaymentMethod (precedence)', () => {
  const older = makeCard({ id: 'pm_old', created: 1000 });
  const newer = makeCard({ id: 'pm_new', created: 2000 });

  test('no cards at all yields no default', () => {
    assert.equal(chooseDefaultPaymentMethod({ attached: [] }), null);
  });

  test('an existing Stripe default is respected over everything else', () => {
    const chosen = chooseDefaultPaymentMethod({
      attached: [older, newer],
      stripeDefaultId: 'pm_old',
      preferredId: 'pm_new',
    });
    assert.equal(chosen.id, 'pm_old');
  });

  test('a Stripe default pointing at a detached card is ignored', () => {
    const chosen = chooseDefaultPaymentMethod({
      attached: [newer],
      stripeDefaultId: 'pm_deleted',
    });
    assert.equal(chosen.id, 'pm_new');
  });

  test('our local record is used when Stripe has lost its default', () => {
    const chosen = chooseDefaultPaymentMethod({
      attached: [older, newer],
      stripeDefaultId: null,
      localDefaultId: 'pm_old',
    });
    assert.equal(chosen.id, 'pm_old');
  });

  test('the card just added wins when neither side has a default', () => {
    const chosen = chooseDefaultPaymentMethod({
      attached: [older, newer],
      preferredId: 'pm_old',
    });
    assert.equal(chosen.id, 'pm_old');
  });

  test('otherwise the most recently created card is chosen', () => {
    const chosen = chooseDefaultPaymentMethod({ attached: [older, newer] });
    assert.equal(chosen.id, 'pm_new');
  });
});

describe('describePaymentMethod', () => {
  test('keeps only brand, last four and expiry — never the PAN', () => {
    const pm: any = {
      id: 'pm_1',
      card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031, number: '4242424242424242', cvc: '123' },
    };
    const described = describePaymentMethod(pm);
    assert.deepEqual(described, {
      id: 'pm_1', brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031,
    });
    // The serialised form must not carry anything resembling card data.
    const json = JSON.stringify(described);
    assert.ok(!json.includes('4242424242424242'), 'PAN leaked into the described payment method');
    assert.ok(!json.includes('"cvc"'), 'CVC leaked into the described payment method');
  });
});

describe('ensureDefaultPaymentMethod', () => {
  test('the FIRST card added becomes the default in our DB and in Stripe', async () => {
    const { sql, storedDefault } = sqlWithUser(null);
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      cards: [makeCard({ id: 'pm_1', customer: 'cus_1' })],
    });

    const result = await ensureDefaultPaymentMethod({ sql, stripe: stripe.api }, 1, 'cus_1', 'pm_1');

    assert.equal(result?.id, 'pm_1');
    assert.equal(result?.last4, '4242');
    // Provider side.
    const customer = await stripe.api.customers.retrieve('cus_1');
    assert.equal(customer.invoice_settings.default_payment_method, 'pm_1');
    // Our side. This is the half that could not pass before migration 006.
    assert.equal(storedDefault(), 'pm_1');
  });

  test('a SECOND card does not displace the existing default', async () => {
    const { sql, storedDefault } = sqlWithUser('pm_1');
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1', invoice_settings: { default_payment_method: 'pm_1' } })],
      cards: [
        makeCard({ id: 'pm_1', customer: 'cus_1', created: 1000 }),
        makeCard({ id: 'pm_2', customer: 'cus_1', created: 2000 }),
      ],
    });

    const result = await ensureDefaultPaymentMethod({ sql, stripe: stripe.api }, 1, 'cus_1', 'pm_2');

    assert.equal(result?.id, 'pm_1');
    assert.equal(storedDefault(), 'pm_1');
    // Nothing was written, because nothing needed to change.
    assert.equal(stripe.callsTo('customers.update').length, 0);
  });

  test('is idempotent — a second call writes nothing', async () => {
    const { sql } = sqlWithUser(null);
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      cards: [makeCard({ id: 'pm_1', customer: 'cus_1' })],
    });
    const deps = { sql, stripe: stripe.api };

    const first = await ensureDefaultPaymentMethod(deps, 1, 'cus_1');
    const second = await ensureDefaultPaymentMethod(deps, 1, 'cus_1');

    assert.deepEqual(first, second);
    assert.equal(stripe.callsTo('customers.update').length, 1, 'second call must not re-write Stripe');
  });

  test('a Stripe failure leaves NO local default behind (rollback)', async () => {
    const { sql, storedDefault } = sqlWithUser(null);
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      cards: [makeCard({ id: 'pm_1', customer: 'cus_1' })],
    });
    stripe.failNext('customers.update', new Error('stripe unavailable'));

    await assert.rejects(
      ensureDefaultPaymentMethod({ sql, stripe: stripe.api }, 1, 'cus_1', 'pm_1'),
      /stripe unavailable/,
    );

    // The UPDATE ran inside the transaction, so it must have been discarded.
    assert.equal(sql.countMatching(/UPDATE users SET default_payment_method_id = \?/), 0);
    assert.ok(sql.rolledBack.length > 0, 'expected the local write to be rolled back');
    assert.equal(storedDefault(), null);
    // Stripe has no default either: no partial state on either side.
    const customer = await stripe.api.customers.retrieve('cus_1');
    assert.equal(customer.invoice_settings.default_payment_method, null);
  });

  test('repairs divergence: Stripe has a default, we do not', async () => {
    const { sql, storedDefault } = sqlWithUser(null);
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1', invoice_settings: { default_payment_method: 'pm_9' } })],
      cards: [makeCard({ id: 'pm_9', customer: 'cus_1' })],
    });

    const result = await ensureDefaultPaymentMethod({ sql, stripe: stripe.api }, 1, 'cus_1');

    assert.equal(result?.id, 'pm_9');
    assert.equal(storedDefault(), 'pm_9', 'local copy should be back-filled from Stripe');
    assert.equal(stripe.callsTo('customers.update').length, 0, 'Stripe was already correct');
  });

  test('repairs divergence the other way: we have a default, Stripe lost it', async () => {
    const { sql, storedDefault } = sqlWithUser('pm_1');
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })], // no default set
      cards: [
        makeCard({ id: 'pm_1', customer: 'cus_1', created: 1000 }),
        makeCard({ id: 'pm_2', customer: 'cus_1', created: 5000 }),
      ],
    });

    const result = await ensureDefaultPaymentMethod({ sql, stripe: stripe.api }, 1, 'cus_1');

    // Our record wins over "newest card", because it reflects a real prior choice.
    assert.equal(result?.id, 'pm_1');
    assert.equal(storedDefault(), 'pm_1');
    const customer = await stripe.api.customers.retrieve('cus_1');
    assert.equal(customer.invoice_settings.default_payment_method, 'pm_1');
  });

  test('removing the last card clears the local default rather than stranding it', async () => {
    const { sql, storedDefault } = sqlWithUser('pm_1');
    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      cards: [],
    });

    const result = await ensureDefaultPaymentMethod({ sql, stripe: stripe.api }, 1, 'cus_1');

    assert.equal(result, null);
    assert.equal(storedDefault(), null);
  });

  test('CONCURRENCY: two simultaneous add-card requests produce exactly one default', async () => {
    // A lock that actually serialises: the second transaction cannot read the
    // row until the first commits. This is the property SELECT … FOR UPDATE
    // buys, and the reason the promotion is not a plain read-then-write.
    //
    // Built inline rather than via sqlWithUser because the locking responder
    // has to be the FIRST rule registered for that query — createFakeSql
    // answers with the first matching rule, so registering a second one for the
    // same pattern would simply never fire.
    const sql = createFakeSql();
    const storedDefault = (): string | null => {
      const writes = sql.matching(/UPDATE users SET default_payment_method_id/);
      if (writes.length === 0) return null;
      const last = writes[writes.length - 1];
      return /= NULL/.test(last.text) ? null : (last.params[0] ?? null);
    };

    const lock = { held: false, waiters: [] as Array<() => void> };
    sql.when(/SELECT id, default_payment_method_id FROM users/, async () => {
      while (lock.held) await new Promise<void>((resolve) => lock.waiters.push(resolve));
      lock.held = true;
      return [{ id: 1, default_payment_method_id: storedDefault() }];
    });
    // The fast-path read, which deliberately takes no lock.
    sql.when(/SELECT default_payment_method_id/, () => {
      const id = storedDefault();
      return [id ? { id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } : { id: null }];
    });

    const rawBegin = sql.begin.bind(sql);
    (sql as any).begin = async (fn: any) => {
      try {
        return await rawBegin(fn);
      } finally {
        lock.held = false;
        lock.waiters.splice(0).forEach((w) => w());
      }
    };

    const stripe = createFakeStripe({
      customers: [makeCustomer({ id: 'cus_1' })],
      cards: [
        makeCard({ id: 'pm_a', customer: 'cus_1', created: 1000 }),
        makeCard({ id: 'pm_b', customer: 'cus_1', created: 2000 }),
      ],
    });
    // Slow the write so a naive read-then-write would definitely interleave.
    stripe.delay('customers.update', 20);

    const deps = { sql, stripe: stripe.api };
    const [a, b] = await Promise.all([
      ensureDefaultPaymentMethod(deps, 1, 'cus_1', 'pm_a'),
      ensureDefaultPaymentMethod(deps, 1, 'cus_1', 'pm_b'),
    ]);

    assert.equal(a?.id, b?.id, 'the two requests disagreed about the default');
    assert.equal(storedDefault(), a?.id);
    assert.notEqual(storedDefault(), null, 'ended with zero defaults');
    assert.equal(
      stripe.callsTo('customers.update').length, 1,
      'the losing request re-wrote the default',
    );
  });
});

describe('getLocalDefaultPaymentMethod', () => {
  test('returns null when no default is recorded', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT default_payment_method_id/, [{ id: null }]);
    assert.equal(await getLocalDefaultPaymentMethod(sql, 1), null);
  });

  test('returns brand and last four without touching Stripe', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT default_payment_method_id/, [
      { id: 'pm_1', brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 },
    ]);
    assert.deepEqual(await getLocalDefaultPaymentMethod(sql, 1), {
      id: 'pm_1', brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031,
    });
  });
});

describe('describePaymentError', () => {
  test('a decline is retryable, 402, and says what to do', () => {
    const out = describePaymentError({ type: 'StripeCardError', code: 'card_declined' })!;
    assert.equal(out.status, 402);
    assert.equal(out.error_category, 'card_declined');
    assert.equal(out.retryable, true);
    assert.match(out.error, /another card/i);
  });

  test('a missing payment method is reported as such, not as a server error', () => {
    const out = describePaymentError({ code: 'resource_missing' })!;
    assert.equal(out.status, 402);
    assert.equal(out.requires_payment_method, true);
  });

  test('a non-payment error is NOT dressed up as a card problem', () => {
    assert.equal(describePaymentError(new Error('database exploded')), null);
  });

  test('every message avoids dead ends — each names a next action', () => {
    const codes = [
      'card_declined', 'expired_card', 'incorrect_cvc', 'incorrect_number',
      'processing_error', 'insufficient_funds', 'authentication_required',
    ];
    for (const code of codes) {
      const out = describePaymentError({ type: 'StripeCardError', code })!;
      assert.match(
        out.error,
        /try|add|check|contact|complete/i,
        `message for ${code} offers no next step: ${out.error}`,
      );
    }
  });
});
