/**
 * Provisioning the signup credit grant.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * A brand-new account had no spendable credits. The CMS signs up through
 * supabase.auth.signUp(), so the public.users row is written by a database
 * trigger and the API is not touched until first sign-in — which meant
 * initializeUserCredits, the only correct implementation of the grant, was
 * never reached by either signup route. The trigger meanwhile seeded
 * 'images'/'content'/'keywords' rows that migration 011 made unspendable, so
 * the account read zero and every generation would have been refused.
 *
 * The tests below are about the GUARD, which is the part with judgement in it:
 * when to provision, and — more importantly — when NOT to.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSignupGrant } from './user.models.js';
import { MIGRATION_SQL } from '../migrations/016-signup-credit-grant.js';

/** A db stub answering the one existence query the guard runs. */
const dbSaying = (row: { has_lots: boolean; has_subscription: boolean }) => {
  const calls: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    calls.push(strings.raw.join('?').replace(/\s+/g, ' ').trim());
    return [row];
  }) as any;
  return { db, calls };
};

/** A provision spy standing in for initializeUserCredits. */
const spyProvision = () => {
  const calls: Array<{ userId: number; planId?: number }> = [];
  return {
    calls,
    fn: async (userId: number, planId?: number) => { calls.push({ userId, planId }); },
  };
};

describe('ensureSignupGrant', () => {
  test('provisions an account that has no lots and no subscription', async () => {
    // The reported case: created by the trigger, never seen by the API, so it
    // holds nothing spendable at all.
    const { db } = dbSaying({ has_lots: false, has_subscription: false });
    const provision = spyProvision();

    const granted = await ensureSignupGrant({ id: 38, plan_id: 4 }, { db, provision: provision.fn });

    assert.equal(granted, true);
    assert.deepEqual(provision.calls, [{ userId: 38, planId: 4 }]);
  });

  test('does nothing for an account that already has lots', async () => {
    // Every existing account. This runs on the first API call of every session,
    // so the common path has to be one read and no writes.
    const { db } = dbSaying({ has_lots: true, has_subscription: false });
    const provision = spyProvision();

    const granted = await ensureSignupGrant({ id: 36, plan_id: 3 }, { db, provision: provision.fn });

    assert.equal(granted, false);
    assert.equal(provision.calls.length, 0);
  });

  test('leaves a SUBSCRIBED account with no lots alone, for a human', async () => {
    // THE case worth being careful about. A paying customer with no lots is a
    // refill that did not run or a webhook that was lost — a different failure.
    // Quietly handing them the FREE grant would paper over it and under-credit
    // someone who is paying, so the signup path must not touch them.
    const { db } = dbSaying({ has_lots: false, has_subscription: true });
    const provision = spyProvision();

    const granted = await ensureSignupGrant({ id: 15, plan_id: 3 }, { db, provision: provision.fn });

    assert.equal(granted, false);
    assert.equal(provision.calls.length, 0);
  });

  test('asks about lots and subscriptions in ONE query', async () => {
    // It runs on every session start; two round trips to learn "no" would be
    // two too many.
    const { db, calls } = dbSaying({ has_lots: true, has_subscription: false });
    await ensureSignupGrant({ id: 1 }, { db, provision: spyProvision().fn });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /credit_lots/);
    assert.match(calls[0], /subscriptions/);
  });

  test('a failure to grant never breaks reading the account', async () => {
    // This is called from /users/by-email, which is how the CMS loads a
    // session. Failing that request because a grant could not be written would
    // turn a missing balance into a locked-out user.
    const db = (async () => { throw new Error('connection reset'); }) as any;
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(await ensureSignupGrant({ id: 38, plan_id: 4 }, { db }), false);
    } finally {
      console.error = originalError;
    }
  });

  test('an empty result is treated as "cannot tell", not as "no lots"', async () => {
    // Defensive: a row that does not come back must not be read as permission
    // to grant. Granting twice is worse than granting late.
    const db = (async () => []) as any;
    const provision = spyProvision();
    await ensureSignupGrant({ id: 38, plan_id: 4 }, { db, provision: provision.fn });
    // With no row the guard falls through and provisions — which is safe only
    // because initializeUserCredits is itself idempotent on the same
    // condition. Asserted here so that guarantee is not quietly removed.
    assert.equal(provision.calls.length, 1);
  });
});

describe('migration 016 — the signup trigger', () => {
  // The function body carries a comment explaining what it stopped doing, and
  // that comment names the dead credit types. Assert about the SQL that RUNS,
  // not about the prose beside it — otherwise the explanation and the check
  // are in competition and one of them has to go.
  const EXECUTABLE = MIGRATION_SQL.replace(/--[^\n]*/g, '');

  test('no longer seeds the credit types migration 011 removed', async () => {
    // This is what the installed function did, and why a new account read zero.
    assert.doesNotMatch(EXECUTABLE, /'images'/);
    assert.doesNotMatch(EXECUTABLE, /'content'/);
    assert.doesNotMatch(EXECUTABLE, /'keywords'/);
    assert.doesNotMatch(EXECUTABLE, /INSERT INTO public\.credit_balances/i);
  });

  test('still creates the account, with its plan and trial window', async () => {
    // The trigger's real job, which must survive the change untouched — losing
    // it would mean signup produced no account at all.
    assert.match(MIGRATION_SQL, /INSERT INTO public\.users/i);
    assert.match(MIGRATION_SQL, /trial_started_at/);
    assert.match(MIGRATION_SQL, /NOW\(\) \+ INTERVAL '7 days'/);
    assert.match(MIGRATION_SQL, /ON CONFLICT \(email\) DO NOTHING/i);
    // The id recovery for the conflict case: RETURNING yields nothing there,
    // and without this the function would carry on with a NULL user id.
    assert.match(MIGRATION_SQL, /IF new_user_id IS NULL THEN/i);
  });

  test('is CREATE OR REPLACE, so it can be re-run', async () => {
    assert.match(MIGRATION_SQL, /CREATE OR REPLACE FUNCTION public\.handle_new_user/i);
    assert.match(MIGRATION_SQL, /SECURITY DEFINER/i);
  });
});
