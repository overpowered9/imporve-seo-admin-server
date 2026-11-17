/**
 * The Keyword Finder admin API over HTTP, with fake services. No network, no credentials.
 *
 * What is being protected:
 *  1. Admin only, on both endpoints, before anything is spent.
 *  2. A server without DataForSEO credentials says so plainly instead of failing obscurely.
 *  3. The country code is resolved server-side, never taken from the request.
 *  4. Provider failures map to the same stable codes the metrics route already uses.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestHandler } from 'express';
import { startTestApp, type TestApp } from '../test/helpers/http-app.js';
import { createKeywordFinderRouter, type DiscoverCall } from './keyword-finder.handler.js';
import { DataForSeoError } from '../services/keyword-data/dataforseo.client.js';
import type { GeoService, GeoStep } from '../services/keyword-data/keyword-geo.service.js';
import type { FinderResult } from '../services/keyword-data/keyword-finder.service.js';

const admin: RequestHandler = (req, res, next) =>
  req.header('authorization') === 'Bearer admin' ? next() : res.status(401).json({ success: false });

const AUSTIN: GeoStep = {
  location_code: 1026201,
  location_name: 'Austin,Texas,United States',
  location_type: 'City',
  parent_code: 21176,
  depth: 0,
};

let app: TestApp | null = null;
afterEach(async () => {
  const a = app;
  app = null;
  await a?.close();
});

function emptyResult(over: Partial<FinderResult> = {}): FinderResult {
  return {
    seed: 'leather wallets',
    mode: 'list',
    items: [],
    level_used: null,
    country_location_code: 2840,
    notice: null,
    geo_ladder: [],
    keywords_without_data: 0,
    cost_usd: 0.03,
    rules: {} as FinderResult['rules'],
    ...over,
  };
}

function build(
  opts: {
    configured?: boolean;
    discover?: (p: DiscoverCall) => Promise<FinderResult>;
    countryCode?: () => Promise<number>;
    search?: () => Promise<GeoStep[]>;
  } = {},
) {
  const calls: DiscoverCall[] = [];
  const geo = {
    async searchLocations() {
      return opts.search ? opts.search() : [AUSTIN];
    },
    async countryLocationCode() {
      return opts.countryCode ? opts.countryCode() : 2840;
    },
    async resolveLadder() {
      return [AUSTIN];
    },
    async localVolumes() {
      throw new Error('not used');
    },
  } as unknown as GeoService;

  const router = createKeywordFinderRouter({
    auth: admin,
    configured: () => opts.configured ?? true,
    geo: () => geo,
    finder: () => ({
      discover: async (p: DiscoverCall) => {
        calls.push(p);
        return opts.discover ? opts.discover(p) : emptyResult();
      },
    }),
    log: () => {},
  });
  return { router, calls };
}

describe('auth and configuration', () => {
  test('both endpoints are admin only', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    assert.equal((await app.post('/api/v1/keyword-finder/discover', { seed: 'x' })).status, 401);
    assert.equal((await app.get('/api/v1/keyword-finder/locations?q=austin')).status, 401);
  });

  test('a server without credentials says so rather than failing obscurely', async () => {
    const { router, calls } = build({ configured: false });
    app = await startTestApp([['/api/v1/keyword-finder', router]]);

    const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x' }, { Authorization: 'Bearer admin' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'KEYWORD_DATA_NOT_CONFIGURED');
    assert.equal(calls.length, 0, 'nothing is attempted without credentials');
  });
});

describe('POST /discover', () => {
  test('resolves the country code server-side and passes the request through', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);

    const r = await app.post(
      '/api/v1/keyword-finder/discover',
      { seed: '  Leather Wallets ', country_iso: 'US', location_code: 1026201, mode: 'recommend' },
      { Authorization: 'Bearer admin' },
    );

    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(calls[0].country_location_code, 2840, 'resolved, not taken from the body');
    assert.equal(calls[0].country_iso, 'us');
    assert.equal(calls[0].seed, 'Leather Wallets', 'trimmed');
    assert.equal(calls[0].location_code, 1026201);
    assert.equal(calls[0].mode, 'recommend');
    assert.equal(calls[0].language_code, 'en');
  });

  test('defaults to a national list when no location is given', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    await app.post('/api/v1/keyword-finder/discover', { seed: 'x' }, { Authorization: 'Bearer admin' });
    assert.equal(calls[0].location_code, undefined);
    assert.equal(calls[0].mode, 'list');
    assert.equal(calls[0].country_iso, 'us');
  });

  test('rejects a bad request before spending anything', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const h = { Authorization: 'Bearer admin' };

    for (const body of [
      {},
      { seed: '   ' },
      { seed: 'x', country_iso: 'usa' },
      { seed: 'x', mode: 'bulk' },
      { seed: 'x', limit: 0 },
      { seed: 'x', limit: 5000 },
      { seed: 'x', location_code: -2 },
    ]) {
      const r = await app.post('/api/v1/keyword-finder/discover', body, h);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'VALIDATION_ERROR');
    }
    assert.equal(calls.length, 0);
  });

  test('an unusable location code is a 400 that names itself, not a 500', async () => {
    const { router } = build({
      countryCode: async () => {
        throw new Error('no country row for "zz" in the Google Ads location list');
      },
    });
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x', country_iso: 'zz' }, { Authorization: 'Bearer admin' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no country row/);
  });

  test('provider failures map to the shared stable codes', async () => {
    const { router } = build({
      discover: async () => {
        throw new DataForSeoError({ kind: 'timeout', level: 'transport', endpoint: 'related_keywords', message: 'slow', retryable: false });
      },
    });
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x' }, { Authorization: 'Bearer admin' });
    assert.equal(r.status, 504);
    assert.equal(r.body.code, 'KEYWORD_DATA_TIMEOUT');
  });

  test('an unexpected failure does not leak its message to the client', async () => {
    const { router } = build({
      discover: async () => {
        throw new Error('postgres://user:secret@host blew up');
      },
    });
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x' }, { Authorization: 'Bearer admin' });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'KEYWORD_FINDER_ERROR');
    assert.ok(!/secret/.test(JSON.stringify(r.body)));
  });

  test('the result is returned flat beside success, as the panel reads it', async () => {
    const { router } = build({
      discover: async () => emptyResult({ notice: 'Not enough search data for Austin, Texas.', keywords_without_data: 2 }),
    });
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x' }, { Authorization: 'Bearer admin' });
    assert.equal(r.body.notice, 'Not enough search data for Austin, Texas.');
    assert.equal(r.body.keywords_without_data, 2);
    assert.ok(Array.isArray(r.body.items));
  });
});

describe('GET /locations', () => {
  test('returns matches for a query', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const r = await app.get('/api/v1/keyword-finder/locations?country=us&q=austin', { Authorization: 'Bearer admin' });
    assert.equal(r.status, 200);
    assert.equal(r.body.locations[0].location_code, 1026201);
  });

  test('requires a query rather than returning a whole country', async () => {
    const { router } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const r = await app.get('/api/v1/keyword-finder/locations?country=us', { Authorization: 'Bearer admin' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_ERROR');
  });
});

describe('limit', () => {
  test('both modes accept 1 to 100 and refuse anything outside it', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const h = { Authorization: 'Bearer admin' };

    for (const mode of ['list', 'recommend'] as const) {
      for (const limit of [1, 50, 100]) {
        const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x', mode, limit }, h);
        assert.equal(r.status, 200, `${mode} ${limit}`);
        assert.equal(calls[calls.length - 1].limit, limit);
        assert.equal(calls[calls.length - 1].mode, mode);
      }
      for (const limit of [0, -1, 101, 1000]) {
        const r = await app.post('/api/v1/keyword-finder/discover', { seed: 'x', mode, limit }, h);
        assert.equal(r.status, 400, `${mode} ${limit}`);
        assert.equal(r.body.code, 'VALIDATION_ERROR');
      }
    }
  });

  test('omitting it falls back to the mode default', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    await app.post('/api/v1/keyword-finder/discover', { seed: 'x', mode: 'list' }, { Authorization: 'Bearer admin' });
    assert.equal(calls[0].limit, undefined, 'the service applies the mode default, not the route');
  });
});

describe('serp_check', () => {
  test('defaults to off, so a search never spends SERP money by accident', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    await app.post('/api/v1/keyword-finder/discover', { seed: 'x' }, { Authorization: 'Bearer admin' });
    assert.equal(calls[0].serp_check, 'off');
  });

  test('passes through when asked for, and refuses anything else', async () => {
    const { router, calls } = build();
    app = await startTestApp([['/api/v1/keyword-finder', router]]);
    const h = { Authorization: 'Bearer admin' };

    const ok = await app.post('/api/v1/keyword-finder/discover', { seed: 'x', serp_check: 'top' }, h);
    assert.equal(ok.status, 200);
    assert.equal(calls[0].serp_check, 'top');

    const bad = await app.post('/api/v1/keyword-finder/discover', { seed: 'x', serp_check: 'yes' }, h);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VALIDATION_ERROR');
  });
});
