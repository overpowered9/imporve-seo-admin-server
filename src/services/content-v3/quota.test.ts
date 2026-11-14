/**
 * B-5: the free steps' daily allowance. What is protected: the defaults and the env override; a
 * refusal is not counted; an article raises the allowance at once; a missing table lets requests
 * through (logged once); counters older than the purge window go.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedToday,
  createMemoryQuotaStore,
  createPostgresQuotaStore,
  DEFAULT_FREE_STEP_LIMITS,
  freeStepGuard,
  freeStepLimits,
  QUOTA_MESSAGE,
  type QuotaStore,
} from './quota.js';
import { startTestApp, fakePluginAuth, PLUGIN_HEADERS } from '../../test/helpers/http-app.js';
import { Router } from 'express';

test('defaults: title 60 + 5 per article, town check 100 + 10, approve 30 + 3', () => {
  assert.deepEqual(freeStepLimits({}), DEFAULT_FREE_STEP_LIMITS);
  assert.equal(allowedToday(DEFAULT_FREE_STEP_LIMITS.approve, 0), 30);
  assert.equal(allowedToday(DEFAULT_FREE_STEP_LIMITS.approve, 10), 60);
  assert.equal(allowedToday({ base: 1, per_article: 1.5 }, 3), 5);
});

test('CONTENT_V3_FREE_STEP_LIMITS_JSON overrides per step; bad values and bad JSON keep the defaults', () => {
  const l = freeStepLimits({ CONTENT_V3_FREE_STEP_LIMITS_JSON: '{"approve":{"base":50},"title":{"per_article":-1},"town_check":"x"}' });
  assert.deepEqual(l.approve, { base: 50, per_article: 3 });
  assert.deepEqual(l.title, DEFAULT_FREE_STEP_LIMITS.title);
  assert.deepEqual(l.town_check, DEFAULT_FREE_STEP_LIMITS.town_check);
  assert.deepEqual(freeStepLimits({ CONTENT_V3_FREE_STEP_LIMITS_JSON: '{nope' }), DEFAULT_FREE_STEP_LIMITS);
});

test('memory store: allowed up to the allowance; a refusal changes nothing; articles raise it', async () => {
  const q = createMemoryQuotaStore(() => '2026-11-14');
  const limit = { base: 2, per_article: 2 };
  assert.equal((await q.takeStep(1, 'approve', limit)).allowed, true);
  assert.equal((await q.takeStep(1, 'approve', limit)).allowed, true);
  const refused = await q.takeStep(1, 'approve', limit);
  assert.deepEqual(refused, { allowed: false, used: 2, articles: 0 });
  assert.equal((await q.takeStep(1, 'approve', limit)).used, 2, 'refusals are not counted');
  assert.equal(await q.countArticle(1), 1);
  assert.deepEqual(await q.takeStep(1, 'approve', limit), { allowed: true, used: 3, articles: 1 });
  assert.equal((await q.takeStep(2, 'approve', limit)).allowed, true, 'per account');
});

test('memory store: purge drops counters older than the window', async () => {
  let day = '2026-10-01';
  const q = createMemoryQuotaStore(() => day);
  await q.takeStep(1, 'title', { base: 5, per_article: 0 });
  day = '2026-11-14';
  await q.takeStep(1, 'title', { base: 5, per_article: 0 });
  assert.equal(await q.purge(30), 1);
  assert.equal(q.counts.size, 1);
});

test('postgres store: refused when the conditional upsert returns no row; the limit is today\'s allowance', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  let upsertRows: any[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('$');
      queries.push({ text, values });
      if (/SELECT count FROM content_v3_quota/.test(text)) return [{ count: 4 }];
      return upsertRows;
    },
    { begin: async () => { throw new Error('unused'); } },
  );
  const q = createPostgresQuotaStore(sql as any);
  upsertRows = [];
  assert.deepEqual(await q.takeStep(9, 'approve', { base: 30, per_article: 3 }), { allowed: false, used: 42, articles: 4 });
  assert.match(queries[1].text, /ON CONFLICT \(user_id, day, kind\) DO UPDATE SET count = content_v3_quota\.count \+ 1\s+WHERE content_v3_quota\.count < \$/);
  assert.deepEqual(queries[1].values, [9, 'approve', 42]);
  upsertRows = [{ count: 7 }];
  assert.deepEqual(await q.takeStep(9, 'approve', { base: 30, per_article: 3 }), { allowed: true, used: 7, articles: 4 });
});

async function guardApp(store: QuotaStore | (() => Promise<QuotaStore>), logs: string[]) {
  const router = Router();
  const quota = typeof store === 'function' ? store : async () => store;
  router.post('/x', fakePluginAuth({ id: 5 }, { id: 9 }), freeStepGuard('title', quota, { limits: { ...DEFAULT_FREE_STEP_LIMITS, title: { base: 1, per_article: 0 } }, log: (l) => logs.push(l) }), (_req, res) => {
    res.json({ ok: true });
  });
  return startTestApp([['/t', router]]);
}

test('guard: 429 with the plain message past the allowance, logged with the counts', async () => {
  const logs: string[] = [];
  const app = await guardApp(createMemoryQuotaStore(), logs);
  try {
    assert.equal((await app.post('/t/x', {}, PLUGIN_HEADERS)).status, 200);
    const r = await app.post('/t/x', {}, PLUGIN_HEADERS);
    assert.equal(r.status, 429);
    assert.deepEqual(r.body, { success: false, error: 'rate_limited', message: QUOTA_MESSAGE });
    assert.match(logs.join('\n'), /daily allowance reached user=5 step=title used=1 articles=0/);
  } finally {
    await app.close();
  }
});

test('guard: without the table (migration 024 not applied) requests pass, logged once', async () => {
  const logs: string[] = [];
  const app = await guardApp(async () => {
    throw new Error('relation "content_v3_quota" does not exist');
  }, logs);
  try {
    assert.equal((await app.post('/t/x', {}, PLUGIN_HEADERS)).status, 200);
    assert.equal((await app.post('/t/x', {}, PLUGIN_HEADERS)).status, 200);
    assert.equal(logs.filter((l) => l.includes('quota unavailable')).length, 1);
  } finally {
    await app.close();
  }
});
