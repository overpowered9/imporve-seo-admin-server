import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import {
  REFUND_REASON,
  findRefundableKeywordDebits,
  refundKeywordDebits,
  type SqlTag,
} from './keyword-refunds.js';

const debit = (o: Record<string, any>) => ({
  id: '1', user_id: 7, website_id: 3, generation_id: 'gen-1', amount: 1, created_at: '2026-10-13T08:00:38Z', ...o,
});

describe('findRefundableKeywordDebits — the query', () => {
  const run = async (onlyUser: number | null = null) => {
    const sql = createFakeSql();
    await findRefundableKeywordDebits(sql as unknown as SqlTag, onlyUser);
    assert.equal(sql.queries.length, 1);
    return sql.queries[0];
  };

  test('takes only keyword debits', async () => {
    const q = await run();
    assert.match(q.text, /ct\.delta < 0/);
    assert.match(q.text, /ct\.reason LIKE 'Keyword research:%' OR ct\.reason LIKE 'Plugin keyword:%'/);
  });

  test('scopes to each account\'s CURRENT cycle', async () => {
    const q = await run();
    assert.match(q.text, /MAX\(cycle_started_at\) AS cycle_start FROM credit_balances GROUP BY user_id/);
    assert.match(q.text, /ct\.created_at >= b\.cycle_start/);
  });

  test('skips a debit that already has its refund, matched on generation_id and the refund reason', async () => {
    const q = await run();
    assert.match(q.text, /NOT EXISTS \( SELECT 1 FROM credit_transactions r WHERE r\.user_id = ct\.user_id AND r\.delta > 0 AND r\.generation_id = ct\.generation_id AND r\.reason LIKE \?\)/);
    assert.ok(q.params.includes(`${REFUND_REASON}%`));
  });

  test('--user narrows to one account; without it every account is in scope', async () => {
    assert.ok((await run(36)).params.includes(36));
    assert.ok((await run(null)).params.includes(null));
  });
});

describe('findRefundableKeywordDebits — what it returns', () => {
  test('a debit without a generation_id is reported, never refunded (it could not be matched on a re-run)', async () => {
    const sql = createFakeSql().when(/FROM credit_transactions ct/, [
      debit({ id: '1', generation_id: 'gen-1' }),
      debit({ id: '2', generation_id: null }),
      debit({ id: '3', generation_id: '' }),
    ]);
    const s = await findRefundableKeywordDebits(sql as unknown as SqlTag);
    assert.deepEqual(s.refundable.map((d) => d.id), ['1']);
    assert.deepEqual(s.unmatched.map((d) => d.id), ['2', '3']);
  });

  test('normalises ids and amounts from the driver\'s types', async () => {
    const sql = createFakeSql().when(/FROM credit_transactions ct/, [
      debit({ id: 99, user_id: '7', website_id: null, generation_id: 1234, amount: '1' }),
    ]);
    const [d] = (await findRefundableKeywordDebits(sql as unknown as SqlTag)).refundable;
    assert.deepEqual(
      { id: d.id, user_id: d.user_id, website_id: d.website_id, generation_id: d.generation_id, amount: d.amount },
      { id: '99', user_id: 7, website_id: null, generation_id: '1234', amount: 1 },
    );
  });
});

describe('refundKeywordDebits', () => {
  const selection = {
    refundable: [
      debit({ id: '1', user_id: 7, generation_id: 'g1' }),
      debit({ id: '2', user_id: 7, generation_id: 'g2' }),
      debit({ id: '3', user_id: 9, website_id: null, generation_id: 'g3', amount: 2 }),
    ],
    unmatched: [debit({ id: '4', generation_id: null })],
  };

  test('a dry run refunds nothing but totals what it would', async () => {
    const calls: any[] = [];
    const s = await refundKeywordDebits(selection, async (...a) => { calls.push(a); }, false);
    assert.equal(calls.length, 0);
    assert.equal(s.apply, false);
    assert.equal(s.debits, 3);
    assert.equal(s.credits, 4);
    assert.deepEqual(Object.fromEntries(s.byUser), { 7: { debits: 2, credits: 2 }, 9: { debits: 1, credits: 2 } });
    assert.equal(s.unmatched, 1);
  });

  test('--apply refunds each debit once, with its amount, website and generation id', async () => {
    const calls: any[] = [];
    await refundKeywordDebits(selection, async (...a) => { calls.push(a); }, true);
    assert.deepEqual(calls, [
      [7, 1, REFUND_REASON, 3, 'g1'],
      [7, 1, REFUND_REASON, 3, 'g2'],
      [9, 2, REFUND_REASON, null, 'g3'],
    ]);
  });

  test('nothing selected means nothing refunded', async () => {
    const calls: any[] = [];
    const s = await refundKeywordDebits({ refundable: [], unmatched: [] }, async (...a) => { calls.push(a); }, true);
    assert.equal(calls.length, 0);
    assert.equal(s.credits, 0);
  });
});
