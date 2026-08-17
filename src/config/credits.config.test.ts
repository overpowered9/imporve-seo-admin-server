/**
 * The fail-closed guarantee.
 *
 * credits.config.ts must THROW at import when any ISEO_* price or grant is missing or malformed.
 * That is the property standing between a misconfigured deploy and a server that happily generates
 * articles at 0 credits, so it gets an explicit test rather than being left to a manual check.
 *
 * These assertions are the reason there are no in-code default prices. If someone ever "helpfully"
 * adds `|| 10` to a price, the missing-var cases below start failing.
 *
 * The module is re-imported per case with a mutated process.env. A cache-busting query string on
 * the import specifier is what forces a fresh module evaluation — ESM caches by resolved URL, so
 * without it every case after the first would reuse the first case's frozen table.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const REQUIRED = [
  'ISEO_COST_CONTENT_SMALL',
  'ISEO_COST_CONTENT_MEDIUM',
  'ISEO_COST_CONTENT_LARGE',
  'ISEO_COST_CONTENT_REGEN_SMALL',
  'ISEO_COST_CONTENT_REGEN_MEDIUM',
  'ISEO_COST_CONTENT_REGEN_LARGE',
  'ISEO_COST_IMAGE',
  'ISEO_COST_IMAGE_REGEN',
  'ISEO_COST_KEYWORDS',
  'ISEO_GRANT_FREE',
  'ISEO_GRANT_GROW',
  'ISEO_GRANT_SCALE',
  'ISEO_GRANT_ENTERPRISE',
] as const;

/** The finalized .env.sample values, so the test exercises the real shipping configuration. */
const VALID: Record<string, string> = {
  ISEO_COST_CONTENT_SMALL: '6',
  ISEO_COST_CONTENT_MEDIUM: '10',
  ISEO_COST_CONTENT_LARGE: '14',
  ISEO_COST_CONTENT_REGEN_SMALL: '4',
  ISEO_COST_CONTENT_REGEN_MEDIUM: '6',
  ISEO_COST_CONTENT_REGEN_LARGE: '8',
  ISEO_COST_IMAGE: '5',
  ISEO_COST_IMAGE_REGEN: '3',
  ISEO_COST_KEYWORDS: '1',
  ISEO_GRANT_FREE: '30',
  ISEO_GRANT_GROW: '300',
  ISEO_GRANT_SCALE: '1000',
  ISEO_GRANT_ENTERPRISE: '5000',
};

let saved: Record<string, string | undefined> = {};
let bust = 0;

/** Fresh evaluation of the module under the current process.env. */
async function loadConfig() {
  bust += 1;
  return await import(`./credits.config.js?fail_closed_case=${bust}`);
}

beforeEach(() => {
  saved = {};
  for (const k of REQUIRED) {
    saved[k] = process.env[k];
    process.env[k] = VALID[k];
  }
});

afterEach(() => {
  for (const k of REQUIRED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('credits.config fail-closed', () => {
  test('loads and prices correctly when every value is present', async () => {
    const { creditsConfig, priceOfSanityCheck } = (await loadConfig()) as any;
    assert.equal(creditsConfig.costs.content.medium, 10);
    assert.equal(creditsConfig.costs.content.small, 6);
    assert.equal(creditsConfig.costs.content.large, 14);
    assert.equal(creditsConfig.costs.content_regen.medium, 6);
    assert.equal(creditsConfig.costs.image, 5);
    assert.equal(creditsConfig.costs.image_regen, 3);
    assert.equal(creditsConfig.costs.keywords, 1);
    assert.equal(creditsConfig.grants.grow, 300);
    assert.equal(typeof priceOfSanityCheck, 'undefined'); // no accidental export creep
  });

  test('every regen price is strictly below its first-generation price', async () => {
    const { creditsConfig } = (await loadConfig()) as any;
    for (const size of ['small', 'medium', 'large'] as const) {
      assert.ok(
        creditsConfig.costs.content_regen[size] < creditsConfig.costs.content[size],
        `content_regen.${size} (${creditsConfig.costs.content_regen[size]}) must be below content.${size} (${creditsConfig.costs.content[size]})`,
      );
    }
    assert.ok(creditsConfig.costs.image_regen < creditsConfig.costs.image);
  });

  test('the config table is frozen — no runtime write path can move a price', async () => {
    const { creditsConfig } = (await loadConfig()) as any;
    assert.ok(Object.isFrozen(creditsConfig));
    assert.ok(Object.isFrozen(creditsConfig.costs));
    assert.ok(Object.isFrozen(creditsConfig.costs.content));
    assert.ok(Object.isFrozen(creditsConfig.grants));
  });

  test('THROWS when any single required var is missing', async () => {
    for (const missing of REQUIRED) {
      const keep = process.env[missing];
      delete process.env[missing];
      await assert.rejects(
        loadConfig(),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // The error must name the offending variable, or a 3am deploy failure is unreadable.
          assert.match(msg, /Invalid ISEO credit configuration/);
          assert.ok(msg.includes(missing), `error should name ${missing}, got: ${msg}`);
          return true;
        },
        `expected a throw when ${missing} is unset`,
      );
      process.env[missing] = keep;
    }
  });

  test('THROWS on malformed values rather than coercing them', async () => {
    // '' and 'abc' would become NaN, and '0'/'-5'/'2.5' would silently make actions free or
    // fractional. Each must abort boot instead.
    for (const bad of ['', '   ', 'abc', '0', '-5', '2.5', '1e3', 'ten']) {
      process.env.ISEO_COST_CONTENT_MEDIUM = bad;
      await assert.rejects(
        loadConfig(),
        /Invalid ISEO credit configuration/,
        `expected a throw for ISEO_COST_CONTENT_MEDIUM=${JSON.stringify(bad)}`,
      );
    }
    process.env.ISEO_COST_CONTENT_MEDIUM = VALID.ISEO_COST_CONTENT_MEDIUM;
  });

  test('the fingerprint changes when a price changes, so deploys are distinguishable', async () => {
    const a = (await loadConfig()) as any;
    process.env.ISEO_COST_CONTENT_MEDIUM = '11';
    const b = (await loadConfig()) as any;
    assert.notEqual(a.creditsConfigHash, b.creditsConfigHash);
    process.env.ISEO_COST_CONTENT_MEDIUM = VALID.ISEO_COST_CONTENT_MEDIUM;
  });

  test('an unknown plan slug degrades to the free grant instead of throwing or granting freely', async () => {
    const { grantForPlanSlug } = (await loadConfig()) as any;
    assert.equal(grantForPlanSlug('grow'), 300);
    assert.equal(grantForPlanSlug('GROW'), 300);   // case-insensitive
    assert.equal(grantForPlanSlug('nonsense'), 30); // falls back to free
    assert.equal(grantForPlanSlug(undefined), 30);
    assert.equal(grantForPlanSlug(null), 30);
  });
});
