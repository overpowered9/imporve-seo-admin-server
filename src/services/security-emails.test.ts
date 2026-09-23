/**
 * Password confirmation emails — Settings → Update Security.
 *
 * "A confirmation email should be sent whenever a password is set (Scenario 2)
 * or changed (Scenarios 1 and 3)."  Plus the forgot-password reset, which is
 * also a change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../test/helpers/fake-sql.js';
import {
  confirmPasswordChange, queuePasswordConfirmation, passwordTemplateFor, passwordMethodFor,
  verifiedSessionEmail, sameEmail, formatChangedAt, type TokenResolver,
} from './security-emails.js';
import { RENDERERS, unrenderedTokensIn } from './billing/email-worker.js';

const USER = { id: 51, email: 'Owner@Example.com', name: 'Muhammad Waleed Hassan' };
const AT = new Date('2026-09-23T14:05:00Z');

/** A token resolver that knows exactly one session. */
const sessionFor = (email: string): TokenResolver => async (jwt) => (jwt === 'good-jwt' ? email : null);

const queued = (sql: ReturnType<typeof createFakeSql>) => sql.matching(/INSERT INTO email_sends/);
const payloadOf = (q: { params: any[] }) => JSON.parse(String(q.params[5]));

describe('which email each scenario gets', () => {
  test('Scenario 2 (a Google account SETS a password) → security.password_set', () => {
    assert.equal(passwordTemplateFor('set'), 'security.password_set');
  });

  test('Scenarios 1 and 3 (a password CHANGED) → security.password_changed', () => {
    assert.equal(passwordTemplateFor('changed'), 'security.password_changed');
  });

  test('a forgot-password reset is a change too → security.password_changed', () => {
    assert.equal(passwordTemplateFor('reset'), 'security.password_changed');
    assert.equal(passwordMethodFor('reset'), 'a password reset link');
    assert.equal(passwordMethodFor('changed'), 'your account Settings');
  });
});

describe('confirmPasswordChange — the route\'s decision', () => {
  for (const [event, template] of [
    ['set', 'security.password_set'],
    ['changed', 'security.password_changed'],
    ['reset', 'security.password_changed'],
  ] as const) {
    test(`${event}: with a session for the same account, one email is queued`, async () => {
      const sql = createFakeSql().when(/INSERT INTO email_sends/, [{ id: 1 }]);
      const result = await confirmPasswordChange(sql, {
        user: USER, event, authorization: 'Bearer good-jwt',
        resolve: sessionFor('owner@example.com'), // case differs on purpose
        now: AT,
      });

      assert.equal(result, 'queued');
      const rows = queued(sql);
      assert.equal(rows.length, 1);
      const [userId, recipient, tpl, category, eventKey] = rows[0].params;
      assert.equal(userId, 51);
      assert.equal(recipient, 'Owner@Example.com');
      assert.equal(tpl, template);
      // A marketing opt-out must never silence a security notice.
      assert.equal(category, 'transactional');
      assert.match(String(eventKey), new RegExp(`^password_${event}:51:`));

      const payload = payloadOf(rows[0]);
      assert.equal(payload.firstName, 'Muhammad');
      assert.equal(payload.changedAt, 'September 23, 2026 at 14:05 UTC');
      assert.match(payload.resetUrl, /\/forgot-password$/);
      assert.match(payload.settingsUrl, /\/settings$/);
    });
  }

  test('no event (an older CMS) → no email, and nothing breaks', async () => {
    const sql = createFakeSql();
    const result = await confirmPasswordChange(sql, {
      user: USER, authorization: 'Bearer good-jwt', resolve: sessionFor(USER.email),
    });
    assert.equal(result, 'skipped');
    assert.equal(queued(sql).length, 0);
  });

  test('ABUSE: no token → no email to the address in the body', async () => {
    const sql = createFakeSql();
    const result = await confirmPasswordChange(sql, { user: USER, event: 'changed', resolve: sessionFor(USER.email) });
    assert.equal(result, 'skipped');
    assert.equal(queued(sql).length, 0);
  });

  test('ABUSE: a valid session for ANOTHER account → no email', async () => {
    const sql = createFakeSql();
    const result = await confirmPasswordChange(sql, {
      user: USER, event: 'changed', authorization: 'Bearer good-jwt', resolve: sessionFor('attacker@example.com'),
    });
    assert.equal(result, 'skipped');
    assert.equal(queued(sql).length, 0);
  });

  test('an invalid or expired token → no email', async () => {
    const sql = createFakeSql();
    const result = await confirmPasswordChange(sql, {
      user: USER, event: 'set', authorization: 'Bearer stale-jwt', resolve: sessionFor(USER.email),
    });
    assert.equal(result, 'skipped');
    assert.equal(queued(sql).length, 0);
  });

  test('the auth provider timing out or throwing → no email, no exception', async () => {
    const sql = createFakeSql();
    const result = await confirmPasswordChange(sql, {
      user: USER, event: 'changed', authorization: 'Bearer good-jwt',
      resolve: async () => { throw new Error('jwt_timeout'); },
    });
    assert.equal(result, 'skipped');
  });

  test('an outbox failure is reported as skipped, never thrown — the password already changed', async () => {
    const sql = createFakeSql().failOn(/INSERT INTO email_sends/);
    const result = await confirmPasswordChange(sql, {
      user: USER, event: 'changed', authorization: 'Bearer good-jwt', resolve: sessionFor(USER.email),
    });
    assert.equal(result, 'skipped');
  });

  test('every change is its own email — two changes queue two, not one', async () => {
    const sql = createFakeSql().when(/INSERT INTO email_sends/, [{ id: 1 }]);
    await queuePasswordConfirmation(sql, { user: USER, event: 'changed', now: AT });
    await queuePasswordConfirmation(sql, { user: USER, event: 'changed', now: AT });
    const keys = queued(sql).map((q) => q.params[4]);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  });
});

describe('helpers', () => {
  test('verifiedSessionEmail only accepts a Bearer header', async () => {
    const resolve = sessionFor('a@b.c');
    assert.equal(await verifiedSessionEmail(undefined, resolve), null);
    assert.equal(await verifiedSessionEmail('good-jwt', resolve), null);
    assert.equal(await verifiedSessionEmail('Basic good-jwt', resolve), null);
    assert.equal(await verifiedSessionEmail('Bearer good-jwt', resolve), 'a@b.c');
  });

  test('sameEmail ignores case and whitespace, and never matches an absent side', () => {
    assert.equal(sameEmail(' A@B.c ', 'a@b.C'), true);
    assert.equal(sameEmail(null, 'a@b.c'), false);
    assert.equal(sameEmail('a@b.c', undefined), false);
    assert.equal(sameEmail('a@b.c', 'x@b.c'), false);
  });

  test('formatChangedAt is UTC and 24-hour', () => {
    assert.equal(formatChangedAt(new Date('2026-01-05T09:03:00Z')), 'January 5, 2026 at 09:03 UTC');
  });
});

describe('what the customer receives', () => {
  const payload = (event: 'set' | 'changed' | 'reset') => ({
    firstName: 'Muhammad', event, changedAt: 'September 23, 2026 at 14:05 UTC',
    method: passwordMethodFor(event),
    resetUrl: 'https://account.improveseoplugin.com/forgot-password',
    settingsUrl: 'https://account.improveseoplugin.com/settings',
  });

  test('password set: says a password was SET, when, and how to undo it', () => {
    const r = RENDERERS['security.password_set'](payload('set'));
    assert.match(r.subject, /password is set/i);
    assert.match(r.text, /Hi Muhammad/);
    assert.match(r.text, /September 23, 2026 at 14:05 UTC/);
    assert.match(r.text, /Google sign-in keeps working/);
    assert.match(r.text, /forgot-password/);
    assert.deepEqual(unrenderedTokensIn(r), []);
  });

  test('password changed: says it CHANGED, when, how, and how to undo it', () => {
    const r = RENDERERS['security.password_changed'](payload('changed'));
    assert.match(r.subject, /password was changed/i);
    assert.match(r.text, /via your account Settings/);
    assert.match(r.text, /Wasn't you\?/);
    assert.match(r.html, /href="https:\/\/account\.improveseoplugin\.com\/forgot-password"/);
    assert.deepEqual(unrenderedTokensIn(r), []);
  });

  test('a reset reads as a reset', () => {
    const r = RENDERERS['security.password_changed'](payload('reset'));
    assert.match(r.text, /via a password reset link/);
  });

  test('no unsubscribe link — a security notice is not marketing', () => {
    const r = RENDERERS['security.password_changed'](payload('changed'));
    assert.doesNotMatch(r.html, /unsubscribe/i);
  });
});
