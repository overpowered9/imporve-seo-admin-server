/**
 * Does this account have a password? (`has_password` on /users/by-email)
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * An account that signed up with email + password was told, on Settings →
 * Update Security, "You don't have a password yet" — and was not asked for its
 * current password before changing it.
 *
 * `has_password` was `!!user.password_hash`, but the CMS signs up through
 * supabase.auth.signUp(): the users row is written by the handle_new_user
 * trigger, and nothing ever fills password_hash. The password exists — in
 * Supabase Auth (auth.users.encrypted_password) — just not in our column. On
 * the shared DB that was 17 of 30 accounts.
 *
 * These tests pin the rule: our column OR Supabase Auth, and unknown is never
 * reported as "no password".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasPasswordCredential } from './user.models.js';

/** A db stub answering the one auth.users query, recording what was asked. */
const dbSaying = (rows: any[]) => {
  const calls: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    calls.push(strings.raw.join('?').replace(/\s+/g, ' ').trim());
    return rows;
  }) as any;
  return { db, calls };
};

describe('hasPasswordCredential', () => {
  test('an account with our own password_hash has a password, without a query', async () => {
    // Plugin signups (/auth/signup) and anyone who set one from Settings.
    const { db, calls } = dbSaying([]);
    const result = await hasPasswordCredential(
      { id: 1, email: 'plugin@example.com', password_hash: '$2b$10$abc' },
      { db },
    );
    assert.equal(result, true);
    assert.equal(calls.length, 0);
  });

  test('THE BUG: a web email signup has a password in Supabase Auth only', async () => {
    const { db, calls } = dbSaying([{ has_password: true }]);
    const result = await hasPasswordCredential(
      { id: 2, email: 'nathan@example.com', password_hash: null },
      { db },
    );
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /FROM auth\.users/);
    assert.match(calls[0], /encrypted_password/);
  });

  test('a Google-only account has no password, so it is offered "Set a Password"', async () => {
    const { db } = dbSaying([{ has_password: false }]);
    const result = await hasPasswordCredential({ id: 3, email: 'g@example.com' }, { db });
    assert.equal(result, false);
  });

  test('no auth.users row reads as no password', async () => {
    const { db } = dbSaying([]);
    const result = await hasPasswordCredential({ id: 4, email: 'gone@example.com' }, { db });
    assert.equal(result, false);
  });

  test('a failed lookup is UNKNOWN (null), never false', async () => {
    // false would hide the current-password check on an account that may have
    // one; the CMS treats anything but false as "has a password".
    const db = (async () => { throw new Error('permission denied for schema auth'); }) as any;
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await hasPasswordCredential({ id: 5, email: 'x@example.com' }, { db });
      assert.equal(result, null);
    } finally {
      console.error = originalError;
    }
  });
});
