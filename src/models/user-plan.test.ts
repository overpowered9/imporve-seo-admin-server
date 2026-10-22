/**
 * What a support agent is told about the requester's plan.
 *
 * ── WHY THIS IS TESTED AT ALL ───────────────────────────────────────────────
 * The ticket queue reported two faults, and both are decisions this one pure
 * function makes:
 *
 *  1. The plan names shown were outdated. `subscription_plans.name` still holds
 *     the ORIGINAL names — "Starter Plan", "Pro Plan" — while the product calls
 *     those Optimize and Scale, and the 950-cent plan whose slug is 'basic' is
 *     called Grow. Handing the column straight to the panel names a plan no
 *     customer recognises, and an agent quoting it is quoting a plan that does
 *     not exist by that name any more.
 *
 *  2. A free trial was indistinguishable from a lapsed free account. They are
 *     the same row: both sit on the $0 plan and only the trial end separates
 *     them. That difference decides how a ticket gets answered — a prospect
 *     mid-trial and a churned user are not the same correspondent.
 *
 * These are assertions on behaviour rather than on source text because the
 * function is pure and reachable: the SQL feeding it is what the source-assertion
 * tests in this directory cover.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeUserPlan, planOptionLabel } from './user-plan.js';

/** Days from now, as the timestamp the users table would hold. */
const daysFromNow = (n: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

describe('describeUserPlan — the name the customer knows', () => {
  test("slug 'basic' is Grow, never Basic — it is the 950-cent paid plan", () => {
    const plan = describeUserPlan({
      plan_slug: 'basic',
      plan_name: 'Basic Plan',
      plan_price_cents: 950,
      user_created_at: daysFromNow(-400),
    });
    assert.equal(plan.plan_display_name, 'Grow');
    assert.equal(plan.on_trial, false);
  });

  test("slug 'starter' is Optimize and 'pro' is Scale", () => {
    const optimize = describeUserPlan({
      plan_slug: 'starter',
      plan_name: 'Starter Plan',
      plan_price_cents: 2500,
      user_created_at: daysFromNow(-400),
    });
    const scale = describeUserPlan({
      plan_slug: 'pro',
      plan_name: 'Pro Plan',
      plan_price_cents: 4900,
      user_created_at: daysFromNow(-400),
    });
    assert.equal(optimize.plan_display_name, 'Optimize');
    assert.equal(scale.plan_display_name, 'Scale');
  });

  test('the outdated raw name still resolves when no slug came back', () => {
    const plan = describeUserPlan({
      plan_name: 'Pro Plan',
      plan_price_cents: 4900,
      user_created_at: daysFromNow(-400),
    });
    assert.equal(plan.plan_display_name, 'Scale');
  });

  test('the raw name is kept alongside, so the panel can still show it', () => {
    const plan = describeUserPlan({
      plan_slug: 'starter',
      plan_name: 'Starter Plan',
      plan_price_cents: 2500,
      user_created_at: daysFromNow(-400),
    });
    assert.equal(plan.plan_name, 'Starter Plan');
    assert.equal(plan.plan_slug, 'starter');
  });

  test('a plan added since this mapping was written reads as itself, not "Unknown"', () => {
    const plan = describeUserPlan({
      plan_slug: 'agency',
      plan_name: 'Agency Plan',
      plan_price_cents: 19900,
      user_created_at: daysFromNow(-400),
    });
    assert.equal(plan.plan_display_name, 'agency');
  });
});

describe('describeUserPlan — a trial is not the free plan', () => {
  test('a free account inside its trial window reads Free Trial', () => {
    const plan = describeUserPlan({
      plan_slug: 'free',
      plan_name: 'Free',
      plan_price_cents: 0,
      trial_ends_at: daysFromNow(3),
      user_created_at: daysFromNow(-4),
    });
    assert.equal(plan.plan_display_name, 'Free Trial');
    assert.equal(plan.on_trial, true);
    assert.equal(plan.trial_expired, false);
  });

  test('the same account once the trial has lapsed reads Basic (free), not Free Trial', () => {
    const plan = describeUserPlan({
      plan_slug: 'free',
      plan_name: 'Free',
      plan_price_cents: 0,
      trial_ends_at: daysFromNow(-1),
      user_created_at: daysFromNow(-8),
    });
    assert.equal(plan.plan_display_name, 'Basic (free)');
    assert.equal(plan.on_trial, false);
    assert.equal(plan.trial_expired, true);
  });

  test('a null trial_ends_at falls back to signup + TRIAL_DAYS rather than "no trial"', () => {
    const fresh = describeUserPlan({
      plan_slug: 'free',
      plan_price_cents: 0,
      trial_ends_at: null,
      user_created_at: daysFromNow(-2),
    });
    assert.equal(fresh.on_trial, true);
    assert.equal(fresh.plan_display_name, 'Free Trial');

    const old = describeUserPlan({
      plan_slug: 'free',
      plan_price_cents: 0,
      trial_ends_at: null,
      user_created_at: daysFromNow(-90),
    });
    assert.equal(old.on_trial, false);
    assert.equal(old.trial_expired, true);
  });

  test('the effective trial end is returned, so the panel can date it', () => {
    const explicit = daysFromNow(3);
    const plan = describeUserPlan({
      plan_slug: 'free',
      plan_price_cents: 0,
      trial_ends_at: explicit,
      user_created_at: daysFromNow(-4),
    });
    assert.equal(plan.trial_ends_at?.getTime(), explicit.getTime());
  });

  test('a PAYING account is never on trial, whatever its trial columns say', () => {
    const plan = describeUserPlan({
      plan_slug: 'pro',
      plan_name: 'Pro Plan',
      plan_price_cents: 4900,
      trial_ends_at: daysFromNow(3),
      user_created_at: daysFromNow(-4),
    });
    assert.equal(plan.plan_display_name, 'Scale');
    assert.equal(plan.on_trial, false);
    assert.equal(plan.trial_expired, false);
  });

  test('a paying account carries NO trial date to render', () => {
    // Every user has a signup date, so the effective-end fallback produces a
    // date for everyone. Returned unguarded, a panel would print "trial ends
    // <date>" beside a customer who has been paying for a year.
    const plan = describeUserPlan({
      plan_slug: 'pro',
      plan_name: 'Pro Plan',
      plan_price_cents: 4900,
      trial_ends_at: null,
      user_created_at: daysFromNow(-450),
    });
    assert.equal(plan.trial_ends_at, null);
    assert.equal(plan.on_trial, false);
    assert.equal(plan.trial_expired, false);
  });

  test('no plan row at all is free, and claims no trial it cannot date', () => {
    const plan = describeUserPlan({});
    assert.equal(plan.plan_display_name, 'Basic (free)');
    assert.equal(plan.on_trial, false);
    assert.equal(plan.trial_expired, false);
    assert.equal(plan.trial_ends_at, null);
  });

  test('an unknown plan_id (no join match) is treated as free, never as paying', () => {
    const plan = describeUserPlan({
      plan_price_cents: null,
      trial_ends_at: daysFromNow(-1),
      user_created_at: daysFromNow(-8),
    });
    assert.equal(plan.plan_display_name, 'Basic (free)');
    assert.equal(plan.on_trial, false);
    assert.equal(plan.trial_expired, true);
  });
  test('a lapsed free account and a trial account never share a label', () => {
    const trial = describeUserPlan({
      plan_slug: 'free', plan_name: 'Free', plan_price_cents: 0,
      trial_ends_at: daysFromNow(3), user_created_at: daysFromNow(-4),
    });
    const basic = describeUserPlan({
      plan_slug: 'free', plan_name: 'Free', plan_price_cents: 0,
      trial_ends_at: daysFromNow(-3), user_created_at: daysFromNow(-10),
    });
    assert.notEqual(trial.plan_display_name, basic.plan_display_name);
  });
});

describe('planOptionLabel — the plan filter names plans the same way', () => {
  test('the paid plans read Grow, Optimize, Scale, not their raw names', () => {
    assert.equal(planOptionLabel({ slug: 'basic', name: 'Grow', price_cents: 950 }), 'Grow');
    assert.equal(planOptionLabel({ slug: 'starter', name: 'Starter Plan', price_cents: 2500 }), 'Optimize');
    assert.equal(planOptionLabel({ slug: 'pro', name: 'Pro Plan', price_cents: 4900 }), 'Scale');
  });
  test('the $0 plan names both accounts it holds', () => {
    assert.equal(planOptionLabel({ slug: 'free', name: 'Free', price_cents: 0 }), 'Free Trial & Basic (free)');
  });
});
