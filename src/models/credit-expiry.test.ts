/**
 * The two rules that decide when credits lapse.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ─────────────────────────────────────────
 * Both rules live inside SQL that runs against the real database, in functions
 * that close over the module-level `sql` rather than taking it as a parameter,
 * so they cannot be exercised with the fake. The same problem produced
 * credit-writers.test.ts, and the same remedy applies: assert on the source,
 * because the failure mode is a clause going missing, and a grep catches that
 * precisely.
 *
 * What the rules are, and why each one exists:
 *
 *  1. PLAN credits expire with the billing CYCLE they belong to. Every grant
 *     used to set `NOW() + 2 months`, which is correct for a refill (a refill
 *     starts a cycle) and wrong for a mid-cycle upgrade bonus, which then
 *     outlived the cycle's own credits by however far into the cycle it landed.
 *     Production held one account with three plan lots across two expiry dates,
 *     all from a single cycle. It also made the product's own promise —
 *     "plan credits stay usable for two billing cycles" — unverifiable, since
 *     grant-relative dates drift away from cycle boundaries.
 *
 *  2. PURCHASED credits all share one expiry, renewed by each new purchase.
 *     Without the reset, a regular customer accrues a lot per purchase and the
 *     balance panel cannot state a single honest date for what they bought.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = fs.readFileSync(path.join(SRC, 'models/user.models.ts'), 'utf8');

/** The body of a top-level exported function, by name. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = async`);
  assert.ok(start >= 0, `${name} not found — has it been renamed?`);
  // Up to the next top-level export, which is where the next function starts.
  const rest = source.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end >= 0 ? rest.slice(0, end) : rest;
}

describe('plan credits expire with their cycle', () => {
  test('the helper that finds the cycle expiry exists', () => {
    assert.match(models, /async function currentCyclePlanExpiry\(/);
  });

  test('it is scoped to live plan lots granted in the current cycle', () => {
    const helper = models.slice(models.indexOf('async function currentCyclePlanExpiry('));
    const body = helper.slice(0, helper.indexOf('\n}\n') + 3);

    assert.match(body, /source = 'plan'/, 'must not pick up purchased lots');
    assert.match(body, /remaining > 0/, 'a spent lot is not this cycle\'s expiry');
    assert.match(body, /expires_at > NOW\(\)/, 'a lapsed lot is not this cycle\'s expiry');
    assert.match(body, /granted_at >=/, 'must be bounded to the current cycle');
    assert.match(body, /cycle_started_at/, 'the cycle boundary the rest of the system uses');
    // MAX, so several grants in one cycle converge on one date rather than the
    // first one written winning.
    assert.match(body, /MAX\(l\.expires_at\)/);
  });

  test('the upgrade bonus uses it, and falls back rather than writing null', () => {
    const body = functionBody(models, 'upgradeIncludedCredits');
    assert.match(body, /currentCyclePlanExpiry\(/, 'the upgrade grant must ask for the cycle expiry');
    // COALESCE, because an upgrade off the free tier has no cycle lot yet and
    // expires_at is NOT NULL.
    assert.match(body, /COALESCE\(/);
    assert.match(body, /PLAN_CREDIT_LIFETIME_MONTHS/, 'the fallback must still be the plan lifetime');
  });

  test('a refill still mints a fresh expiry — it starts the cycle', () => {
    // The counterpart to the rule above: if a refill also inherited the current
    // cycle's date, plan credits would never move forward and would eventually
    // all expire together.
    const body = functionBody(models, 'refillPlanCredits');
    assert.match(body, /NOW\(\) \+ \$\{`\$\{PLAN_CREDIT_LIFETIME_MONTHS\} months`\}/);
    assert.ok(
      !/currentCyclePlanExpiry/.test(body),
      'a refill starts a new cycle and must not inherit the old expiry',
    );
  });
});

describe('purchased credits share one expiry', () => {
  const body = functionBody(models, 'addPurchasedCredits');

  test('a purchase renews the clock on every live purchased lot', () => {
    assert.match(body, /UPDATE credit_lots/, 'the reset must be here');
    assert.match(body, /source = 'purchased'/);
    assert.match(body, /PURCHASED_CREDIT_LIFETIME_MONTHS/);
  });

  test('only LIVE lots are touched', () => {
    // A lapsed lot has remaining = 0 from the sweep, so rewriting its date
    // revives nothing and destroys the record of when it actually died.
    const update = body.slice(body.indexOf('UPDATE credit_lots'));
    assert.match(update, /remaining > 0/);
    assert.match(update, /expires_at > NOW\(\)/);
  });

  test('the balance cache is still synced after the change', () => {
    // credit_balances is derived from the lots; rewriting expiry without
    // resyncing would leave the cache describing a set of lots that no longer
    // exists. credit-writers.test.ts enforces this generally — asserted here
    // too because this function now has two lot mutations, not one.
    assert.match(body, /syncBalanceCache\(/);
  });
});

describe('the balance breakdown groups by day, not by instant', () => {
  test('getCreditLotSummary buckets on the UTC date', () => {
    const body = functionBody(models, 'getCreditLotSummary');
    assert.match(body, /AT TIME ZONE 'UTC'\)::date/);
    assert.match(body, /GROUP {2}BY source, \(expires_at AT TIME ZONE 'UTC'\)::date/);
    // Soonest first — the order the panel shows AND the order they are spent.
    assert.match(body, /ORDER {2}BY \(expires_at AT TIME ZONE 'UTC'\)::date ASC/);
    assert.match(body, /remaining > 0 AND expires_at > NOW\(\)/);
  });

  test('getLiveBalance buckets the same way', () => {
    // It used to GROUP BY the raw timestamp, so two lots granted seconds apart
    // on the same day became two buckets and next_expiry_amount reported only
    // the first — "42 expiring on Oct 19" when 600 were.
    const body = functionBody(models, 'getLiveBalance');
    assert.match(body, /GROUP {2}BY \(expires_at AT TIME ZONE 'UTC'\)::date/);
    assert.ok(
      !/GROUP {2}BY expires_at\b/.test(body),
      'grouping by the raw timestamp splits one calendar day into several buckets',
    );
  });
});
