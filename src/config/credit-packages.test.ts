/**
 * Packages, and the "how many pieces is that?" arithmetic.
 *
 * These numbers are customer-facing in two places at once — the storefront
 * label ("about 5 pieces") and the balance panel — so the risk being guarded
 * against is the two drifting apart, or a package being sold at a price nobody
 * checked. The sizing is derived from the live cost table rather than typed in,
 * so a price change moves the labels with it; these tests hold that property.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

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
  ISEO_GRANT_FREE: '100',
  ISEO_GRANT_BASIC: '220',
  ISEO_GRANT_STARTER: '580',
  ISEO_GRANT_PRO: '1150',
  ISEO_PACKAGE_SMALL_CREDITS: '60',
  ISEO_PACKAGE_SMALL_PRICE_CENTS: '400',
  ISEO_PACKAGE_SMALL_PRICE_CENTS_FREE: '500',
  ISEO_PACKAGE_MEDIUM_CREDITS: '140',
  ISEO_PACKAGE_MEDIUM_PRICE_CENTS: '800',
  ISEO_PACKAGE_MEDIUM_PRICE_CENTS_FREE: '1000',
};

let saved: Record<string, string | undefined> = {};
let realCwd = '';
let bust = 0;

// Same hermeticity trick as credits.config.test.ts: credits.config calls
// dotenv.config() itself, which would re-read the developer's real .env on
// every re-import and quietly override what these cases set.
const load = async () => import(`./credits.config.js?packages_case=${(bust += 1)}`);

beforeEach(() => {
  realCwd = process.cwd();
  process.chdir(os.tmpdir());
  saved = {};
  for (const k of Object.keys(VALID)) {
    saved[k] = process.env[k];
    process.env[k] = VALID[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(VALID)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (realCwd) process.chdir(realCwd);
});

describe('credit packages', () => {
  test('a finished piece is priced from the live cost table, not a constant', async () => {
    const { creditsPerPiece } = (await load()) as any;
    // article 10 + image 5 + keywords 1 = 16, plus 0.30x6 and 0.40x3 ≈ 19
    assert.equal(creditsPerPiece(), 19);
  });

  test('changing a price moves the piece cost with it', async () => {
    const before = ((await load()) as any).creditsPerPiece();
    process.env.ISEO_COST_CONTENT_MEDIUM = '20';
    const after = ((await load()) as any).creditsPerPiece();
    assert.ok(after > before, 'a dearer article must make a piece dearer');
    process.env.ISEO_COST_CONTENT_MEDIUM = VALID.ISEO_COST_CONTENT_MEDIUM;
  });

  test('the two packages are ~3 and ~7 pieces', async () => {
    const { creditPackages } = (await load()) as any;
    const packs = creditPackages();
    assert.equal(packs.length, 2, 'the storefront sells two sizes');
    const [small, medium] = packs;
    assert.equal(small.credits, 60);
    assert.equal(small.approx_pieces, 3);   // 60 / 19, floored
    assert.equal(medium.credits, 140);
    assert.equal(medium.approx_pieces, 7);  // 140 / 19, floored
  });

  test('piecesForCredits floors, and never goes negative or NaN', async () => {
    const { piecesForCredits } = (await load()) as any;
    assert.equal(piecesForCredits(100), 5);   // 5.26 — the trial grant
    assert.equal(piecesForCredits(1200), 63); // 63.2
    assert.equal(piecesForCredits(18), 0);    // cannot finish one piece
    assert.equal(piecesForCredits(0), 0);
    assert.equal(piecesForCredits(-5), 0);
    assert.equal(piecesForCredits(NaN), 0);
  });

  test('bigger packages are better value per credit', async () => {
    const { creditPackages } = (await load()) as any;
    const rate = (p: any) => p.price_cents / p.credits;
    const [s, m] = creditPackages();
    assert.ok(rate(m) < rate(s), 'medium must beat small per credit');
  });

  test('subscribers pay less than free accounts, in both sizes', async () => {
    // The reason two prices exist: a top-up is a convenience for a subscriber
    // who ran out mid-cycle, and full price for someone using top-ups INSTEAD
    // of subscribing.
    const { creditPackages } = (await load()) as any;
    for (const p of creditPackages()) {
      assert.ok(
        p.price_cents < p.price_cents_free,
        `${p.id}: subscriber rate ${p.price_cents} must beat free rate ${p.price_cents_free}`,
      );
    }
  });

  test('creditPackPrice picks the tier, and defaults to the dearer one', async () => {
    const { creditPackages, creditPackPrice } = (await load()) as any;
    const [small] = creditPackages();
    assert.equal(creditPackPrice(small, true), 400);
    assert.equal(creditPackPrice(small, false), 500);
    // Anything that is not a subscriber pays the free rate. Quoting the
    // discount and then charging more is the failure worth ruling out.
    assert.equal(creditPackPrice(small, undefined as any), 500);
    assert.equal(creditPackPrice(small, null as any), 500);
  });

  test('creditPackagesForPlan resolves price_cents to the tier', async () => {
    const { creditPackagesForPlan } = (await load()) as any;
    assert.deepEqual(creditPackagesForPlan(true).map((p: any) => p.price_cents), [400, 800]);
    assert.deepEqual(creditPackagesForPlan(false).map((p: any) => p.price_cents), [500, 1000]);
  });

  test('a missing FREE price aborts boot rather than charging everyone the discount', async () => {
    // Half-configured tiers must not silently fall back to the subscriber rate.
    const saved = process.env.ISEO_PACKAGE_SMALL_PRICE_CENTS_FREE;
    delete process.env.ISEO_PACKAGE_SMALL_PRICE_CENTS_FREE;
    await assert.rejects(() => load(), /ISEO_PACKAGE_SMALL_PRICE_CENTS_FREE/);
    process.env.ISEO_PACKAGE_SMALL_PRICE_CENTS_FREE = saved;
  });

  test('top-ups never undercut the subscription rate', async () => {
    // Plan credits run ~$0.043/credit ($9.50/220). A top-up priced below that
    // would make buying credits cheaper than subscribing, which cannibalises
    // the plans the whole business is built on.
    const { creditPackages } = (await load()) as any;
    const planRate = 950 / 220;
    for (const p of creditPackages()) {
      assert.ok(
        p.price_cents / p.credits > planRate,
        `${p.id} at ${(p.price_cents / p.credits).toFixed(3)}c/credit undercuts the plan rate ${planRate.toFixed(3)}`,
      );
    }
  });

  test('packages are frozen — no runtime path can move a price', async () => {
    const { creditPackages } = (await load()) as any;
    for (const p of creditPackages()) assert.ok(Object.isFrozen(p));
  });

  test('an unknown package id resolves to null rather than a default', async () => {
    // Silently falling back to a package would charge for something the caller
    // did not ask for. The route turns null into a 400.
    const { creditPackageById } = (await load()) as any;
    assert.equal(creditPackageById('enterprise'), null);
    assert.equal(creditPackageById(''), null);
    assert.equal(creditPackageById(undefined), null);
    assert.equal(creditPackageById('SMALL')?.id, 'small', 'ids are case-insensitive');
  });
});
