/**
 * POST /generate/keywords/metrics over real HTTP, with a fake auth, a fake service and fake credits.
 *
 * What is being protected:
 *  1. Auth runs first: no headers → 401 before anything else.
 *  2. Validation: the contract's limits (1..100 keywords, positive location_code, 2-letter
 *     language_code) produce 400 with a stable code and zod details.
 *  3. The success body is the contract shape plus success:true — items, cached_count, cost_usd —
 *     whether the answer came from the cache or from DataForSEO.
 *  4. Provider failures map to 503/502/504/400 with stable codes; nothing provider-internal leaks.
 *  5. Credits: 0 means no credit code runs; >0 reserves first, refunds on failure, 402 when short.
 *  6. The per-account rate limit answers 429.
 *  7. The live wiring uses validateApiAccess and mounts under /generate/keywords.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeywordMetricsRouter, keywordDataErrorResponse, metricsRequestSchema } from './keyword-metrics.handler.js';
import { rateLimitPerUser, __resetRateLimitBuckets } from '../middleware/rateLimit.middleware.js';
import { startTestApp, fakePluginAuth, PLUGIN_HEADERS, type TestApp } from '../test/helpers/http-app.js';
import { KeywordDataNotConfiguredError, KeywordDataBudgetError, type KeywordDataService, type MetricsResult } from '../services/keyword-data/keyword-data.service.js';
import { DataForSeoError } from '../services/keyword-data/dataforseo.client.js';
import type { KeywordMetricsItem } from '../services/keyword-data/keyword-data.types.js';

const AT = '2026-11-11T10:00:00.000Z';
const item = (keyword: string, search_volume: number | null = null): KeywordMetricsItem => ({
  keyword,
  search_volume,
  keyword_difficulty: null,
  intent: null,
  scope: 'national',
  fetched_at: AT,
});

function fakeService(impl: (keywords: string[], loc?: number, lang?: string) => Promise<MetricsResult>) {
  const calls: any[] = [];
  const service = {
    configured: true,
    getMetrics: async (keywords: string[], loc?: number, lang?: string) => {
      calls.push({ keywords, loc, lang });
      return impl(keywords, loc, lang);
    },
    getSeedWithRelated: async () => { throw new Error('not used'); },
    tryGetForPrompt: async () => null,
  } as unknown as KeywordDataService;
  return { service, calls };
}

interface Harness {
  app: TestApp;
  calls: any[];
  credit: { cost: number; reserve: any[]; refund: any[]; reserveOk: boolean };
  logs: string[];
}

async function harness(impl: Parameters<typeof fakeService>[0], opts: { cost?: number; reserveOk?: boolean; limit?: number } = {}): Promise<Harness> {
  const { service, calls } = fakeService(impl);
  const credit = { cost: opts.cost ?? 0, reserve: [] as any[], refund: [] as any[], reserveOk: opts.reserveOk ?? true };
  const logs: string[] = [];
  const router = createKeywordMetricsRouter({
    service: () => service,
    auth: fakePluginAuth(),
    rateLimit: rateLimitPerUser({ limit: opts.limit ?? 100, windowMs: 60_000, keyPrefix: 'test-metrics' }),
    creditCost: () => credit.cost,
    reserveCredits: async (...args) => { credit.reserve.push(args); return { ok: credit.reserveOk }; },
    refundCredits: async (...args) => { credit.refund.push(args); },
    liveBalance: async () => 1,
    log: (l) => logs.push(l),
  });
  const app = await startTestApp([['/api/v1/generate/keywords', router]]);
  return { app, calls, credit, logs };
}

let current: Harness | null = null;
beforeEach(() => __resetRateLimitBuckets());
afterEach(async () => { await current?.app.close(); current = null; });

const URL = '/api/v1/generate/keywords/metrics';
const ok = (items: KeywordMetricsItem[], cached_count = 0, cost_usd = 0): MetricsResult => ({ items, cached_count, cost_usd });

describe('auth', () => {
  test('401 without the plugin headers, and the service is never called', async () => {
    current = await harness(async () => ok([]));
    const r = await current.app.post(URL, { keywords: ['a'] });
    assert.equal(r.status, 401);
    assert.equal(r.body.success, false);
    assert.equal(current.calls.length, 0);
  });
});

describe('validation', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['missing keywords', {}, /keywords is required/],
    ['keywords not an array', { keywords: 'a' }, /keywords must be an array/],
    ['empty keywords', { keywords: [] }, /at least 1/],
    ['101 keywords', { keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) }, /at most 100/],
    ['a non-string keyword', { keywords: [1] }, /each keyword must be a string/],
    ['a blank keyword', { keywords: ['  '] }, /must not be empty/],
    ['negative location_code', { keywords: ['a'], location_code: -1 }, /location_code/],
    ['fractional location_code', { keywords: ['a'], location_code: 1.5 }, /location_code/],
    ['string location_code', { keywords: ['a'], location_code: '2840' }, /location_code must be a number/],
    ['bad language_code', { keywords: ['a'], language_code: 'english' }, /two-letter/],
  ];
  for (const [name, body, expected] of bad) {
    test(`400 on ${name}`, async () => {
      current = await harness(async () => ok([]));
      const r = await current.app.post(URL, body, PLUGIN_HEADERS);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.success, false);
      assert.equal(r.body.code, 'VALIDATION_ERROR');
      assert.match(r.body.error, expected);
      assert.ok(r.body.details?.fieldErrors || r.body.details?.formErrors, 'zod details are included');
      assert.equal(current.calls.length, 0);
    });
  }

  test('defaults: location 2840 and language "en"; language is lower-cased', () => {
    assert.deepEqual(metricsRequestSchema.parse({ keywords: ['a'] }), { keywords: ['a'], location_code: 2840, language_code: 'en' });
    assert.equal(metricsRequestSchema.parse({ keywords: ['a'], language_code: 'DE' }).language_code, 'de');
    assert.equal(metricsRequestSchema.parse({ keywords: ['a'], location_code: 2826 }).location_code, 2826);
  });
});

describe('responses', () => {
  test('uncached: the contract body plus success:true, and the service gets the parsed request', async () => {
    const items = [item('water heater repair cost', 2400), item('boiler service', null)];
    current = await harness(async () => ok(items, 0, 0.0211));
    const r = await current.app.post(URL, { keywords: ['Water Heater Repair Cost', 'boiler service'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, items, cached_count: 0, cost_usd: 0.0211 });
    assert.deepEqual(current.calls[0], { keywords: ['Water Heater Repair Cost', 'boiler service'], loc: 2840, lang: 'en' });
    assert.match(current.logs.join('\n'), /\[keyword-metrics\] user=7 website=3 requested=2 unique=2 cached=0 cost_usd=0.0211 credits=0 ms=\d+/);
  });

  test('cached: cached_count reflects the hits and cost_usd is 0; location/language pass through', async () => {
    current = await harness(async () => ok([item('a', 1), item('b', 2)], 2, 0));
    const r = await current.app.post(URL, { keywords: ['a', 'b'], location_code: 2826, language_code: 'en' }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(r.body.cached_count, 2);
    assert.equal(r.body.cost_usd, 0);
    assert.deepEqual(current.calls[0], { keywords: ['a', 'b'], loc: 2826, lang: 'en' });
  });

  test('503 KEYWORD_DATA_NOT_CONFIGURED when DATAFORSEO_* are missing', async () => {
    current = await harness(async () => { throw new KeywordDataNotConfiguredError(); });
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'KEYWORD_DATA_NOT_CONFIGURED');
  });

  test('provider failures map to stable codes without leaking provider detail', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new DataForSeoError({ kind: 'server', level: 'http', endpoint: 'keyword_overview', message: 'HTTP 503 internal-host-x' }), 502, 'KEYWORD_DATA_PROVIDER_ERROR'],
      [new DataForSeoError({ kind: 'timeout', level: 'transport', endpoint: 'keyword_overview', message: 'timed out' }), 504, 'KEYWORD_DATA_TIMEOUT'],
      [new KeywordDataBudgetError(8000), 504, 'KEYWORD_DATA_TIMEOUT'],
      [new DataForSeoError({ kind: 'bad_request', level: 'task', endpoint: 'keyword_overview', message: 'Invalid Field: location_code' }), 400, 'KEYWORD_DATA_BAD_REQUEST'],
      [new DataForSeoError({ kind: 'auth', level: 'http', endpoint: 'keyword_overview', message: 'HTTP 401' }), 503, 'KEYWORD_DATA_PROVIDER_UNAVAILABLE'],
      [new DataForSeoError({ kind: 'payment', level: 'task', endpoint: 'keyword_overview', message: 'Insufficient money' }), 503, 'KEYWORD_DATA_PROVIDER_UNAVAILABLE'],
    ];
    for (const [err, status, code] of cases) {
      const mapped = keywordDataErrorResponse(err);
      assert.equal(mapped?.status, status, code);
      assert.equal(mapped?.body.code, code);
      assert.doesNotMatch(mapped?.body.error ?? '', /internal-host-x|Insufficient money/);
    }
    assert.equal(keywordDataErrorResponse(new Error('other')), null);

    current = await harness(async () => { throw new DataForSeoError({ kind: 'rate_limit', level: 'response', endpoint: 'keyword_overview', message: 'Too many requests' }); });
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'KEYWORD_DATA_RATE_LIMITED');
    assert.equal(r.headers.get('retry-after'), '5');
  });

  test('an unexpected error is a plain 500', async () => {
    current = await harness(async () => { throw new Error('boom'); });
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { success: false, error: 'Failed to fetch keyword metrics' });
  });
});

describe('credits', () => {
  test('cost 0 (the default): no reserve, no refund, no credits field', async () => {
    current = await harness(async () => ok([item('a', 1)]));
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(current.credit.reserve.length, 0);
    assert.equal('credits' in r.body, false);
  });

  test('cost > 0: reserved before the lookup, echoed in the body', async () => {
    current = await harness(async () => ok([item('a', 1)]), { cost: 2 });
    const r = await current.app.post(URL, { keywords: ['a', 'b'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.deepEqual(current.credit.reserve[0], [7, 2, 'Keyword metrics (2 keywords)', 3]);
    assert.deepEqual(r.body.credits, { charged: 2 });
    assert.equal(current.credit.refund.length, 0);
  });

  test('cost > 0 and short: 402 with the shortfall, and the provider is never called', async () => {
    current = await harness(async () => ok([]), { cost: 2, reserveOk: false });
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(r.body.required, 2);
    assert.equal(r.body.available, 1);
    assert.equal(r.body.shortfall, 1);
    assert.equal(current.calls.length, 0);
  });

  test('cost > 0 and the lookup fails: the charge is refunded', async () => {
    current = await harness(async () => { throw new KeywordDataBudgetError(8000); }, { cost: 2 });
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 504);
    assert.equal(current.credit.refund.length, 1);
    assert.deepEqual(current.credit.refund[0].slice(0, 2), [7, 2]);
    assert.equal(current.credit.refund[0][3], 3);
  });
});

describe('rate limit', () => {
  test('the (limit+1)th call in a minute is a 429', async () => {
    current = await harness(async () => ok([]), { limit: 3 });
    for (let i = 0; i < 3; i++) assert.equal((await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS)).status, 200);
    const r = await current.app.post(URL, { keywords: ['a'] }, PLUGIN_HEADERS);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
  });
});

describe('live wiring (source assertions — the real middleware needs a database)', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wiring = fs.readFileSync(path.join(SRC, 'routes/keyword-metrics.routes.ts'), 'utf8');
  const generation = fs.readFileSync(path.join(SRC, 'routes/generation.routes.ts'), 'utf8');

  test('uses the plugin auth, its own rate-limit namespace and the configured credit cost', () => {
    assert.match(wiring, /auth: validateApiAccess/);
    assert.match(wiring, /keyPrefix: 'keyword-metrics'/);
    assert.match(wiring, /creditCost: \(\) => KEYWORD_METRICS_CREDIT_COST/);
    assert.match(wiring, /reserveCredits\(userId, ISEO_CREDIT_TYPE, amount, reason, websiteId\)/);
    assert.match(wiring, /refundCredits\(userId, ISEO_CREDIT_TYPE, amount, reason, websiteId\)/);
  });

  test('is mounted under /generate/keywords, beside the untouched /generatekeyword', () => {
    assert.match(generation, /router\.use\('\/keywords', keywordMetricsRoutes\);/);
    assert.match(generation, /router\.post\('\/generatekeyword', validateApiAccess, async/);
  });
});
