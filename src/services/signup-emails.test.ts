/**
 * The two emails a new account gets.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * A Google signup reported no welcome email; QA confirmed the confirmation had
 * arrived, late, and the welcome never. Both facts come out of one design:
 *
 *   • the pair was POLLER-ONLY, on a 15-minute interval, so nothing could
 *     arrive promptly however well it worked — that is the "late";
 *   • ONE claim gated BOTH emails. If the confirmation sent and the welcome
 *     failed, the claim was released and the next pass re-sent BOTH. A welcome
 *     that keeps failing therefore produces a confirmation delivered every
 *     fifteen minutes and a welcome that never arrives at all — which is
 *     exactly the pair of symptoms reported.
 *
 * These tests are about the CLAIMS, which is where the judgement is: who gets
 * sent what, and — more importantly — what a failure is allowed to re-send.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSignupEmails } from './trial-emails.service.js';

const ROW = { id: 42, email: 'a@b.c', name: 'Ada Lovelace', trial_ends_at: null };

/** Enabled config, so the tests are about the claims and not the feature flag. */
const ON = {
  enabled: true,
  from: 'Nathan <nathan@example.com>',
  replyTo: 'support@example.com',
  createUrl: 'https://example.com/overview',
  upgradeUrl: 'https://example.com/credits',
};

/**
 * A db stub that answers each `UPDATE … RETURNING` claim, in order, with either
 * the row (claim won) or nothing (already claimed). Records every statement.
 */
const dbGranting = (...claims: boolean[]) => {
  const statements: string[] = [];
  let i = 0;
  const db = (async (strings: TemplateStringsArray) => {
    const text = strings.raw.join('?').replace(/\s+/g, ' ').trim();
    statements.push(text);
    // Only the claims RETURN; the release statements do not.
    if (!/RETURNING/i.test(text)) return [];
    const won = claims[i++] ?? false;
    return won ? [ROW] : [];
  }) as any;
  return { db, statements };
};

/** A send spy that can be told to fail. */
const spySend = (ok = true) => {
  const calls: any[] = [];
  return { calls, fn: async (row: any) => { calls.push(row); return ok; } };
};

const releasesOf = (statements: string[], column: string) =>
  statements.filter((s) => new RegExp(`SET ${column} = NULL`, 'i').test(s));

describe('ensureSignupEmails', () => {
  test('sends both to an account that has had neither', async () => {
    const { db } = dbGranting(true, true);
    const confirmation = spySend();
    const welcome = spySend();

    const sent = await ensureSignupEmails({ id: 42 }, {
      db, config: ON, sendConfirmation: confirmation.fn, sendWelcome: welcome.fn,
    });

    assert.deepEqual(sent, { confirmation: true, welcome: true });
    assert.equal(confirmation.calls.length, 1);
    assert.equal(welcome.calls.length, 1);
  });

  test('sends nothing to an account that already has both', async () => {
    // The common path. This runs on the first API call of every session, so
    // "no" has to cost two writes that match nothing and no mail at all.
    const { db } = dbGranting(false, false);
    const confirmation = spySend();
    const welcome = spySend();

    const sent = await ensureSignupEmails({ id: 42 }, {
      db, config: ON, sendConfirmation: confirmation.fn, sendWelcome: welcome.fn,
    });

    assert.deepEqual(sent, { confirmation: false, welcome: false });
    assert.equal(confirmation.calls.length, 0);
    assert.equal(welcome.calls.length, 0);
  });

  test('a failed welcome does NOT re-send the confirmation — THE bug', async () => {
    // The reported symptom, in one test. Under the old single claim this
    // released the shared claim, so the confirmation went out again on every
    // subsequent pass while the welcome never arrived.
    const { db, statements } = dbGranting(true, true);
    const confirmation = spySend(true);
    const welcome = spySend(false);

    const sent = await ensureSignupEmails({ id: 42 }, {
      db, config: ON, sendConfirmation: confirmation.fn, sendWelcome: welcome.fn,
    });

    assert.deepEqual(sent, { confirmation: true, welcome: false });
    // The welcome is released so it retries…
    assert.equal(releasesOf(statements, 'welcome_email_sent_at').length, 1);
    // …and the confirmation is NOT, so it is never sent twice.
    assert.equal(releasesOf(statements, 'confirmation_email_sent_at').length, 0);
  });

  test('a failed confirmation does not hold up the welcome', async () => {
    // The mirror image. The two emails use different senders, so one can fail
    // on its own; neither should be able to suppress the other.
    const { db, statements } = dbGranting(true, true);
    const confirmation = spySend(false);
    const welcome = spySend(true);

    const sent = await ensureSignupEmails({ id: 42 }, {
      db, config: ON, sendConfirmation: confirmation.fn, sendWelcome: welcome.fn,
    });

    assert.deepEqual(sent, { confirmation: false, welcome: true });
    assert.equal(welcome.calls.length, 1);
    assert.equal(releasesOf(statements, 'confirmation_email_sent_at').length, 1);
    assert.equal(releasesOf(statements, 'welcome_email_sent_at').length, 0);
  });

  test('sends only the missing one when the other already went', async () => {
    const { db } = dbGranting(false, true);
    const confirmation = spySend();
    const welcome = spySend();

    const sent = await ensureSignupEmails({ id: 42 }, {
      db, config: ON, sendConfirmation: confirmation.fn, sendWelcome: welcome.fn,
    });

    assert.deepEqual(sent, { confirmation: false, welcome: true });
    assert.equal(confirmation.calls.length, 0);
    assert.equal(welcome.calls.length, 1);
  });

  test('the claim is atomic — it only writes where the column IS NULL', async () => {
    // Two schedulers, or a scheduler racing this on-demand path, both run the
    // same statement; the WHERE … IS NULL is what makes exactly one of them win
    // and the other send nothing.
    const { db, statements } = dbGranting(true, true);
    await ensureSignupEmails({ id: 42 }, {
      db, config: ON, sendConfirmation: spySend().fn, sendWelcome: spySend().fn,
    });

    const claims = statements.filter((s) => /RETURNING/i.test(s));
    assert.equal(claims.length, 2);
    for (const c of claims) {
      assert.match(c, /IS NULL/i);
      assert.match(c, /RETURNING/i);
    }
  });

  test('honours the feature flag, sending nothing and touching nothing', async () => {
    // An on-demand path that ignored TRIAL_EMAILS_ENABLED would make "off" mean
    // something different here than in the scheduler.
    const { db, statements } = dbGranting(true, true);
    const confirmation = spySend();
    const welcome = spySend();

    const sent = await ensureSignupEmails({ id: 42 }, {
      db,
      config: { ...ON, enabled: false },
      sendConfirmation: confirmation.fn,
      sendWelcome: welcome.fn,
    });

    assert.deepEqual(sent, { confirmation: false, welcome: false });
    assert.equal(statements.length, 0);
    assert.equal(confirmation.calls.length, 0);
    assert.equal(welcome.calls.length, 0);
  });

  test('a database failure never breaks the request it runs inside', async () => {
    // Called from /users/by-email, which is how the CMS loads a session.
    // Failing that because mail could not be claimed would turn a missing
    // email into a locked-out user.
    const db = (async () => { throw new Error('connection reset'); }) as any;
    const originalError = console.error;
    console.error = () => {};
    try {
      const sent = await ensureSignupEmails({ id: 42 }, {
        db, config: ON, sendConfirmation: spySend().fn, sendWelcome: spySend().fn,
      });
      assert.deepEqual(sent, { confirmation: false, welcome: false });
    } finally {
      console.error = originalError;
    }
  });

  test('a throwing mailer is contained, and releases the claim it holds', async () => {
    const { db, statements } = dbGranting(true, true);
    const originalError = console.error;
    console.error = () => {};
    try {
      const sent = await ensureSignupEmails({ id: 42 }, {
        db,
        config: ON,
        sendConfirmation: async () => { throw new Error('mailgun down'); },
        sendWelcome: spySend(true).fn,
      });
      // The confirmation threw, but the welcome still went.
      assert.equal(sent.confirmation, false);
      assert.equal(sent.welcome, true);
      assert.equal(releasesOf(statements, 'welcome_email_sent_at').length, 0);
    } finally {
      console.error = originalError;
    }
  });
});
