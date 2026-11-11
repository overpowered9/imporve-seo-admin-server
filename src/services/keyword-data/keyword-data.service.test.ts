/**
 * The keyword data service with a scripted client and the in-memory cache.
 *
 * What is being protected:
 *  1. Keywords are de-duplicated after normalisation and answered in request order.
 *  2. The cache is consulted first; only misses go to DataForSEO, in ONE batched call.
 *  3. A keyword DataForSEO knows nothing about is an all-null item, cached like any other.
 *  4. Without credentials, cache hits still work and misses say "not configured".
 *  5. getSeedWithRelated honours its budget, falls back cleanly, and a late answer still lands in
 *     the cache for the next request.
 *  6. tryGetForPrompt never throws: it returns the block or null, and logs every fallback.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeywordDataService,
  KeywordDataNotConfiguredError,
  withBudget,
  KeywordDataBudgetError,
} from './keyword-data.service.js';
import { createMemoryKeywordDataCache } from './keyword-data-cache.js';
import { DataForSeoError, type DataForSeoClient, type DataForSeoCallResult } from './dataforseo.client.js';

const AT = new Date('2026-11-11T10:00:00.000Z');

function ok<R>(result: R[], cost = 0.01): DataForSeoCallResult<R> {
  return { result, cost, latencyMs: 5, taskId: 't', attempts: 1 };
}

type Overview = Array<{ keyword: string; volume?: number | null; kd?: number | null; intent?: string | null }>;

function fakeClient(opts: {
  overview?: Overview | Error | 'hang';
  related?: Overview | Error | 'hang';
} = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const toItems = (list: Overview) =>
    list.map((k) => ({
      keyword: k.keyword,
      keyword_info: { search_volume: k.volume ?? null },
      keyword_properties: { keyword_difficulty: k.kd ?? null },
      search_intent_info: { main_intent: k.intent ?? null },
    }));
  const answer = async (method: string, params: any, script: Overview | Error | 'hang' | undefined, wrap: (items: any[]) => any[]) => {
    calls.push({ method, params });
    if (script === 'hang') return new Promise<never>(() => {});
    if (script instanceof Error) throw script;
    return ok(wrap(toItems(script ?? [])));
  };
  const client: DataForSeoClient = {
    keywordOverview: (p) => answer('keywordOverview', p, opts.overview, (items) => [{ items }]),
    relatedKeywords: (p) => answer('relatedKeywords', p, opts.related, (items) => [{ items: items.map((keyword_data) => ({ keyword_data })) }]),
    searchIntent: async (p) => {
      calls.push({ method: 'searchIntent', params: p });
      return ok([]);
    },
  };
  return { client, calls };
}

function make(clientOpts?: Parameters<typeof fakeClient>[0], extra: { client?: null } = {}) {
  const { client, calls } = fakeClient(clientOpts);
  const cache = createMemoryKeywordDataCache(() => AT);
  const logs: string[] = [];
  const service = createKeywordDataService({
    client: extra.client === null ? null : client,
    cache,
    now: () => AT,
    log: (l) => logs.push(l),
  });
  return { service, cache, calls, logs };
}

describe('getMetrics', () => {
  test('normalises, de-duplicates, batches the misses into one call and answers in request order', async () => {
    const { service, calls } = make({ overview: [{ keyword: 'water heater', volume: 2400, kd: 18, intent: 'commercial' }, { keyword: 'boiler', volume: 100 }] });
    const r = await service.getMetrics([' Water  Heater ', 'boiler', 'water heater', 'unknown thing']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'keywordOverview');
    assert.deepEqual(calls[0].params, { keywords: ['water heater', 'boiler', 'unknown thing'], location_code: 2840, language_code: 'en' });
    assert.deepEqual(r.items.map((i) => i.keyword), ['water heater', 'boiler', 'unknown thing']);
    assert.deepEqual(r.items[0], { keyword: 'water heater', search_volume: 2400, keyword_difficulty: 18, intent: 'commercial', scope: 'national', fetched_at: AT.toISOString() });
    assert.deepEqual(r.items[2], { keyword: 'unknown thing', search_volume: null, keyword_difficulty: null, intent: null, scope: 'national', fetched_at: AT.toISOString() });
    assert.equal(r.cached_count, 0);
    assert.equal(r.cost_usd, 0.01);
  });

  test('a fully cached request makes no DataForSEO call and costs nothing', async () => {
    const { service, calls } = make({ overview: [{ keyword: 'a', volume: 1 }] });
    await service.getMetrics(['a']);
    const second = await service.getMetrics(['A ']);
    assert.equal(calls.length, 1);
    assert.equal(second.cached_count, 1);
    assert.equal(second.cost_usd, 0);
    assert.equal(second.items[0].search_volume, 1);
  });

  test('a partly cached request fetches only the misses and reports the hit count', async () => {
    const { service, calls, cache } = make({ overview: [{ keyword: 'b', volume: 2 }] });
    await cache.putMetrics([{ keyword: 'a', search_volume: 9, keyword_difficulty: null, intent: null, scope: 'national', fetched_at: AT.toISOString() }], 2840, 'en');
    const r = await service.getMetrics(['a', 'b']);
    assert.deepEqual(calls[0].params.keywords, ['b']);
    assert.equal(r.cached_count, 1);
    assert.deepEqual(r.items.map((i) => [i.keyword, i.search_volume]), [['a', 9], ['b', 2]]);
    assert.equal((await cache.getMetrics(['b'], 2840, 'en')).size, 1, 'the fetched item was cached');
  });

  test('an unknown keyword is cached as all-null so it is paid for once', async () => {
    const { service, calls } = make({ overview: [] });
    await service.getMetrics(['nothing here']);
    await service.getMetrics(['nothing here']);
    assert.equal(calls.length, 1);
  });

  test('location and language are passed through; defaults are 2840 / en', async () => {
    const { service, calls } = make({ overview: [] });
    await service.getMetrics(['a'], 2826, 'EN');
    assert.equal(calls[0].params.location_code, 2826);
    assert.equal(calls[0].params.language_code, 'en');
  });

  test('without credentials: hits still answer, misses throw KeywordDataNotConfiguredError', async () => {
    const { service, cache } = make(undefined, { client: null });
    assert.equal(service.configured, false);
    await assert.rejects(service.getMetrics(['a']), KeywordDataNotConfiguredError);
    await cache.putMetrics([{ keyword: 'a', search_volume: 1, keyword_difficulty: null, intent: null, scope: 'national', fetched_at: AT.toISOString() }], 2840, 'en');
    const r = await service.getMetrics(['a']);
    assert.equal(r.cached_count, 1);
  });

  test('empty input is an empty answer with no call', async () => {
    const { service, calls } = make();
    assert.deepEqual(await service.getMetrics(['', '  ']), { items: [], cached_count: 0, cost_usd: 0 });
    assert.equal(calls.length, 0);
  });
});

describe('getSeedWithRelated', () => {
  test('fetches seed metrics and related keywords in parallel, caches both, and reports ready', async () => {
    const { service, calls, cache } = make({
      overview: [{ keyword: 'water heater repair cost', volume: 2400, kd: 18, intent: 'commercial' }],
      related: [{ keyword: 'water heater replacement cost', volume: 1900 }, { keyword: 'water heater repair cost', volume: 2400 }],
    });
    const r = await service.getSeedWithRelated('Water Heater Repair Cost');
    assert.equal(r.status, 'ready');
    assert.equal(r.source, 'dataforseo');
    assert.equal(r.seed?.search_volume, 2400);
    assert.equal(r.related.length, 2);
    assert.equal(r.cost_usd, 0.02);
    assert.deepEqual(calls.map((c) => c.method).sort(), ['keywordOverview', 'relatedKeywords']);
    assert.equal(calls.find((c) => c.method === 'relatedKeywords')?.params.limit, 30);
    // Both facets cached, and the related items are also metrics hits now.
    assert.ok(await cache.getRelated('water heater repair cost', 2840, 'en'));
    assert.equal((await cache.getMetrics(['water heater replacement cost'], 2840, 'en')).size, 1);
  });

  test('a second call is served from the cache with no DataForSEO call', async () => {
    const { service, calls } = make({ overview: [{ keyword: 'a', volume: 1 }], related: [{ keyword: 'b', volume: 2 }] });
    await service.getSeedWithRelated('a');
    const r = await service.getSeedWithRelated('a');
    assert.equal(r.status, 'ready');
    assert.equal(r.source, 'cache');
    assert.equal(r.cost_usd, 0);
    assert.equal(calls.length, 2);
  });

  test('an unknown seed is still ready, with an all-null seed item', async () => {
    const { service } = make({ overview: [], related: [] });
    const r = await service.getSeedWithRelated('zzz');
    assert.equal(r.status, 'ready');
    assert.equal(r.seed?.search_volume, null);
    assert.deepEqual(r.related, []);
  });

  test('a DataForSEO failure is unavailable with the error kind as reason, and is logged', async () => {
    const { service, logs } = make({
      overview: new DataForSeoError({ kind: 'payment', level: 'task', endpoint: 'keyword_overview', message: 'Insufficient money.' }),
      related: [],
    });
    const r = await service.getSeedWithRelated('a');
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'payment');
    assert.equal(r.seed, null);
    assert.match(logs.join('\n'), /\[keyword-data\] fallback step=fetch seed="a" reason=payment/);
  });

  test('the budget bounds the whole lookup; a hanging call is unavailable with reason=budget', async () => {
    const { service, logs } = make({ overview: 'hang', related: 'hang' });
    const started = Date.now();
    const r = await service.getSeedWithRelated('a', 2840, 'en', { budgetMs: 25 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'budget');
    assert.match(logs.join('\n'), /reason=budget/);
  });

  test('a late answer still fills the cache for the next request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client } = fakeClient({ overview: [{ keyword: 'a', volume: 7 }], related: [{ keyword: 'b', volume: 3 }] });
    const slow: DataForSeoClient = {
      ...client,
      keywordOverview: async (p) => {
        await gate;
        return client.keywordOverview(p);
      },
    };
    const cache = createMemoryKeywordDataCache(() => AT);
    const logs: string[] = [];
    const service = createKeywordDataService({ client: slow, cache, now: () => new Date(), log: (l) => logs.push(l) });
    // 150 ms: long enough that the instant cache step cannot be the thing that times out under load.
    const first = await service.getSeedWithRelated('a', 2840, 'en', { budgetMs: 150 });
    assert.equal(first.status, 'unavailable');
    release();
    // The background fetch lands on its own schedule; wait for it rather than for a fixed delay.
    const deadline = Date.now() + 2000;
    while ((await cache.getMetrics(['a'], 2840, 'en')).size === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal((await cache.getMetrics(['a'], 2840, 'en')).get('a')?.search_volume, 7);
    const second = await service.getSeedWithRelated('a', 2840, 'en', { budgetMs: 150 });
    assert.equal(second.status, 'ready');
    assert.equal(second.source, 'cache');
    assert.match(logs.join('\n'), /late fetch cached seed="a"/);
  });

  test('without credentials a cold seed is unavailable with reason=not_configured', async () => {
    const { service } = make(undefined, { client: null });
    const r = await service.getSeedWithRelated('a');
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'not_configured');
  });
});

describe('tryGetForPrompt', () => {
  test('returns the rendered block with the step limit applied', async () => {
    const related = Array.from({ length: 20 }, (_, i) => ({ keyword: `kw ${i}`, volume: 100 - i }));
    const { service } = make({ overview: [{ keyword: 'seed', volume: 500, kd: 10, intent: 'informational' }], related });
    const r = await service.tryGetForPrompt('Seed', 2840, 'en', 10);
    assert.ok(r);
    assert.equal(r.related.length, 10);
    assert.match(r.block, /^<keyword_data scope="national" location="United States">\nseed: seed \| volume 500 \| difficulty 10 \| intent informational\nrelated:\n- kw 0 \| volume 100\n/);
    assert.equal(r.block.split('\n').filter((l) => l.startsWith('- ')).length, 10);
  });

  test('returns null and logs the fallback when data is unavailable or empty', async () => {
    const down = make({ overview: new DataForSeoError({ kind: 'server', level: 'http', endpoint: 'keyword_overview', message: 'HTTP 503' }), related: [] });
    assert.equal(await down.service.tryGetForPrompt('a', 2840, 'en', 10), null);
    assert.match(down.logs.join('\n'), /fallback step=prompt seed="a" reason=server/);

    const empty = make({ overview: [], related: [] });
    assert.equal(await empty.service.tryGetForPrompt('a', 2840, 'en', 10), null);
    assert.match(empty.logs.join('\n'), /reason=no_data/);
  });

  test('never throws, even when the client throws something unexpected', async () => {
    const { service, logs } = make({ overview: new Error('boom'), related: [] });
    assert.equal(await service.tryGetForPrompt('a', 2840, 'en', 10), null);
    assert.match(logs.join('\n'), /reason=error/);
  });
});

describe('withBudget', () => {
  test('resolves a fast promise and rejects a slow one with KeywordDataBudgetError', async () => {
    assert.equal(await withBudget(Promise.resolve(1), 50), 1);
    await assert.rejects(withBudget(new Promise(() => {}), 10), KeywordDataBudgetError);
  });
});
