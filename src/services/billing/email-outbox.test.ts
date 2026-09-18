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
  suppressionReason, backoffSeconds, MAX_ATTEMPTS, normalizePayload,
} from './email-outbox.js';
import { RENDERERS, unrenderedTokensIn } from './email-worker.js';
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

  test('the lifecycle templates carry final copy, not placeholders', () => {
    // This assertion is INVERTED from what it used to say. It previously
    // required the word PLACEHOLDER to be present, which was the right test
    // while the copy was unwritten — but the gate that was supposed to keep
    // those templates off a real domain had already been switched on, so the
    // next account to cross a 14-day expiry boundary would have received them.
    const expiry = billingEmailTemplates.creditsExpiring({
      firstName: 'Sam', expiringAmount: '50 plan credits', expiryDate: 'September 1, 2026',
      remainingAfter: '10 credits', ctaUrl: 'https://x', leadTimeLabel: 'in 14 days', pieces: 7,
    });
    assert.doesNotMatch(expiry.subject, /PLACEHOLDER/i);
    assert.doesNotMatch(expiry.html, /PLACEHOLDER/i);
    assert.match(expiry.text, /50 plan credits/);
    assert.match(expiry.text, /September 1, 2026/);
    assert.match(expiry.text, /7 complete articles/, 'the balance is translated into work the reader recognises');

    const inactivity = billingEmailTemplates.inactivityNudge({
      firstName: 'Sam', creditBalance: '120 credits', nearestExpiry: 'September 1, 2026',
      planName: 'Grow', ctaUrl: 'https://x',
    });
    assert.doesNotMatch(inactivity.subject, /PLACEHOLDER/i);
    assert.match(inactivity.text, /120 credits/);
    assert.match(inactivity.text, /Grow/);

    const trial = billingEmailTemplates.trialEnded({ firstName: 'Sam', ctaUrl: 'https://x' });
    assert.doesNotMatch(trial.subject, /PLACEHOLDER/i);
    assert.match(trial.text, /Free plan/);
  });

  test('a null optional field never reaches the reader as the word "null"', () => {
    // The worker refuses to send anything containing "null", so a template that
    // interpolates an absent field does not produce an ugly email — it produces
    // a dead letter and no email at all. Every optional field must be branched
    // on, and this is the test that keeps that true as templates are added.
    const noExpiry = billingEmailTemplates.inactivityNudge({
      firstName: 'Sam', creditBalance: '120 credits', nearestExpiry: null,
      planName: 'Grow', ctaUrl: 'https://x',
    });
    assert.deepEqual(unrenderedTokensIn(noExpiry), []);

    const openEndedPause = billingEmailTemplates.billingPaused({
      firstName: 'Sam', planName: 'Grow', resumesOn: null,
      creditsNote: 'Your credits stay on your account.', billingUrl: 'https://x',
    });
    assert.deepEqual(unrenderedTokensIn(openEndedPause), []);

    const noCard = billingEmailTemplates.refundIssued({
      firstName: 'Sam', amountRefunded: '$49.00', reasonLabel: 'your Grow subscription',
      cardBrand: null, cardLast4: null, arrivalWindow: '5–10 business days',
      creditsNote: null, billingUrl: 'https://x',
    });
    assert.deepEqual(unrenderedTokensIn(noCard), []);
    assert.match(noCard.text, /your card on file/, 'an unknown card is described honestly, not omitted');
  });
});

/**
 * REGRESSION — "Welcome to undefined".
 *
 * A live customer received an upgrade receipt reading "Welcome to undefined /
 * Hi undefined / Charged today undefined". The existing tests could not catch
 * it because every one of them hands claimDueEmails a payload that is ALREADY
 * an object, which is the one thing production did not do: the row came back
 * from Postgres as a JSON string, and every property access on a string is
 * undefined.
 *
 * So these tests exercise the seam the fake sql used to paper over.
 */
describe('payload round-trip', () => {
  test('a payload that comes back as a JSON string is still an object', () => {
    const p = normalizePayload('{"firstName":"Zaid","newPlan":"Grow","amountCharged":"$49.00"}');
    assert.equal(p.firstName, 'Zaid');
    assert.equal(p.newPlan, 'Grow');
  });

  test('a payload that comes back as an object is passed through untouched', () => {
    const obj = { firstName: 'Zaid' };
    assert.equal(normalizePayload(obj), obj);
  });

  test('unparseable or non-object payloads become {} rather than throwing', () => {
    // Throwing here would be retried six times for a fault no retry can fix.
    assert.deepEqual(normalizePayload('not json at all'), {});
    assert.deepEqual(normalizePayload(null), {});
    assert.deepEqual(normalizePayload(42), {});
    assert.deepEqual(normalizePayload(['a']), {});
  });

  test('claimDueEmails normalises, so the renderer never sees a string', async () => {
    const sql = createFakeSql();
    sql.when(/SELECT id, user_id, recipient/, [{
      id: 1, user_id: 7, recipient: 'a@b.c', template: 'billing.upgrade',
      category: 'transactional', event_key: 'k', attempts: 0,
      // Exactly what production handed the worker.
      payload: '{"firstName":"Zaid","newPlan":"Grow","amountCharged":"$49.00","billingUrl":"https://x"}',
    }]);

    const [job] = await claimDueEmails(sql, 10);

    assert.equal(typeof job.payload, 'object');
    const rendered = RENDERERS['billing.upgrade'](job.payload);
    assert.match(rendered.subject, /Grow/);
    assert.doesNotMatch(rendered.text, /undefined/);
  });
});

describe('the unrendered-token guard', () => {
  test('catches the exact email that reached a customer', () => {
    // Renders billing.upgrade against the empty payload the broken row produced.
    const broken = RENDERERS['billing.upgrade']({});
    const leaked = unrenderedTokensIn(broken);

    assert.ok(leaked.includes('undefined'), 'the guard must catch "Welcome to undefined"');
    assert.match(broken.subject, /undefined/, 'sanity: this really is the broken render');
  });

  test('a correctly rendered receipt passes', () => {
    const good = RENDERERS['billing.upgrade']({
      firstName: 'Zaid', oldPlan: null, newPlan: 'Grow',
      amountCharged: '$49.00', lines: [{ description: 'Grow — first month', amount: '$49.00' }],
      nextAmount: '$49.00', nextBillingDate: 'October 18, 2026',
      cardBrand: 'visa', cardLast4: '4242', billingUrl: 'https://x/credits', timezone: 'UTC',
    });
    assert.deepEqual(unrenderedTokensIn(good), [], 'a good receipt must not be blocked');
  });

  test('catches an object interpolated where a string belonged', () => {
    assert.ok(unrenderedTokensIn({
      subject: 'Your plan changed', text: 'Charged today: [object Object]', html: '',
    }).includes('[object Object]'));
  });

  test('catches a template literal that was never evaluated', () => {
    assert.ok(unrenderedTokensIn({
      subject: 'Welcome to ${planName}', text: 'hi', html: '',
    }).includes('an unevaluated ${...} template literal'));
  });
});

describe('the renderer registry', () => {
  test('every template the billing code queues has a renderer', () => {
    // A missing renderer dead-letters the email, so this is the guard against
    // a receipt silently never arriving because of a typo. Every name here must
    // match a `queueBillingEmail(..., '<name>', ...)` call in stripe.routes.ts
    // or a job's `template` in notification-jobs.ts.
    for (const name of [
      'billing.upgrade', 'billing.downgrade', 'billing.cancellation',
      'billing.paused', 'billing.resumed',
      'billing.credit_purchase', 'billing.renewal', 'billing.refund', 'billing.payment_failed',
      'lifecycle.credit_expiry', 'lifecycle.inactivity', 'lifecycle.trial_ended',
    ]) {
      assert.equal(typeof RENDERERS[name], 'function', `no renderer for ${name}`);
    }
  });

  /**
   * Every template, rendered against a realistic payload, must produce a
   * complete email.
   *
   * This is the test the "Welcome to undefined" bug needed and did not have.
   * It is deliberately a loop over the WHOLE registry rather than one test per
   * template: a new template added without a case here would silently not be
   * covered, whereas a new registry entry with no fixture fails loudly on the
   * `payload` lookup below.
   */
  const FIXTURES: Record<string, any> = {
    'billing.upgrade': {
      firstName: 'Zaid', oldPlan: 'Optimize', newPlan: 'Scale', amountCharged: '$24.13',
      lines: [{ description: 'Scale (prorated)', amount: '$24.13' }],
      nextAmount: '$99.00', nextBillingDate: 'October 18, 2026',
      cardBrand: 'visa', cardLast4: '4242', billingUrl: 'https://x/credits', timezone: 'UTC',
    },
    'billing.downgrade': {
      firstName: 'Zaid', oldPlan: 'Scale', newPlan: 'Optimize', effectiveDate: 'October 18, 2026',
      nextAmount: '$49.00', creditsNote: 'Your existing credits stay on your account.',
      billingUrl: 'https://x/credits', timezone: 'UTC',
    },
    'billing.cancellation': {
      firstName: 'Zaid', planName: 'Scale', accessUntil: 'October 18, 2026',
      creditsNote: 'You have 240 credits remaining.',
      resubscribeUrl: 'https://x/credits?view=plans', billingUrl: 'https://x/credits', timezone: 'UTC',
    },
    'billing.paused': {
      firstName: 'Zaid', planName: 'Scale', resumesOn: null,
      creditsNote: 'Your credits stay on your account.', billingUrl: 'https://x/credits',
    },
    'billing.resumed': {
      firstName: 'Zaid', planName: 'Scale', nextAmount: '$99.00',
      nextBillingDate: 'October 18, 2026', creditsNote: 'Your allowance restarts next cycle.',
      billingUrl: 'https://x/credits', timezone: 'UTC',
    },
    'billing.credit_purchase': {
      firstName: 'Zaid', packName: '500 credits — about 20 pieces', creditsAdded: '500 credits',
      newBalance: '740 credits', amountCharged: '$40.00', cardBrand: 'visa', cardLast4: '4242',
      receiptUrl: 'https://stripe/r', expiresOn: 'September 18, 2027', creditsUrl: 'https://x/credits',
    },
    'billing.renewal': {
      firstName: 'Zaid', planName: 'Scale', amountCharged: '$99.00', periodLabel: 'another month',
      creditsNote: 'Your monthly allowance has been added.', nextBillingDate: 'November 18, 2026',
      cardBrand: 'visa', cardLast4: '4242', receiptUrl: 'https://stripe/r', billingUrl: 'https://x/credits',
      timezone: 'UTC',
    },
    'billing.refund': {
      firstName: 'Zaid', amountRefunded: '$99.00', reasonLabel: 'your ImproveSEO account',
      cardBrand: 'visa', cardLast4: '4242', arrivalWindow: '5–10 business days',
      creditsNote: null, billingUrl: 'https://x/credits',
    },
    'billing.payment_failed': {
      firstName: 'Zaid', planName: 'Scale', amountDue: '$99.00', cardBrand: 'visa', cardLast4: '4242',
      attemptNumber: 1, nextAttemptDate: 'September 22, 2026', accessEndsOn: 'October 2, 2026',
      creditsNote: 'Your plan credits are paused.', updatePaymentUrl: 'https://x/credits',
      invoiceUrl: 'https://stripe/i',
    },
    'lifecycle.credit_expiry': {
      firstName: 'Zaid', expiringAmount: '214 plan credits', expiryDate: 'October 1, 2026',
      remainingAfter: '30 credits', ctaUrl: 'https://x/credits', leadTimeLabel: 'in 14 days', pieces: 8,
    },
    'lifecycle.inactivity': {
      firstName: 'Zaid', creditBalance: '120 credits', nearestExpiry: 'October 1, 2026',
      planName: 'Grow', ctaUrl: 'https://x/overview', pieces: 5,
    },
    'lifecycle.trial_ended': {
      firstName: 'Zaid', ctaUrl: 'https://x/credits', pagesCreated: 3, freeBalance: '10 credits',
    },
  };

  for (const name of Object.keys(RENDERERS)) {
    test(`${name} renders a complete email`, () => {
      const payload = FIXTURES[name];
      assert.ok(payload, `no fixture for ${name} — add one when you add a template`);

      const rendered = RENDERERS[name](payload);

      assert.ok(rendered.subject.length > 0, 'a subject line');
      assert.ok(rendered.html.includes('<html'), 'a full HTML document');
      assert.ok(rendered.text.length > 0, 'a plain-text part — mail without one scores as spam');
      assert.deepEqual(unrenderedTokensIn(rendered), [], 'no placeholder tokens leaked');
      assert.doesNotMatch(rendered.subject, /PLACEHOLDER/i);
      // The reader's name proves the payload reached the template at all —
      // the exact thing that silently failed in production.
      assert.match(rendered.text, /Zaid/);
    });
  }

  test('an unknown template is not silently rendered as something else', () => {
    assert.equal(RENDERERS['billing.nonexistent'], undefined);
  });
});
