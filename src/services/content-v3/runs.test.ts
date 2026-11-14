import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRunsStore, retryPendingRefunds, REQUEST_ID_RE, RunNotRunningError } from './runs.js';

const P = { user_id: 7, website_id: 3, session_key: 'iseo_tk_0123456789abcdef', stale_after_ms: 60_000 };

describe('run ledger (B-3): one charge per click', () => {
  test('a new request is claimed; the same request, finished, replays its stored answer', async () => {
    const runs = createMemoryRunsStore();
    const first = await runs.claim({ ...P, request_id: 'req_aaaaaaaa' });
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') return;
    await runs.charged(first.id, { cost: 10, action: 'content', variant: 'medium' });
    await runs.succeeded(first.id, { generation_id: 555, response: { success: true, data: { content: '<p>x</p>' } }, step_costs: { writer: 0.2 }, timings: { total_ms: 1 } });
    const again = await runs.claim({ ...P, request_id: 'req_aaaaaaaa' });
    assert.equal(again.kind, 'replay');
    assert.deepEqual(again.kind === 'replay' && again.response, { success: true, data: { content: '<p>x</p>' } });
  });

  test('one running article per session: the same click and a different click are both busy', async () => {
    const runs = createMemoryRunsStore();
    assert.equal((await runs.claim({ ...P, request_id: 'req_aaaaaaaa' })).kind, 'claimed');
    assert.equal((await runs.claim({ ...P, request_id: 'req_aaaaaaaa' })).kind, 'busy');
    assert.equal((await runs.claim({ ...P, request_id: 'req_bbbbbbbb' })).kind, 'busy', 'a second tab or a double click');
    // Another session of the same user is independent.
    assert.equal((await runs.claim({ ...P, session_key: 'iseo_tk_ffffffffffffffff', request_id: 'req_cccccccc' })).kind, 'claimed');
  });

  test('a failed (refunded) click can be retried with the same request id', async () => {
    const runs = createMemoryRunsStore();
    const c = await runs.claim({ ...P, request_id: 'req_aaaaaaaa' });
    assert.equal(c.kind, 'claimed');
    if (c.kind !== 'claimed') return;
    await runs.charged(c.id, { cost: 10, action: 'content', variant: 'medium' });
    await runs.failed(c.id, { error: 'writer: overloaded', refund_pending: false });
    assert.equal(runs.rows[0].status, 'refunded');
    const retry = await runs.claim({ ...P, request_id: 'req_aaaaaaaa' });
    assert.equal(retry.kind, 'claimed');
    assert.equal(runs.rows[0].cost, 0, 'the retry starts uncharged');
  });

  test('a running row from a dead process is closed: refund_pending when it was charged, failed when not', async () => {
    let t = 1_000_000;
    const runs = createMemoryRunsStore(() => t);
    const a = await runs.claim({ ...P, request_id: 'req_aaaaaaaa' });
    if (a.kind !== 'claimed') throw new Error('claim');
    await runs.charged(a.id, { cost: 14, action: 'content', variant: 'large' });
    t += 61_000;
    assert.equal((await runs.claim({ ...P, request_id: 'req_bbbbbbbb' })).kind, 'claimed', 'the stale run no longer blocks the session');
    assert.equal(runs.rows[0].status, 'refund_pending');
    // An uncharged stale run just fails.
    const other = createMemoryRunsStore(() => t);
    await other.claim({ ...P, request_id: 'req_cccccccc' });
    t += 61_000;
    await other.claim({ ...P, request_id: 'req_dddddddd' });
    assert.equal(other.rows[0].status, 'failed');
  });

  test('refund retry: refund_pending → refunded on success; back to pending on failure; never throws', async () => {
    const runs = createMemoryRunsStore();
    const c = await runs.claim({ ...P, request_id: 'req_aaaaaaaa' });
    if (c.kind !== 'claimed') throw new Error('claim');
    await runs.charged(c.id, { cost: 10, action: 'content', variant: 'medium' });
    await runs.failed(c.id, { error: 'x', refund_pending: true });
    const logs: string[] = [];
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error('billing down');
    };
    assert.deepEqual(await retryPendingRefunds(runs, flaky, (l) => logs.push(l)), { refunded: 0, failed: 1 });
    assert.equal(runs.rows[0].status, 'refund_pending');
    assert.match(logs.join('\n'), /REFUND FAILED \(will retry\) run=iseo_tk_\w+ id=1 user=7 amount=10/);
    assert.deepEqual(await retryPendingRefunds(runs, flaky, (l) => logs.push(l)), { refunded: 1, failed: 0 });
    assert.equal(runs.rows[0].status, 'refunded');
    assert.deepEqual(await retryPendingRefunds(runs, flaky, () => {}), { refunded: 0, failed: 0 }, 'nothing left to retry');
  });

  test('L2: charged / succeeded / failed only move a row that is still running', async () => {
    const runs = createMemoryRunsStore();
    const c = await runs.claim({ ...P, request_id: 'req_bbbbbbbb' });
    if (c.kind !== 'claimed') throw new Error('claim');
    await runs.charged(c.id, { cost: 10, action: 'content', variant: 'medium' });
    await runs.failed(c.id, { error: 'x', refund_pending: true });
    await assert.rejects(runs.succeeded(c.id, { generation_id: 1, response: {}, step_costs: {}, timings: {} }), RunNotRunningError);
    await assert.rejects(runs.charged(c.id, { cost: 10, action: 'content', variant: 'medium' }), RunNotRunningError);
    assert.equal(runs.rows[0].status, 'refund_pending', 'a refund-pending row is never turned into a free article');
  });

  test('H2: the sweep closes runs whose process stopped; charged ones are then refunded', async () => {
    let t = 1_000_000;
    const runs = createMemoryRunsStore(() => t);
    const a = await runs.claim({ ...P, request_id: 'req_cccccccc' });
    const b = await runs.claim({ ...P, session_key: 'iseo_tk_other00000000000000', request_id: 'req_dddddddd' });
    if (a.kind !== 'claimed' || b.kind !== 'claimed') throw new Error('claim');
    await runs.charged(a.id, { cost: 10, action: 'content', variant: 'medium' });
    t += 5 * 60_000;
    assert.equal(await runs.sweepStale(9 * 60_000), 0, 'still within the deadline');
    t += 10 * 60_000;
    assert.equal(await runs.sweepStale(9 * 60_000), 2);
    assert.deepEqual(runs.rows.map((r) => r.status), ['refund_pending', 'failed']);
    const refunded: number[] = [];
    await retryPendingRefunds(runs, async (_u, cost) => { refunded.push(cost); }, () => {});
    assert.deepEqual(refunded, [10]);
    assert.equal(runs.rows[0].status, 'refunded');
  });

  test('H2: a refund that went through is never queued again, even when the ledger update fails', async () => {
    const runs = createMemoryRunsStore();
    const c = await runs.claim({ ...P, request_id: 'req_eeeeeeee' });
    if (c.kind !== 'claimed') throw new Error('claim');
    await runs.charged(c.id, { cost: 6, action: 'content', variant: 'small' });
    await runs.failed(c.id, { error: 'x', refund_pending: true });
    const realDone = runs.refundDone;
    runs.refundDone = async () => { throw new Error('database blip'); };
    let refunds = 0;
    const logs: string[] = [];
    assert.deepEqual(await retryPendingRefunds(runs, async () => { refunds++; }, (l) => logs.push(l)), { refunded: 1, failed: 0 });
    runs.refundDone = realDone;
    await retryPendingRefunds(runs, async () => { refunds++; }, () => {});
    assert.equal(refunds, 1, 'refunded exactly once');
    assert.match(logs.join('\n'), /REFUND APPLIED, LEDGER NOT UPDATED run=iseo_tk_\w+ id=1 user=7 amount=6/);
    assert.equal((await runs.stuckRefunding(-1)).length, 1, 'reported for a person to close');
  });

  test('M2: Leave removes the stored answers (the article) of the session', async () => {
    const runs = createMemoryRunsStore();
    const c = await runs.claim({ ...P, request_id: 'req_ffffffff' });
    if (c.kind !== 'claimed') throw new Error('claim');
    await runs.succeeded(c.id, { generation_id: 9, response: { data: { content: '<p>article</p>' } }, step_costs: {}, timings: {} });
    assert.equal(await runs.forgetResponses(7, P.session_key), 1);
    assert.equal(runs.rows[0].response, null);
    assert.equal(runs.rows[0].status, 'succeeded', 'the run and its billing stay');
  });

  test('request ids: 8–120 of [A-Za-z0-9_-]', () => {
    assert.ok(REQUEST_ID_RE.test('iseo_rq_0123456789abcdef'));
    assert.ok(!REQUEST_ID_RE.test('short'));
    assert.ok(!REQUEST_ID_RE.test('has spaces in it'));
  });
});
