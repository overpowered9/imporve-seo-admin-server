import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planProductCopy } from './plan-product.js';

describe('planProductCopy', () => {
  test('names the plan the customer picked, with what it gives them', () => {
    assert.deepEqual(planProductCopy({ slug: 'basic', name: 'Grow', credits: 220, pieces: 11 }), {
      name: 'Grow plan',
      description:
        'You will receive 220 credits per month, which equals about 11 pieces of local SEO content with AI image.',
    });
  });

  test('uses the customer-facing name, not the stale column', () => {
    // subscription_plans.name still says "Starter Plan" / "Pro Plan".
    assert.equal(planProductCopy({ slug: 'starter', name: 'Starter Plan', credits: 600, pieces: 31 }).name, 'Optimize plan');
    assert.equal(planProductCopy({ slug: 'pro', name: 'Pro Plan', credits: 1500, pieces: 78 }).name, 'Scale plan');
  });

  test('a single piece is not pluralised, and large grants are grouped', () => {
    const copy = planProductCopy({ slug: 'pro', credits: 1500, pieces: 1 });
    assert.match(copy.description, /1,500 credits/);
    assert.match(copy.description, /about 1 piece of/);
  });

  test('an unknown plan reads as itself', () => {
    assert.equal(planProductCopy({ slug: 'agency', name: 'Agency Plan', credits: 5000, pieces: 263 }).name, 'Agency plan');
  });
});
