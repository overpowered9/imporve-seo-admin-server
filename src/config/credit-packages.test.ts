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
  ISEO_PACKAGE_SMALL_PRICE_CENTS: '399',
  ISEO_PACKAGE_MEDIUM_CREDITS: '100',
  ISEO_PACKAGE_MEDIUM_PRICE_CENTS: '599',
  ISEO_PACKAGE_LARGE_CREDITS: '200',
  ISEO_PACKAGE_LARGE_PRICE_CENTS: '1099',
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

  test('the three packages are ~3, ~5 and ~10 pieces', async () => {
    const { creditPackages } = (await load()) as any;
    const [small, medium, large] = creditPackages();
    assert.equal(small.approx_pieces, 3);
    assert.equal(medium.approx_pieces, 5);
    assert.equal(large.approx_pieces, 11); // 200 / 19, rounded — labelled honestly
    assert.equal(small.credits, 60);
    assert.equal(large.price_cents, 1099);
  });

  test('bigger packages are better value per credit', async () => {
    const { creditPackages } = (await load()) as any;
    const rate = (p: any) => p.price_cents / p.credits;
    const [s, m, l] = creditPackages();
    assert.ok(rate(m) < rate(s), 'medium must beat small per credit');
    assert.ok(rate(l) < rate(m), 'large must beat medium per credit');
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
