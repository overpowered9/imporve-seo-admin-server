/**
 * The wording of the ledger is the specification, so it is tested as one.
 *
 * These assert the exact strings the customer sees in Account Activity. If a
 * line here is meant to change, change it here first — the failures will name
 * every producer that has to move with it. That is the property the inline
 * strings did not have, and it is why "billed on your next invoice" outlived
 * the behaviour it described.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeTrialStarted, describeTrialEnded,
  describeSubscriptionStarted, describeSubscriptionRenewed,
  describeSubscriptionCancelled, describeSubscriptionReactivated,
  describePlanUpgraded, describePlanDowngradeScheduled, describePlanDowngraded,
  describeCreditPurchase, describeRefund, describeCreditAdjustment,
  describePaymentFailed, describeCreditsExpired,
  planUpgradeConfirmation,
  planDowngradeConfirmation,
  reactivationConfirmation,
} from './descriptions.js';

describe('the requested catalogue, line for line', () => {
  test('every line matches what was specified', () => {
    assert.equal(describeTrialStarted(7), 'Free trial started — 7 days');
    assert.equal(describeTrialEnded(), 'Free trial ended — moved to Free plan');
    assert.equal(describeSubscriptionStarted('Grow'), 'Subscription started — Grow plan');
    assert.equal(describeSubscriptionRenewed('Grow'), 'Subscription renewed — Grow plan');
    assert.equal(describeSubscriptionCancelled('Grow'), 'Subscription canceled — Grow plan');
    assert.equal(describeSubscriptionReactivated('Grow'), 'Subscription reactivated — Grow plan');
    assert.equal(
      describePlanUpgraded('Grow', 'Optimize'),
      'Plan upgraded — Grow → Optimize (prorated)',
    );
    assert.equal(
      describePlanDowngradeScheduled('Optimize', 'Grow', '2026-09-19T00:00:00Z'),
      'Plan downgrade scheduled — Optimize → Grow, effective Sep 19, 2026',
    );
    assert.equal(describePlanDowngraded('Optimize', 'Grow'), 'Plan downgraded — Optimize → Grow');
    assert.equal(describeCreditPurchase(60), 'Credit pack purchase — 60 credits');
    assert.equal(
      describeCreditPurchase(60, true),
      'Credit pack purchase — 60 credits (Free plan rate)',
    );
    assert.equal(describeRefund(), 'Refund — issued by support');
    assert.equal(
      describeCreditAdjustment(50),
      'Credit adjustment — 50 credits added by support',
    );
    assert.equal(
      describeCreditAdjustment(-50),
      'Credit adjustment — 50 credits removed by support',
    );
  });
});

describe('plan names are normalised', () => {
  test('a trailing "Plan" is not repeated', () => {
    // The API sends the current plan as "Grow" and the pending one as
    // "Grow Plan"; without this the column reads "Grow Plan plan".
    assert.equal(describeSubscriptionStarted('Grow Plan'), 'Subscription started — Grow plan');
    assert.equal(describePlanUpgraded('Grow Plan', 'Optimize Plan'),
      'Plan upgraded — Grow → Optimize (prorated)');
  });

  test('a missing plan name drops the detail rather than inventing one', () => {
    // Never "Subscription started —  plan" with a hole in it, and never a
    // placeholder like "your plan plan". The event alone is still true.
    assert.equal(describeSubscriptionStarted(null), 'Subscription started');
    assert.equal(describeSubscriptionStarted('   '), 'Subscription started');
    assert.equal(describePlanUpgraded(null, null), 'Plan upgraded (prorated)');
    // Knowing only the destination is still worth saying.
    assert.equal(describePlanUpgraded(null, 'Optimize'), 'Plan upgraded — Optimize (prorated)');
  });
});

describe('the upgrade line no longer promises a future invoice', () => {
  test('says prorated, not "billed on your next invoice"', () => {
    // The exact contradiction the customer reported: the dialog said the card
    // was charged, this line said it would be billed later.
    const line = describePlanUpgraded('Grow', 'Optimize');
    assert.ok(!/next invoice/i.test(line), line);
    assert.ok(/\(prorated\)$/.test(line), line);
  });
});

describe('dates and edge cases', () => {
  test('a downgrade with no date still reads as a sentence', () => {
    assert.equal(
      describePlanDowngradeScheduled('Optimize', 'Grow', null),
      'Plan downgrade scheduled — Optimize → Grow, effective at the end of your billing period',
    );
  });

  test('an unparseable date is treated as absent, never "Invalid Date"', () => {
    const line = describePlanDowngradeScheduled('Optimize', 'Grow', 'not-a-date');
    assert.ok(!/Invalid/.test(line), line);
    assert.ok(/end of your billing period/.test(line), line);
  });

  test('the date is rendered in UTC, so it cannot drift a day by server timezone', () => {
    // A DATE at midnight UTC read in a western timezone lands on the previous
    // day — the off-by-one that has bitten this codebase before.
    assert.match(
      describePlanDowngradeScheduled('A', 'B', '2026-09-19T00:00:00Z'),
      /Sep 19, 2026/,
    );
  });

  test('one day is singular', () => {
    assert.equal(describeTrialStarted(1), 'Free trial started — 1 day');
  });

  test('large credit counts are grouped for legibility', () => {
    assert.equal(describeCreditPurchase(1500), 'Credit pack purchase — 1,500 credits');
    assert.equal(describeCreditsExpired(-1200), 'Credits expired — 1,200 credits');
  });

  test('an adjustment of zero does not claim a removal', () => {
    assert.equal(describeCreditAdjustment(0), 'Credit adjustment — 0 credits added by support');
  });

  test('payment failure keeps its existing wording', () => {
    assert.equal(describePaymentFailed(), 'Payment failed — subscription suspended');
  });
});

describe('plans are named the way the customer knows them', () => {
  // subscription_plans.name still holds the ORIGINAL names. Every screen, and
  // every line QA specified, uses the current ones. Without the mapping the
  // ledger reads "Upgraded Starter Plan → Pro Plan" — which is what production
  // actually contains, and what nobody recognises.
  test('the real database names map to the product names', () => {
    assert.equal(describeSubscriptionStarted('Starter Plan'), 'Subscription started — Optimize plan');
    assert.equal(describeSubscriptionStarted('Pro Plan'), 'Subscription started — Scale plan');
    assert.equal(describeSubscriptionStarted('Grow'), 'Subscription started — Grow plan');
  });

  test('a transition names both ends correctly', () => {
    assert.equal(
      describePlanUpgraded('Grow', 'Starter Plan'),
      'Plan upgraded — Grow → Optimize (prorated)',
    );
    assert.equal(
      describePlanDowngraded('Pro Plan', 'Starter Plan'),
      'Plan downgraded — Scale → Optimize',
    );
  });

  test('matching is case-insensitive and ignores the "Plan" suffix', () => {
    for (const variant of ['Pro', 'pro', 'Pro Plan', 'PRO PLAN', '  Pro  ']) {
      assert.equal(describeSubscriptionStarted(variant), 'Subscription started — Scale plan', variant);
    }
  });

  test('slugs resolve too, since callers are not consistent about which they pass', () => {
    assert.equal(describeSubscriptionStarted('basic'), 'Subscription started — Grow plan');
    assert.equal(describeSubscriptionStarted('starter'), 'Subscription started — Optimize plan');
  });

  test('an unknown plan keeps its own name rather than becoming a placeholder', () => {
    // A plan added to the table later should read as itself, not "Unknown".
    assert.equal(
      describeSubscriptionStarted('Agency Plan'),
      'Subscription started — Agency plan',
    );
  });
});

describe('the downgrade confirmation', () => {
  // An account renewing 20 Sep: the change lands ON that date, so the Optimize
  // plan's last day is the 19th, and both the new plan and the payment start on
  // the 20th.
  const base = {
    fromPlan: 'Optimize',
    toPlan: 'Grow',
    nextBillingDate: '2026-09-20T00:00:00Z',
    nextAmountCents: 950,
    currency: 'usd',
  };

  test('reads exactly as specified', () => {
    assert.equal(
      planDowngradeConfirmation(base),
      'You stay on the Optimize plan until Sep 19, 2026.'
      + ' The Grow plan starts on Sep 20, 2026.\n'
      + 'No charge today. Your next payment is $9.50 on Sep 20, 2026.\n'
      + 'Your current credits are unaffected and keep their existing expiry dates.',
    );
  });

  test('never prints a raw Date, which is the bug it replaces', () => {
    // The old line interpolated the Date object itself, so customers read
    // "Sun Sep 20 2026 00:00:00 GMT+0000 (Coordinated Universal Time)".
    const msg = planDowngradeConfirmation({
      ...base, nextBillingDate: new Date('2026-09-20T00:00:00Z'),
    });
    assert.ok(!/GMT|Coordinated Universal Time|00:00:00/.test(msg), msg);
    assert.ok(msg.includes('Sep 19, 2026') && msg.includes('Sep 20, 2026'));
  });

  test('crossing a month boundary', () => {
    const msg = planDowngradeConfirmation({ ...base, nextBillingDate: '2026-10-01T00:00:00Z' });
    assert.ok(msg.includes('until Sep 30, 2026'), msg);
    assert.ok(msg.includes('starts on Oct 1, 2026'), msg);
  });

  test('crossing a year boundary', () => {
    const msg = planDowngradeConfirmation({ ...base, nextBillingDate: '2027-01-01T00:00:00Z' });
    assert.ok(msg.includes('until Dec 31, 2026'), msg);
    assert.ok(msg.includes('starts on Jan 1, 2027'), msg);
  });

  test('a leap day is not skipped', () => {
    const msg = planDowngradeConfirmation({ ...base, nextBillingDate: '2028-03-01T00:00:00Z' });
    assert.ok(msg.includes('until Feb 29, 2028'), msg);
  });

  test('without a date it degrades to a phrase, never to "Invalid Date"', () => {
    const msg = planDowngradeConfirmation({ ...base, nextBillingDate: null });
    assert.equal(
      msg,
      'You stay on the Optimize plan until the end of your billing period.'
      + ' The Grow plan starts then.\n'
      + 'No charge today.\n'
      + 'Your current credits are unaffected and keep their existing expiry dates.',
    );
    assert.ok(!/Invalid|NaN|null|undefined/.test(msg));
  });

  test('without plan names it still says something true', () => {
    const msg = planDowngradeConfirmation({ ...base, fromPlan: null, toPlan: undefined });
    assert.ok(msg.startsWith('You stay on your current plan until Sep 19, 2026.'), msg);
    assert.ok(msg.includes('Your new plan starts on Sep 20, 2026.'), msg);
  });

  test('"Grow Plan" and "Grow" produce the same sentence', () => {
    // The database stores both shapes, and the copy already says "plan".
    assert.equal(
      planDowngradeConfirmation({ ...base, toPlan: 'Grow Plan' }),
      planDowngradeConfirmation(base),
    );
  });

  test('the credit reassurance survives every degraded input', () => {
    // "Am I about to lose the credits I paid for?" is the actual fear behind a
    // downgrade, and the sentence this replaces never addressed it.
    for (const over of [{}, { nextBillingDate: null }, { fromPlan: null, toPlan: null }]) {
      assert.ok(
        planDowngradeConfirmation({ ...base, ...over })
          .includes('Your current credits are unaffected and keep their existing expiry dates.'),
      );
    }
  });
});

describe('the upgrade confirmation states real numbers', () => {
  const base = {
    planName: 'Optimize',
    chargedCents: 1524,
    currency: 'usd',
    nextBillingDate: '2026-09-19T00:00:00Z',
    creditsGranted: 360,
    creditsTotal: 994,
  };

  test('reads exactly as specified', () => {
    assert.equal(
      planUpgradeConfirmation(base),
      "You're now on the Optimize plan\n"
      + 'We charged $15.24 — the prorated amount for the rest of this billing cycle.'
      + ' Full billing starts Sep 19, 2026.\n'
      + '360 credits added. You now have a total of 994 credits.',
    );
  });

  test('replaces the vague sentence it supersedes', () => {
    const msg = planUpgradeConfirmation(base);
    assert.ok(!/Credits have been added to your account/.test(msg));
    assert.ok(!/Prorated charge applied/.test(msg));
  });

  test('a zero charge says why, instead of implying we forgot to bill', () => {
    const msg = planUpgradeConfirmation({ ...base, chargedCents: 0 });
    assert.match(msg, /No charge today — the unused part of your previous plan covered the change\./);
    assert.ok(!/We charged/.test(msg));
  });

  test('a deferred charge does not claim money already moved', () => {
    // The fallback when collection failed: the old copy asserted a charge that
    // had not happened, which is the bug being fixed.
    const msg = planUpgradeConfirmation({ ...base, chargedCents: null });
    assert.match(msg, /will appear on your next invoice/);
    assert.ok(!/We charged/.test(msg));
  });

  test('missing pieces degrade without leaving holes', () => {
    const msg = planUpgradeConfirmation({
      planName: null, chargedCents: null, nextBillingDate: null,
      creditsGranted: 0, creditsTotal: null,
    });
    assert.ok(!/undefined|null|NaN|Invalid/.test(msg), msg);
    assert.match(msg, /You're now on your new plan/);
  });

  test('a plan named "Optimize Plan" does not become "Optimize Plan plan"', () => {
    assert.match(planUpgradeConfirmation({ ...base, planName: 'Optimize Plan' }),
      /You're now on the Optimize plan/);
  });

  test('large balances are grouped', () => {
    assert.match(
      planUpgradeConfirmation({ ...base, creditsGranted: 1150, creditsTotal: 12345 }),
      /1,150 credits added\. You now have a total of 12,345 credits\./,
    );
  });
});

describe('the reactivation confirmation', () => {
  test('matches the CMS wording exactly', () => {
    // Reactivation is reachable from the Credits page (built client-side) and
    // from Manage Plans (this message). Both must read identically, or the same
    // action says different things depending on which button was used.
    assert.equal(
      reactivationConfirmation({
        planName: 'Optimize',
        nextBillingDate: '2026-09-19T00:00:00Z',
        credits: 634,
      }),
      "You're back on the Optimize plan."
      + ' No charge today — your next payment is due on Sep 19, 2026.\n'
      + 'Your 634 credits were preserved.',
    );
  });

  test('replaces the copy that offered reassurance instead of facts', () => {
    const msg = reactivationConfirmation({
      planName: 'Optimize', nextBillingDate: '2026-09-19T00:00:00Z', credits: 634,
    });
    assert.ok(!/Billing continues as normal/.test(msg), msg);
    assert.ok(!/is active again/.test(msg), msg);
  });

  test('omits the credit line rather than claiming zero', () => {
    const msg = reactivationConfirmation({ planName: 'Grow', credits: 0 });
    assert.ok(!/preserved/.test(msg), msg);
  });

  test('degrades without holes', () => {
    const msg = reactivationConfirmation({ planName: null, credits: null });
    assert.ok(!/undefined|null|NaN|Invalid/.test(msg), msg);
    assert.match(msg, /^You're back on your plan\./);
  });

  test('"Optimize Plan" does not become "the Optimize Plan plan"', () => {
    assert.match(
      reactivationConfirmation({ planName: 'Optimize Plan', credits: 1 }),
      /You're back on the Optimize plan\./,
    );
  });
});
