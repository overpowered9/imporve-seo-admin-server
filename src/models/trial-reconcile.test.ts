/**
 * reconcileTrialCredits must never treat a subscriber as an expired trial.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 * QA subscribed a free-trial account to Grow and found "Free trial ended —
 * moved to Free plan" in Account Activity. The reconcile runs on hot read paths
 * with a user row loaded at the start of the request; on the Stripe return
 * page those reads race /verify-session activating the plan. A request holding
 * the stale free plan_id saw the new Grow lot as leftover trial credits, voided
 * it, and wrote the trial-ended row.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ─────────────────────────────────────────
 * Same reason as website-connection.test.ts: the rules live in SQL that closes
 * over the module-level `sql`, so they cannot be exercised against a fake. The
 * failure mode is a guard going missing or moving after the write it protects,
 * and reading the source catches exactly that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = fs.readFileSync(path.join(SRC, 'models/user.models.ts'), 'utf8');

/** One top-level `const` declaration, up to the next top-level declaration. */
const block = (name: string): string => {
  const start = models.search(new RegExp(`\\n(?:export )?const ${name}\\b`));
  assert.ok(start >= 0, `${name} must exist in user.models.ts`);
  const rest = models.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:export )?(?:const|async function|function) /);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe('suspendPlanCredits — an optional guard, checked inside the transaction', () => {
  const body = block('suspendPlanCredits');

  test('the guard runs before any plan lot is read or voided', () => {
    const guard = body.indexOf('options.onlyIf(sql)');
    const lots = body.indexOf('FROM credit_lots');
    assert.ok(guard >= 0, 'onlyIf must be evaluated with the transaction handle');
    assert.ok(lots > guard, 'the guard must come before the lots are touched');
  });

  test('a refused guard voids nothing and says so', () => {
    assert.match(body, /if \(options\.onlyIf && !\(await options\.onlyIf\(sql\)\)\) return false;/);
    assert.match(body, /return true;/);
  });
});

describe('stillOnFreeTierLocked — re-reads the account under a lock', () => {
  const body = block('stillOnFreeTierLocked');

  test('locks the user row, so a concurrent activation waits for this commit', () => {
    assert.match(body, /FOR UPDATE OF u/);
  });

  test('refuses a paid plan', () => {
    assert.match(body, /Number\(price\) !== 0\) return false/);
  });

  test('refuses an account with a live subscription row', () => {
    assert.match(body, /FROM subscriptions WHERE user_id/);
    assert.match(body, /isLiveStatus\(s\.status\)/);
  });
});

describe('reconcileTrialCredits — the activity row sits behind the guard', () => {
  const body = block('reconcileTrialCredits');

  test('suspends only through the locked re-check', () => {
    assert.match(body, /onlyIf: \(tx\) => stillOnFreeTierLocked\(tx, user\.id\)/);
  });

  test('a refused suspension returns before "Free trial ended" is written', () => {
    const bail = body.indexOf('if (!suspended) return false;');
    const row = body.indexOf('describeTrialEnded()');
    assert.ok(bail >= 0, 'must bail out when the guard refuses');
    assert.ok(row > bail, 'the trial-ended row must be written only after the guard passed');
  });
});
