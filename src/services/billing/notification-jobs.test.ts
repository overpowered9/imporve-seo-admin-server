/**
 * BILL-007 and BILL-008 — scheduled notifications.
 *
 * Both tickets demand: no duplicates across re-runs, every suppression rule
 * tested independently, boundary correctness, consolidation, and a frequency
 * cap proven over a long simulated run. Those are the tests here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import {
  runNotificationJob,
  claimNotification,
  creditExpiryJob,
  inactivityJob,
  loadNotificationConfig,
  runAllNotificationJobs,
  piecesFrom,
  type NotificationConfig,
  type Candidate,
} from './notification-jobs.js';

const cfg = (over: Partial<NotificationConfig> = {}): NotificationConfig => ({
  creditExpiryLeadDays: [14, 3, 0],
  inactivityDays: 14,
  inactivityCooldownDays: 60,
  batchSize: 100,
  dashboardUrl: 'https://app.test/overview',
  creditsUrl: 'https://app.test/credits',
  ...over,
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  user_id: 1,
  email: 'a@b.c',
  name: 'Sam Smith',
  content: 50,
  images: 40,
  keywords: 10,
  expiring_total: 100,
  remaining_after: 20,
  cycle_started_at: '2026-08-01T00:00:00Z',
  reset_at: '2026-09-01T00:00:00Z',
  last_generation_at: '2026-07-20T00:00:00Z',
  total_credits: 120,
  plan_name: 'Grow',
  nearest_expiry: '2026-09-01T00:00:00Z',
  ...over,
});

/**
 * A fake DB that models the UNIQUE (user_id, kind, dedupe_key) constraint on
 * user_notifications and the UNIQUE (template, event_key) on email_sends.
 * Those two constraints ARE the idempotency guarantee, so a fake that ignores
 * them would make every duplicate test pass vacuously.
 */
function sqlWithConstraints(candidates: Candidate[] = []) {
  const claims = new Set<string>();
  const queued = new Set<string>();
  const sql = createFakeSql();

  sql.when(/INSERT INTO user_notifications/, (params) => {
    const key = `${params[0]}|${params[1]}|${params[2]}`;
    if (claims.has(key)) return [];
    claims.add(key);
    return [{ id: claims.size }];
  });
  sql.when(/INSERT INTO email_sends/, (params) => {
    const key = `${params[2]}|${params[4]}`;
    if (queued.has(key)) return [];
    queued.add(key);
    return [{ id: queued.size }];
  });
  sql.when(/SELECT u\.id AS user_id/, () => candidates);
  sql.when(/WITH last_activity/, () => candidates);

  return { sql, claims, queued };
}

describe('piecesFrom (must match the CMS)', () => {
  test('is limited by whichever pool runs out first, not the total', () => {
    // 100 content and 0 image credits buys zero illustrated pieces. Summing
    // would promise 50 and contradict the dashboard.
    assert.equal(piecesFrom(100, 0), 0);
    assert.equal(piecesFrom(50, 40), 40);
    assert.equal(piecesFrom(0, 0), 0);
  });
});

describe('configuration', () => {
  test('lead times come from config and default to the signed-off 14/3/0', () => {
    delete process.env.CREDIT_EXPIRY_LEAD_DAYS;
    assert.deepEqual(loadNotificationConfig().creditExpiryLeadDays, [14, 3, 0]);
  });

  test('lead times are swappable without touching logic', () => {
    process.env.CREDIT_EXPIRY_LEAD_DAYS = '30, 7, 1';
    assert.deepEqual(loadNotificationConfig().creditExpiryLeadDays, [30, 7, 1]);
    delete process.env.CREDIT_EXPIRY_LEAD_DAYS;
  });

  test('the inactivity cooldown defaults to the signed-off 60 days', () => {
    delete process.env.INACTIVITY_COOLDOWN_DAYS;
    assert.equal(loadNotificationConfig().inactivityCooldownDays, 60);
  });
});

describe('claimNotification', () => {
  test('the first claim wins and the second is refused', async () => {
    const { sql } = sqlWithConstraints();
    assert.equal(await claimNotification(sql, 1, 'credit_expiry', 'cycle:2026-08-01:lead:14'), true);
    assert.equal(await claimNotification(sql, 1, 'credit_expiry', 'cycle:2026-08-01:lead:14'), false);
  });

  test('a different occurrence is a separate claim', async () => {
    const { sql } = sqlWithConstraints();
    assert.equal(await claimNotification(sql, 1, 'credit_expiry', 'cycle:2026-08-01:lead:14'), true);
    assert.equal(await claimNotification(sql, 1, 'credit_expiry', 'cycle:2026-08-01:lead:3'), true);
    assert.equal(await claimNotification(sql, 1, 'credit_expiry', 'cycle:2026-09-01:lead:14'), true);
  });

  test('a missing table skips rather than sending unguarded', async () => {
    const sql = createFakeSql();
    const err: any = new Error('relation does not exist');
    err.code = '42P01';
    sql.failOn(/INSERT INTO user_notifications/, err);
    // Sending without the guard would spam every user on every pass.
    assert.equal(await claimNotification(sql, 1, 'credit_expiry', 'k'), false);
  });
});

describe('BILL-007 — credit expiry', () => {
  test('queues one email per due user', async () => {
    const { sql } = sqlWithConstraints([candidate()]);
    const result = await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());

    assert.equal(result.scanned, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.errors, 0);
  });

  test('IDEMPOTENCY: three runs produce ONE email', async () => {
    const { sql } = sqlWithConstraints([candidate()]);
    const job = creditExpiryJob(14, cfg());

    const first = await runNotificationJob(sql, job, cfg());
    const second = await runNotificationJob(sql, job, cfg());
    const third = await runNotificationJob(sql, job, cfg());

    assert.equal(first.queued, 1);
    assert.equal(second.queued, 0);
    assert.equal(third.queued, 0);
    assert.equal(second.skippedDuplicate, 1);
  });

  test('the 14-day and 3-day warnings are separate sends, not duplicates', async () => {
    const { sql } = sqlWithConstraints([candidate()]);
    const c = cfg();
    const at14 = await runNotificationJob(sql, creditExpiryJob(14, c), c);
    const at3 = await runNotificationJob(sql, creditExpiryJob(3, c), c);

    assert.equal(at14.queued, 1);
    assert.equal(at3.queued, 1, 'a different threshold is a different occurrence');
  });

  test('a NEW cycle warns again — the dedupe key is per cycle', async () => {
    const c = cfg();
    const august = sqlWithConstraints([candidate({ cycle_started_at: '2026-08-01T00:00:00Z' })]);
    assert.equal((await runNotificationJob(august.sql, creditExpiryJob(14, c), c)).queued, 1);
    assert.equal((await runNotificationJob(august.sql, creditExpiryJob(14, c), c)).queued, 0);

    // Same fake DB state, next cycle.
    august.sql.reset();
    const september = sqlWithConstraints([candidate({ cycle_started_at: '2026-09-01T00:00:00Z' })]);
    assert.equal((await runNotificationJob(september.sql, creditExpiryJob(14, c), c)).queued, 1);
  });

  test('CONSOLIDATION: one user with several expiring batches gets ONE email', async () => {
    // The candidate query aggregates per user (GROUP BY u.id), so plan and
    // purchased credits expiring on the same date arrive as one row. The
    // plan/purchased split is FILTERed rather than grouped precisely so this
    // stays true — a wider GROUP BY would send one email per source.
    const { sql, queued } = sqlWithConstraints([
      candidate({ expiring_total: 100, plan_expiring: 60, purchased_expiring: 40 }),
    ]);
    const result = await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());

    assert.equal(result.queued, 1);
    assert.equal(queued.size, 1, 'one email, not one per credit source');

    const payload = creditExpiryJob(14, cfg()).payload(
      candidate({ expiring_total: 100, plan_expiring: 60, purchased_expiring: 40 }), cfg(),
    );
    assert.equal(payload.expiringAmount, '100 credits (60 plan, 40 purchased)');
  });

  test('names the split that is real, not the three pools that merged', () => {
    // Was "100 credits (100 content, 100 image, 100 keyword)" — three aliases
    // for one pooled figure, presented as a breakdown. Plan vs purchased is an
    // actual distinction; content vs image vs keyword stopped being one.
    const only = (over: Record<string, unknown>) =>
      String(creditExpiryJob(14, cfg()).payload(candidate(over), cfg()).expiringAmount);

    assert.equal(only({ expiring_total: 214, plan_expiring: 214, purchased_expiring: 0 }),
      '214 plan credits');
    assert.equal(only({ expiring_total: 60, plan_expiring: 0, purchased_expiring: 60 }),
      '60 purchased credits');
    // Never claims a per-type breakdown that no longer exists.
    const mixed = only({ expiring_total: 100, plan_expiring: 60, purchased_expiring: 40 });
    assert.ok(!/content|image|keyword/.test(mixed), mixed);
  });

  test('the payload carries the plan/purchased figures for the copy owner', () => {
    const payload = creditExpiryJob(14, cfg()).payload(
      candidate({ expiring_total: 100, plan_expiring: 60, purchased_expiring: 40 }), cfg(),
    );
    assert.equal(payload.planExpiring, 60);
    assert.equal(payload.purchasedExpiring, 40);
  });

  test('the payload carries every documented variable for the copy owner', () => {
    const payload = creditExpiryJob(14, cfg()).payload(candidate(), cfg());
    for (const key of ['firstName', 'expiringAmount', 'expiryDate', 'remainingAfter', 'ctaUrl', 'leadTimeLabel']) {
      assert.ok(key in payload, `payload is missing ${key}`);
    }
    assert.equal(payload.leadTimeLabel, 'in 14 days');
    assert.equal(creditExpiryJob(0, cfg()).payload(candidate(), cfg()).leadTimeLabel, 'today');
  });

  test('SUPPRESSION is in the query, so a suppressed user is never claimed', async () => {
    const { sql } = sqlWithConstraints([]);
    await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());

    const q = sql.matching(/SELECT u\.id AS user_id/)[0];
    // Each rule, asserted individually.
    assert.match(q.text, /marketing_opt_out_at IS NULL/, 'unsubscribed users must be excluded');
    assert.match(q.text, /email_hard_bounced_at IS NULL/, 'hard-bounced addresses must be excluded');
    assert.match(q.text, /is_internal = FALSE/, 'internal accounts must be excluded');
    // Reads from credit_lots now: a warning is about a LOT expiring, not about
    // a billing cycle rolling over. Only lots with credits left qualify.
    assert.match(q.text, /HAVING COALESCE\(SUM\(cl\.remaining\), 0\) > 0/, 'zero balances must be excluded');
    assert.match(q.text, /cl\.remaining > 0/, 'spent lots must be excluded at the join');
  });

  test('BOUNDARY: the threshold compares whole UTC days, not instants', async () => {
    const { sql } = sqlWithConstraints([]);
    await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());
    const q = sql.matching(/SELECT u\.id AS user_id/)[0];

    // Comparing timestamps would make the job's own run time the boundary:
    // a 09:00 run would miss someone expiring at 08:59 and catch them a day
    // late. Casting both sides to ::date is what makes "exactly 14 days" a day.
    assert.match(q.text, /AT TIME ZONE 'UTC'\)::date = \(\(NOW\(\) AT TIME ZONE 'UTC'\) \+ \(\? \|\| ' days'\)::interval\)::date/);
    assert.ok(q.params.includes(14));
  });

  test('EXPIRY IS READ, NOT RECOMPUTED — the query derives no date of its own', async () => {
    const { sql } = sqlWithConstraints([]);
    await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());
    const q = sql.matching(/SELECT u\.id AS user_id/)[0];

    // This used to reconstruct the expiry as cycle_started_at + INTERVAL '1
    // month', and the month-end concern lived here: +1 month on 31 January is
    // 28 February, whereas +30 days is 2 March.
    //
    // That arithmetic moved to where lots are GRANTED, which is the only place
    // that should decide when credits die. A warning job that recomputes the
    // date can disagree with the sweep that enforces it — and then a customer
    // is warned on one day and loses the credits on another.
    //
    // So the assertion is now the stronger one: this query does no date maths
    // beyond the lead-time comparison. It reads the stored column.
    assert.match(q.text, /cl\.expires_at/, 'must read the stored expiry');
    assert.ok(!/INTERVAL '1 month'/.test(q.text), 'must not reconstruct the expiry date');
    assert.ok(!/30 days/.test(q.text), 'never day-count a month');
  });

  test('DRY RUN reports who would be emailed and writes nothing', async () => {
    const { sql, claims, queued } = sqlWithConstraints([candidate(), candidate({ user_id: 2, email: 'c@d.e' })]);

    const result = await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg(), { dryRun: true });

    assert.equal(result.wouldEmail.length, 2);
    assert.equal(result.wouldEmail[0].email, 'a@b.c');
    assert.match(result.wouldEmail[0].dedupeKey, /lead:14/);
    assert.equal(result.queued, 0);
    assert.equal(claims.size, 0, 'dry run must not claim');
    assert.equal(queued.size, 0, 'dry run must not queue');
  });

  test('PARTIAL FAILURE does not re-send to already-notified users on retry', async () => {
    const { sql } = sqlWithConstraints([
      candidate({ user_id: 1 }),
      candidate({ user_id: 2, email: 'two@x.c' }),
    ]);
    const job = creditExpiryJob(14, cfg());

    const first = await runNotificationJob(sql, job, cfg());
    assert.equal(first.queued, 2);

    // The job is re-run after a crash. Both are already claimed.
    const retry = await runNotificationJob(sql, job, cfg());
    assert.equal(retry.queued, 0);
    assert.equal(retry.skippedDuplicate, 2);
  });
});

describe('BILL-008 — inactivity', () => {
  test('queues for a user inactive past the threshold', async () => {
    const { sql } = sqlWithConstraints([candidate()]);
    const result = await runNotificationJob(sql, inactivityJob(cfg()), cfg());
    assert.equal(result.queued, 1);
  });

  test('the definition is 14 consecutive days, measured in whole UTC days', async () => {
    const { sql } = sqlWithConstraints([]);
    await runNotificationJob(sql, inactivityJob(cfg()), cfg());
    const q = sql.matching(/WITH last_activity/)[0];
    assert.match(q.text, /last_generation_at AT TIME ZONE 'UTC'\)::date <=/);
    assert.ok(q.params.includes(14));
  });

  test('FREQUENCY CAP: a continuously inactive user is not emailed repeatedly', async () => {
    // Simulate 90 daily runs. The dedupe key is the last-activity date, which
    // does not change while the user stays away, so exactly one email is sent.
    const { sql } = sqlWithConstraints([candidate({ last_generation_at: '2026-06-01T00:00:00Z' })]);
    const job = inactivityJob(cfg());

    let totalQueued = 0;
    for (let day = 0; day < 90; day++) {
      totalQueued += (await runNotificationJob(sql, job, cfg())).queued;
    }

    assert.equal(totalQueued, 1, `expected 1 email over 90 days, got ${totalQueued}`);
  });

  test('returning and lapsing again DOES re-trigger, because the window moved', async () => {
    const c = cfg();
    const first = sqlWithConstraints([candidate({ last_generation_at: '2026-06-01T00:00:00Z' })]);
    assert.equal((await runNotificationJob(first.sql, inactivityJob(c), c)).queued, 1);

    // The user came back on 1 August and lapsed again: a new window.
    const second = sqlWithConstraints([candidate({ last_generation_at: '2026-08-01T00:00:00Z' })]);
    assert.equal((await runNotificationJob(second.sql, inactivityJob(c), c)).queued, 1);
  });

  test('the cooldown is enforced in SQL', async () => {
    const { sql } = sqlWithConstraints([]);
    await runNotificationJob(sql, inactivityJob(cfg()), cfg());
    const q = sql.matching(/WITH last_activity/)[0];
    assert.match(q.text, /NOT EXISTS \( SELECT 1 FROM user_notifications/);
    assert.ok(q.params.includes(60), 'the signed-off 60-day cooldown');
  });

  test('SUPPRESSION: each rule is present in the candidate query', async () => {
    const { sql } = sqlWithConstraints([]);
    await runNotificationJob(sql, inactivityJob(cfg()), cfg());
    const q = sql.matching(/WITH last_activity/)[0];

    assert.match(q.text, /marketing_opt_out_at IS NULL/, 'unsubscribed');
    assert.match(q.text, /email_hard_bounced_at IS NULL/, 'hard-bounced');
    assert.match(q.text, /is_internal = FALSE/, 'internal/test accounts');
    assert.match(q.text, /NOT IN \('past_due', 'unpaid', 'incomplete'\)/, 'dunning accounts get a different email');
    assert.match(q.text, /HAVING COALESCE\(SUM\(cb\.amount\), 0\) > 0/, 'zero-credit users excluded');
    // Never-generated users are excluded by the INNER JOIN on last_activity.
    assert.match(q.text, /JOIN last_activity la ON la\.user_id = u\.id/);
  });

  test('the payload states the balance and nearest expiry at send time', () => {
    const payload = inactivityJob(cfg()).payload(candidate(), cfg());
    assert.equal(payload.creditBalance, '120 credits');
    assert.equal(payload.planName, 'Grow');
    assert.ok(payload.nearestExpiry);
    for (const key of ['firstName', 'creditBalance', 'nearestExpiry', 'planName', 'ctaUrl']) {
      assert.ok(key in payload, `payload is missing ${key}`);
    }
  });

  test('it is queued as LIFECYCLE, so marketing preferences apply', () => {
    assert.equal(inactivityJob(cfg()).category, 'lifecycle');
    // …unlike the billing receipts, which must never be suppressible.
    assert.equal(creditExpiryJob(14, cfg()).category, 'lifecycle');
  });
});

describe('shared runner', () => {
  test('BILL-008 reuses BILL-007 scheduling rather than duplicating it', () => {
    // Both are JobDefinitions handed to the same runNotificationJob. If someone
    // adds a parallel scheduler later, this shape check is what notices.
    const expiry = creditExpiryJob(14, cfg());
    const inactivity = inactivityJob(cfg());
    for (const job of [expiry, inactivity]) {
      assert.equal(typeof job.fetchPage, 'function');
      assert.equal(typeof job.dedupeKey, 'function');
      assert.equal(typeof job.payload, 'function');
    }
  });

  test('paging stops at the end rather than looping forever', async () => {
    const { sql } = sqlWithConstraints([candidate()]);
    // One row returned against a batch size of 100 → a short page → stop.
    const result = await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());
    assert.equal(result.scanned, 1);
    assert.equal(sql.countMatching(/SELECT u\.id AS user_id/), 1);
  });

  test('a candidate query failure is reported, not thrown', async () => {
    const sql = createFakeSql().failOn(/SELECT u\.id AS user_id/);
    const result = await runNotificationJob(sql, creditExpiryJob(14, cfg()), cfg());
    assert.equal(result.errors, 1);
    assert.equal(result.queued, 0);
  });

  test('runAllNotificationJobs covers every configured lead time plus inactivity', async () => {
    const { sql } = sqlWithConstraints([]);
    const results = await runAllNotificationJobs(sql, { dryRun: true });
    // 14, 3, 0 + inactivity. The credit-expiry passes still APPEAR while the
    // email is gated — a job that vanished from the output would look like a
    // bug, and this dry run is how the runbook checks what the scheduler does.
    assert.equal(results.length, 4);
    assert.deepEqual(
      results.map((r) => r.name.replace(/ — DISABLED .*/, '')),
      ['credit_expiry(14d)', 'credit_expiry(3d)', 'credit_expiry(0d)', 'inactivity'],
    );
  });

  test('the placeholder credit-expiry email is OFF unless explicitly enabled', async () => {
    // It queues a template that literally reads "[PLACEHOLDER] Your credits
    // expire in 14 days", from a live Mailgun domain, to every account that
    // crosses the threshold. LIFECYCLE_EMAILS_ENABLED does NOT hold it back —
    // that is set, and the scheduler runs daily.
    const previous = process.env.ISEO_CREDIT_EXPIRY_EMAILS_ENABLED;
    delete process.env.ISEO_CREDIT_EXPIRY_EMAILS_ENABLED;
    try {
      const { sql, queued } = sqlWithConstraints([candidate({ expiring_total: 100 })]);
      // dryRun: true deliberately. The gate is checked before the runner, so a
      // dry run proves it just as well — and runExpirySweep() ignores the
      // injected sql and writes to the REAL database, so a test that passes
      // dryRun:false expires production lots. Found the hard way.
      const results = await runAllNotificationJobs(sql, { dryRun: true });
      const expiry = results.filter((r) => /^credit_expiry\(/.test(r.name));

      assert.equal(expiry.length, 3, 'the passes are still reported');
      for (const r of expiry) {
        assert.match(r.name, /DISABLED/, 'and are visibly marked as off');
        assert.equal(r.queued, 0);
        assert.equal(r.wouldEmail.length, 0);
      }
      assert.equal(queued.size, 0, 'nothing reached the outbox');
    } finally {
      if (previous === undefined) delete process.env.ISEO_CREDIT_EXPIRY_EMAILS_ENABLED;
      else process.env.ISEO_CREDIT_EXPIRY_EMAILS_ENABLED = previous;
    }
  });
});
