/**
 * BILL-006 — the email outbox, its worker, and the templates.
 *
 * The suppression tests encode a compliance rule that runs BOTH ways, and
 * getting either direction wrong is a real problem: a receipt that honours a
 * marketing opt-out means charging someone and refusing to tell them; a
 * lifecycle email that ignores one is an unsolicited marketing send.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import {
  enqueueEmail, claimDueEmails, markSent, markFailed, markSuppressed,
  suppressionReason, backoffSeconds, MAX_ATTEMPTS,
} from './email-outbox.js';
import { RENDERERS } from './email-worker.js';
import { billingEmailTemplates } from '../email.service.js';

describe('enqueueEmail', () => {
  test('queues a job with its payload captured at enqueue time', async () => {
    const sql = createFakeSql();
    sql.when(/INSERT INTO email_sends/, [{ id: 1 }]);

    const result = await enqueueEmail(sql, {
      userId: 7, recipient: 'a@b.c', template: 'billing.upgrade',
      eventKey: 'plan_change:disc-1', payload: { amountCharged: '$24.13' },
    });

    assert.deepEqual(result, { enqueued: true, duplicate: false });
    const q = sql.matching(/INSERT INTO email_sends/)[0];
    assert.ok(q.params.includes('billing.upgrade'));
    assert.ok(q.params.includes('plan_change:disc-1'));
    assert.match(String(q.params[5]), /24\.13/, 'the payload must be stored, not rebuilt later');
  });

  test('IDEMPOTENCY: the same event queued twice sends once', async () => {
    const seen = new Set<string>();
    const sql = createFakeSql();
    sql.when(/INSERT INTO email_sends/, (params) => {
      const key = `${params[2]}|${params[4]}`; // template | event_key
      if (seen.has(key)) return [];            // ON CONFLICT DO NOTHING
      seen.add(key);
      return [{ id: 1 }];
    });

    const input = {
      userId: 7, recipient: 'a@b.c', template: 'billing.upgrade',
      eventKey: 'plan_change:disc-1', payload: {},
    };
    const first = await enqueueEmail(sql, input);
    const second = await enqueueEmail(sql, input);
    const third = await enqueueEmail(sql, input);

    assert.equal(first.enqueued, true);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
  });

  test('a queue failure NEVER propagates — billing has already completed', async () => {
    const sql = createFakeSql().failOn(/INSERT INTO email_sends/);
    const result = await enqueueEmail(sql, {
      userId: 7, recipient: 'a@b.c', template: 'billing.upgrade', eventKey: 'k', payload: {},
    });
    assert.deepEqual(result, { enqueued: false, duplicate: false });
  });

  test('refuses to queue with no recipient rather than creating a doomed job', async () => {
    const sql = createFakeSql();
    const result = await enqueueEmail(sql, {
      userId: 7, recipient: '', template: 'billing.upgrade', eventKey: 'k', payload: {},
    });
    assert.equal(result.enqueued, false);
    assert.equal(sql.countMatching(/INSERT INTO email_sends/), 0);
  });
});

describe('claimDueEmails', () => {
  test('claims with SKIP LOCKED so parallel workers do not collide', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, recipient/, [
      { id: 1, user_id: 7, recipient: 'a@b.c', template: 'billing.upgrade', category: 'transactional', event_key: 'k', attempts: 0, payload: {} },
    ]);

    const jobs = await claimDueEmails(sql, 10);

    assert.equal(jobs.length, 1);
    const select = sql.matching(/FROM email_sends/)[0];
    assert.match(select.text, /FOR UPDATE SKIP LOCKED/);
    // Claimed and counted in the same transaction, so a crash leaves rows
    // visibly stuck rather than silently re-sent.
    assert.match(sql.matching(/UPDATE email_sends/)[0].text, /status = 'sending', attempts = attempts \+ 1/);
  });

  test('an empty queue does no writes', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, recipient/, []);
    assert.deepEqual(await claimDueEmails(sql), []);
    assert.equal(sql.countMatching(/UPDATE email_sends/), 0);
  });
});

describe('retry and dead-lettering', () => {
  test('backoff grows and is capped at 24 hours', () => {
    assert.equal(backoffSeconds(1), 60);
    assert.equal(backoffSeconds(2), 300);
    assert.equal(backoffSeconds(3), 1500);
    assert.equal(backoffSeconds(10), 86400, 'must cap, not grow unbounded');
  });

  test('a transient failure schedules a retry', async () => {
    const sql = createFakeSql();
    const job = { id: 1, user_id: 7, recipient: 'a@b.c', template: 'billing.upgrade', category: 'transactional' as const, event_key: 'k', attempts: 2, payload: {} };

    const { deadLettered } = await markFailed(sql, job, 'ESP 500');

    assert.equal(deadLettered, false);
    const q = sql.matching(/UPDATE email_sends/)[0];
    assert.match(q.text, /status = 'failed'/);
    assert.ok(q.params.includes(300), 'next attempt scheduled with backoff');
  });

  test('the final attempt dead-letters instead of retrying forever', async () => {
    const sql = createFakeSql();
    const job = { id: 1, user_id: 7, recipient: 'a@b.c', template: 'billing.upgrade', category: 'transactional' as const, event_key: 'k', attempts: MAX_ATTEMPTS, payload: {} };

    const { deadLettered } = await markFailed(sql, job, 'ESP down all day');

    assert.equal(deadLettered, true);
    assert.match(sql.matching(/UPDATE email_sends/)[0].text, /status = 'dead_letter'/);
  });

  test('a success records the send', async () => {
    const sql = createFakeSql();
    await markSent(sql, 1, 'msg-123');
    const q = sql.matching(/UPDATE email_sends/)[0];
    assert.match(q.text, /status = 'sent'/);
    assert.ok(q.params.includes('msg-123'));
  });

  test('suppression is recorded distinctly from failure', async () => {
    const sql = createFakeSql();
    await markSuppressed(sql, 1, 'user unsubscribed');
    assert.match(sql.matching(/UPDATE email_sends/)[0].text, /status = 'suppressed'/);
  });
});

describe('suppressionReason — the compliance rule, both directions', () => {
  test('a marketing opt-out does NOT suppress a billing receipt', () => {
    // Charging someone and then refusing to tell them is the failure this
    // guards against.
    assert.equal(
      suppressionReason({ marketing_opt_out_at: new Date() }, 'transactional'),
      null,
    );
  });

  test('a marketing opt-out DOES suppress a lifecycle email', () => {
    assert.match(
      String(suppressionReason({ marketing_opt_out_at: new Date() }, 'lifecycle')),
      /unsubscribed/,
    );
  });

  test('a hard bounce suppresses EVERYTHING, receipts included', () => {
    // The receipt will not arrive regardless, and continuing to send damages
    // deliverability for every other customer.
    assert.match(String(suppressionReason({ email_hard_bounced_at: new Date() }, 'transactional')), /bounce/);
    assert.match(String(suppressionReason({ email_hard_bounced_at: new Date() }, 'lifecycle')), /bounce/);
  });

  test('internal accounts get no lifecycle mail but may still get receipts', () => {
    assert.match(String(suppressionReason({ is_internal: true }, 'lifecycle')), /internal/);
    assert.equal(suppressionReason({ is_internal: true }, 'transactional'), null);
  });

  test('a closed account gets no lifecycle mail', () => {
    assert.match(String(suppressionReason({ status: 'closed' }, 'lifecycle')), /closed/);
    assert.match(String(suppressionReason({ deleted_at: new Date() }, 'lifecycle')), /deleted/);
  });

  test('an ordinary user is not suppressed', () => {
    assert.equal(suppressionReason({}, 'transactional'), null);
    assert.equal(suppressionReason({}, 'lifecycle'), null);
    assert.equal(suppressionReason(null, 'lifecycle'), null);
  });
});

describe('templates', () => {
  const upgradePayload = {
    firstName: 'Sam',
    oldPlan: 'Grow',
    newPlan: 'Optimize',
    amountCharged: '$24.13',
    lines: [
      { description: 'Unused time on Grow', amount: '-$12.00' },
      { description: 'Remaining time on Optimize', amount: '$36.13' },
    ],
    nextAmount: '$99.00',
    nextBillingDate: 'September 2, 2026',
    cardBrand: 'visa',
    cardLast4: '4242',
    billingUrl: 'https://account.example/credits',
    timezone: 'UTC',
  };

  test('the upgrade receipt states both plans, the amount, and the next charge', () => {
    const out = billingEmailTemplates.billingPlanChanged(upgradePayload);
    for (const part of [out.html, out.text]) {
      assert.match(part, /Grow/);
      assert.match(part, /Optimize/);
      assert.match(part, /\$24\.13/);
      assert.match(part, /\$99\.00/);
      assert.match(part, /September 2, 2026/);
      assert.match(part, /4242/);
    }
    assert.match(out.subject, /Optimize/);
  });

  test('BOTH html and plain text render — a text-only client must not get an empty message', () => {
    const out = billingEmailTemplates.billingPlanChanged(upgradePayload);
    assert.ok(out.html.length > 200);
    assert.ok(out.text.length > 100);
    assert.ok(!out.text.includes('<'), 'the text part must not contain markup');
  });

  test('a zero-dollar upgrade renders without implying a charge', () => {
    const out = billingEmailTemplates.billingPlanChanged({
      ...upgradePayload, amountCharged: '$0.00', lines: [],
    });
    assert.match(out.text, /\$0\.00/);
  });

  test('a first subscription renders with no previous plan', () => {
    const out = billingEmailTemplates.billingPlanChanged({ ...upgradePayload, oldPlan: null });
    assert.match(out.subject, /is active/);
    assert.ok(!out.text.includes('moved from'));
  });

  test('NO SECRETS: nothing PAN-shaped, no tokens, in either part', () => {
    const out = billingEmailTemplates.billingPlanChanged(upgradePayload);
    for (const part of [out.html, out.text, out.subject]) {
      assert.ok(!/\b\d{13,19}\b/.test(part), 'something PAN-shaped is in the email');
      assert.ok(!/sk_(test|live)_/.test(part), 'a secret key is in the email');
      assert.ok(!/seti_|pi_.*_secret/.test(part), 'a client secret is in the email');
    }
  });

  test('the cancellation email states the exact access-end date and how to come back', () => {
    const out = billingEmailTemplates.billingCancelled({
      firstName: 'Sam', planName: 'Optimize', accessUntil: 'September 2, 2026',
      creditsNote: 'You have 120 credits remaining.',
      resubscribeUrl: 'https://account.example/credits?view=plans',
      billingUrl: 'https://account.example/credits',
      timezone: 'UTC',
    });

    for (const part of [out.html, out.text]) {
      assert.match(part, /September 2, 2026/);
      assert.match(part, /120 credits/);
      assert.match(part, /UTC/, 'the timezone must be explicit');
      assert.match(part, /view=plans/);
    }
    assert.match(out.subject, /ends September 2, 2026/);
  });

  test('cancellation with no remaining credits still renders sensibly', () => {
    const out = billingEmailTemplates.billingCancelled({
      firstName: 'Sam', planName: 'Grow', accessUntil: 'October 1, 2026',
      creditsNote: 'You have no remaining credits on your account.',
      resubscribeUrl: 'u', billingUrl: 'b',
    });
    assert.match(out.text, /no remaining credits/);
  });

  test('the placeholder templates are unmistakably not final copy', () => {
    // BILL-007/008 require obvious placeholder text so nobody ships it by
    // accident believing it was reviewed.
    const expiry = billingEmailTemplates.creditsExpiringPlaceholder({
      firstName: 'Sam', expiringAmount: '50 content credits', expiryDate: 'September 1, 2026',
      remainingAfter: '10 credits', ctaUrl: 'https://x', leadTimeLabel: 'in 14 days',
    });
    assert.match(expiry.subject, /PLACEHOLDER/);
    assert.match(expiry.html, /PLACEHOLDER/);

    const inactivity = billingEmailTemplates.inactivityPlaceholder({
      firstName: 'Sam', creditBalance: '120 credits', nearestExpiry: 'September 1, 2026',
      planName: 'Grow', ctaUrl: 'https://x',
    });
    assert.match(inactivity.subject, /PLACEHOLDER/);
    // …but the DATA is real, so the copy owner can see what they are writing around.
    assert.match(inactivity.text, /120 credits/);
    assert.match(inactivity.text, /Grow/);
  });
});

describe('the renderer registry', () => {
  test('every template the billing code queues has a renderer', () => {
    // A missing renderer dead-letters the email, so this is the guard against
    // a receipt silently never arriving because of a typo.
    for (const name of ['billing.upgrade', 'billing.cancellation', 'lifecycle.credit_expiry', 'lifecycle.inactivity']) {
      assert.equal(typeof RENDERERS[name], 'function', `no renderer for ${name}`);
    }
  });
});
