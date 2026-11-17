/**
 * The rank tracker admin API over HTTP, with a fake tracker.
 *
 * What is being protected:
 *  1. Admin only on every route.
 *  2. Adding a target is free and never triggers a paid check; spending is an explicit act.
 *  3. The two paid routes refuse without credentials; the free ones keep working without them.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestHandler } from 'express';
import { startTestApp, type TestApp } from '../test/helpers/http-app.js';
import { createRankTrackerRouter, type RankTracker } from './rank-tracker.handler.js';

const admin: RequestHandler = (req, res, next) =>
  req.header('authorization') === 'Bearer admin' ? next() : res.status(401).json({ success: false });

const H = { Authorization: 'Bearer admin' };

let app: TestApp | null = null;
afterEach(async () => {
  const a = app;
  app = null;
  await a?.close();
});

function build(opts: { configured?: boolean } = {}) {
  const calls: string[] = [];
  const added: unknown[] = [];
  const tracker = {
    async listTargets() {
      calls.push('list');
      return [{ id: 1, domain: 'example.com', keyword: 'water heater repair', position: 8, previous_position: 14, change: -6 }];
    },
    async addTarget(input: unknown) {
      calls.push('add');
      added.push(input);
      return { id: 2, ...(input as object) };
    },
    async removeTarget() {
      calls.push('remove');
    },
    async history() {
      calls.push('history');
      return [{ checked_at: '2026-11-17T00:00:00.000Z', position: 8, ranking_url: 'example.com' }];
    },
    async checkById() {
      calls.push('check');
      return { target_id: 1, position: 8, ranking_url: 'example.com', checked_at: '2026-11-17T00:00:00.000Z', cost_usd: 0.0035 };
    },
    async runDue() {
      calls.push('run');
      return { checked: 3, cost_usd: 0.0105 };
    },
  } as unknown as RankTracker;

  const router = createRankTrackerRouter({
    auth: admin,
    tracker: () => tracker,
    configured: () => opts.configured ?? true,
    log: () => {},
  });
  return { router, calls, added };
}

describe('auth', () => {
  test('every route is admin only', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    assert.equal((await app.get('/api/v1/rank-tracker/targets')).status, 401);
    assert.equal((await app.post('/api/v1/rank-tracker/targets', { domain: 'a.com', keyword: 'k' })).status, 401);
    assert.equal((await app.post('/api/v1/rank-tracker/run', {})).status, 401);
  });
});

describe('targets', () => {
  test('lists with the change since the previous check', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    const r = await app.get('/api/v1/rank-tracker/targets', H);
    assert.equal(r.status, 200);
    assert.equal(r.body.targets[0].change, -6, 'negative is an improvement');
  });

  test('adding is free and runs no check', async () => {
    const { router, calls, added } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);

    const r = await app.post('/api/v1/rank-tracker/targets', { domain: 'https://www.Example.com/blog', keyword: 'Water Heater Repair' }, H);
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['add']);
    assert.ok(!calls.includes('check'), 'adding must never spend money');
    assert.equal((added[0] as { location_code: number }).location_code, 2840, 'defaults applied');
  });

  test('rejects a target that could never match', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    for (const body of [{}, { domain: 'a.com' }, { keyword: 'k' }, { domain: 'x', keyword: 'k' }, { domain: 'a.com', keyword: '' }]) {
      const r = await app.post('/api/v1/rank-tracker/targets', body, H);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
  });

  test('a non-numeric id is refused', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    assert.equal((await app.get('/api/v1/rank-tracker/targets/abc/history', H)).status, 400);
  });
});

describe('the paid routes', () => {
  test('refuse without credentials, while the free ones keep working', async () => {
    const { router, calls } = build({ configured: false });
    app = await startTestApp([['/api/v1/rank-tracker', router]]);

    const check = await app.post('/api/v1/rank-tracker/targets/1/check', {}, H);
    assert.equal(check.status, 503);
    assert.equal(check.body.code, 'KEYWORD_DATA_NOT_CONFIGURED');

    const run = await app.post('/api/v1/rank-tracker/run', {}, H);
    assert.equal(run.status, 503);

    assert.equal((await app.get('/api/v1/rank-tracker/targets', H)).status, 200, 'listing needs no provider');
    assert.ok(!calls.includes('check') && !calls.includes('run'));
  });

  test('a check reports the position and what it cost', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    const r = await app.post('/api/v1/rank-tracker/targets/1/check', {}, H);
    assert.equal(r.status, 200);
    assert.equal(r.body.result.position, 8);
    assert.equal(r.body.result.cost_usd, 0.0035);
  });

  test('a run reports how many were checked and the spend', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    const r = await app.post('/api/v1/rank-tracker/run', { max: 10 }, H);
    assert.equal(r.status, 200);
    assert.equal(r.body.checked, 3);
    assert.equal(r.body.cost_usd, 0.0105);
  });

  test('a run cannot be asked to spend without limit', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/rank-tracker', router]]);
    assert.equal((await app.post('/api/v1/rank-tracker/run', { max: 9999 }, H)).status, 400);
    assert.equal((await app.post('/api/v1/rank-tracker/run', { max: 0 }, H)).status, 400);
    assert.equal(calls.length, 0);
  });
});
