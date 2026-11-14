/**
 * POST /content-v3/keyword-data/prefetch over real HTTP with a fake auth and a fake service.
 *
 * What is being protected: auth first; the contract's validation; the response is the contract
 * shape plus success:true; "unavailable" is a 200 (the plugin proceeds without data), with the
 * reason; the lookup runs under the 8 s budget; the live wiring is plugin-authenticated.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeywordDataPrefetchRouter } from './content-v3-keyword-data.handler.js';
import { rateLimitPerUser, __resetRateLimitBuckets } from '../middleware/rateLimit.middleware.js';
import { startTestApp, fakePluginAuth, PLUGIN_HEADERS, type TestApp } from '../test/helpers/http-app.js';
import type { KeywordDataService, SeedWithRelated } from '../services/keyword-data/keyword-data.service.js';
import type { KeywordMetricsItem } from '../services/keyword-data/keyword-data.types.js';

const AT = '2026-11-11T10:00:00.000Z';
const item = (keyword: string, search_volume: number | null = null): KeywordMetricsItem => ({
  keyword, search_volume, keyword_difficulty: null, intent: null, scope: 'national', fetched_at: AT,
});

let app: TestApp | null = null;
let calls: any[] = [];
beforeEach(() => { __resetRateLimitBuckets(); calls = []; });
afterEach(async () => { await app?.close(); app = null; });

async function start(impl: () => Promise<SeedWithRelated>, enabled?: () => boolean) {
  const service = {
    configured: true,
    getMetrics: async () => { throw new Error('not used'); },
    getSeedWithRelated: async (...args: any[]) => { calls.push(args); return impl(); },
    tryGetForPrompt: async () => null,
  } as unknown as KeywordDataService;
  const router = createKeywordDataPrefetchRouter({
    service: () => service,
    auth: fakePluginAuth(),
    rateLimit: rateLimitPerUser({ limit: 100, windowMs: 60_000, keyPrefix: 'test-prefetch' }),
    enabled,
    log: () => {},
  });
  app = await startTestApp([['/api/v1/content-v3/keyword-data', router]]);
  return app;
}

const URL = '/api/v1/content-v3/keyword-data/prefetch';

describe('prefetch', () => {
  test('B-5: with v3 or keyword data switched off → 200 "unavailable" (disabled), no lookup', async () => {
    const a = await start(async () => ({ status: 'ready', seed: null, related: [], cost_usd: 0, source: 'cache' }), () => false);
    const r = await a.post(URL, { keyword: 'boiler repair' }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, status: 'unavailable', seed: null, related_count: 0, reason: 'disabled' });
    assert.equal(calls.length, 0);
  });

  test('B-5: the live wiring passes the switches (CONTENT_V3_ENABLED and ISEO_V3_KEYWORD_DATA)', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'content-v3-keyword-data.routes.ts'), 'utf8');
    assert.match(src, /enabled: \(\) => contentV3Enabled\(\) && keywordDataFlagOn\(\)/);
  });

  test('401 without the plugin headers', async () => {
    const a = await start(async () => ({ status: 'ready', seed: null, related: [], cost_usd: 0, source: 'cache' }));
    assert.equal((await a.post(URL, { keyword: 'a' })).status, 401);
    assert.equal(calls.length, 0);
  });

  test('400 on a missing, blank, non-string or over-long keyword, or a bad location/language', async () => {
    const a = await start(async () => ({ status: 'ready', seed: null, related: [], cost_usd: 0, source: 'cache' }));
    for (const body of [{}, { keyword: '  ' }, { keyword: 5 }, { keyword: 'x'.repeat(201) }, { keyword: 'a', location_code: 0 }, { keyword: 'a', language_code: 'eng' }]) {
      const r = await a.post(URL, body, PLUGIN_HEADERS);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'VALIDATION_ERROR');
    }
    assert.equal(calls.length, 0);
  });

  test('ready: the contract body plus success:true, and the lookup ran under the 8 s budget', async () => {
    const seed = item('water heater repair cost', 2400);
    const a = await start(async () => ({ status: 'ready', seed, related: [item('a', 1), item('b', 2)], cost_usd: 0.02, source: 'dataforseo' }));
    const r = await a.post(URL, { keyword: ' Water Heater Repair Cost ' }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, status: 'ready', seed, related_count: 2 });
    assert.deepEqual(calls[0], ['Water Heater Repair Cost', 2840, 'en', { budgetMs: 8000 }]);
  });

  test('unavailable: still 200, with seed null, related_count 0 and the reason', async () => {
    const a = await start(async () => ({ status: 'unavailable', seed: null, related: [], cost_usd: 0, source: 'none', reason: 'budget' }));
    const r = await a.post(URL, { keyword: 'a', location_code: 2826, language_code: 'EN' }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, status: 'unavailable', seed: null, related_count: 0, reason: 'budget' });
    assert.deepEqual(calls[0].slice(0, 3), ['a', 2826, 'en']);
  });

  test('an unexpected throw is a 500, not a crash', async () => {
    const a = await start(async () => { throw new Error('boom'); });
    const r = await a.post(URL, { keyword: 'a' }, PLUGIN_HEADERS);
    assert.equal(r.status, 500);
    assert.equal(r.body.success, false);
  });
});

describe('live wiring (source assertions)', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wiring = fs.readFileSync(path.join(SRC, 'routes/content-v3-keyword-data.routes.ts'), 'utf8');
  const v3 = fs.readFileSync(path.join(SRC, 'routes/content-v3.routes.ts'), 'utf8');

  test('prefetch is plugin-authenticated with its own rate-limit namespace, mounted under /content-v3/keyword-data', () => {
    assert.match(wiring, /auth: validateApiAccess/);
    assert.match(wiring, /keyPrefix: 'keyword-data-prefetch'/);
    assert.match(v3, /router\.use\('\/keyword-data', keywordDataRoutes\);/);
  });

  test('the existing admin-only v3 routes are untouched', () => {
    assert.match(v3, /router\.post\('\/article\/test', requireAdmin, async/);
    assert.match(v3, /router\.post\('\/prompts\/seed', requireAdmin, async/);
  });
});
