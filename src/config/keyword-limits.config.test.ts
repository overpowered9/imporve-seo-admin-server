import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowanceTierFor,
  keywordDailyLimitFor,
  offersManualListsHint,
  nextUtcMidnight,
} from './keyword-limits.config.js';

const noEnv = {} as NodeJS.ProcessEnv;

describe('keywordDailyLimitFor', () => {
  test('product defaults, keyed by the real slugs (basic is Grow, starter Optimize, pro Scale)', () => {
    assert.equal(keywordDailyLimitFor({ slug: 'free', isPaid: false }, noEnv), 10);
    assert.equal(keywordDailyLimitFor({ slug: 'basic', isPaid: true }, noEnv), 20);
    assert.equal(keywordDailyLimitFor({ slug: 'starter', isPaid: true }, noEnv), 50);
    assert.equal(keywordDailyLimitFor({ slug: 'pro', isPaid: true }, noEnv), 50);
  });

  test('slug matching ignores case and surrounding whitespace', () => {
    assert.equal(keywordDailyLimitFor({ slug: ' Basic ', isPaid: true }, noEnv), 20);
  });

  test('an unknown slug is placed by price — paying customers are not held to the free allowance', () => {
    assert.equal(keywordDailyLimitFor({ slug: 'enterprise', isPaid: true }, noEnv), 50);
    assert.equal(keywordDailyLimitFor({ slug: 'enterprise', isPaid: false }, noEnv), 10);
    assert.equal(keywordDailyLimitFor({ slug: null, isPaid: false }, noEnv), 10);
  });

  test('prototype property names are not mistaken for plan slugs', () => {
    assert.equal(allowanceTierFor({ slug: 'toString', isPaid: false }), 'free');
    assert.equal(allowanceTierFor({ slug: '__proto__', isPaid: false }), 'free');
  });

  test('a valid env override replaces the default for that tier only', () => {
    const env = { KEYWORD_DAILY_LIMIT_BASIC: '25' } as NodeJS.ProcessEnv;
    assert.equal(keywordDailyLimitFor({ slug: 'basic', isPaid: true }, env), 25);
    assert.equal(keywordDailyLimitFor({ slug: 'free', isPaid: false }, env), 10);
  });

  test('a malformed override falls back to the default instead of disabling the limit', () => {
    for (const raw of ['', '0', '-3', '1.5', 'abc', ' ']) {
      const env = { KEYWORD_DAILY_LIMIT_BASIC: raw } as NodeJS.ProcessEnv;
      assert.equal(keywordDailyLimitFor({ slug: 'basic', isPaid: true }, env), 20, `override "${raw}"`);
    }
  });
});

describe('offersManualListsHint', () => {
  test('only Optimize and Scale are pointed at manual keyword lists', () => {
    assert.equal(offersManualListsHint({ slug: 'free', isPaid: false }), false);
    assert.equal(offersManualListsHint({ slug: 'basic', isPaid: true }), false);
    assert.equal(offersManualListsHint({ slug: 'starter', isPaid: true }), true);
    assert.equal(offersManualListsHint({ slug: 'pro', isPaid: true }), true);
  });

  test('follows the tier an unknown slug is placed in', () => {
    assert.equal(offersManualListsHint({ slug: 'enterprise', isPaid: true }), true);
    assert.equal(offersManualListsHint({ slug: 'enterprise', isPaid: false }), false);
  });
});

describe('nextUtcMidnight', () => {
  test('is the start of the next UTC day', () => {
    assert.equal(nextUtcMidnight(new Date('2026-09-11T23:59:59.999Z')).toISOString(), '2026-09-12T00:00:00.000Z');
    assert.equal(nextUtcMidnight(new Date('2026-09-11T00:00:00.000Z')).toISOString(), '2026-09-12T00:00:00.000Z');
  });

  test('rolls over months and years', () => {
    assert.equal(nextUtcMidnight(new Date('2026-12-31T10:00:00.000Z')).toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(nextUtcMidnight(new Date('2028-02-28T12:00:00.000Z')).toISOString(), '2028-02-29T00:00:00.000Z');
  });
});
