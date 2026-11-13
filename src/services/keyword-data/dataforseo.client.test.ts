/**
 * DataForSEO client — exercised against an injected fetch, so no network and no credentials.
 *
 * What is being protected:
 *  1. Basic auth from the given login/password, sent on every call and never logged.
 *  2. Only Labs paths are ever requested.
 *  3. The 8 s timeout produces a `timeout` error after ONE attempt (no retry).
 *  4. A 5xx or network failure is retried exactly once, with backoff; a second failure surfaces.
 *  5. Task-level and top-level DataForSEO status codes map to structured kinds.
 *  6. An auth failure is never retried.
 *  7. The per-call log line carries endpoint, latency and cost.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDataForSeoClient,
  DataForSeoError,
  LABS_ENDPOINTS,
  SERP_ENDPOINTS,
  assertAllowedPath,
  assertLabsPath,
  kindForStatusCode,
  kindForHttpStatus,
  type DfsResponse,
} from './dataforseo.client.js';

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okEnvelope<R>(result: R[], cost = 0.0123): DfsResponse<R> {
  return {
    version: '0.1.20240801',
    status_code: 20000,
    status_message: 'Ok.',
    time: '0.1 sec.',
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: 'task-1',
        status_code: 20000,
        status_message: 'Ok.',
        cost,
        result_count: result.length,
        result,
      },
    ],
  };
}

/** A scripted fetch: each entry is either a Response, an Error to reject with, or 'hang' (honours abort). */
function scriptedFetch(script: Array<Response | Error | 'hang'>) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift();
    if (next === undefined) throw new Error('scriptedFetch: no more responses');
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(script: Array<Response | Error | 'hang'>, extra: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = scriptedFetch(script);
  const logs: string[] = [];
  const sleeps: number[] = [];
  const client = createDataForSeoClient({
    login: 'user@example.com',
    password: 'hunter2-secret',
    fetchImpl,
    timeoutMs: 30,
    retryBackoffMs: 5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
    ...extra,
  });
  return { client, calls, logs, sleeps };
}

describe('createDataForSeoClient — success', () => {
  test('posts one task with Basic auth to the Labs keyword_overview path and returns result, cost, latency', async () => {
    const result = [{ items: [{ keyword: 'water heater repair cost', keyword_info: { search_volume: 2400 } }] }];
    const { client, calls, logs } = makeClient([jsonResponse(200, okEnvelope(result, 0.0101))]);

    const r = await client.keywordOverview({ keywords: ['water heater repair cost'], location_code: 2840, language_code: 'en' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.dataforseo.com/v3${LABS_ENDPOINTS.keyword_overview}`);
    assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Basic ${Buffer.from('user@example.com:hunter2-secret').toString('base64')}`);
    const body = JSON.parse(String(calls[0].init.body));
    assert.ok(Array.isArray(body) && body.length === 1, 'DataForSEO takes an array of tasks');
    assert.deepEqual(body[0].keywords, ['water heater repair cost']);
    assert.equal(body[0].location_code, 2840);
    assert.equal(body[0].language_code, 'en');

    assert.deepEqual(r.result, result);
    assert.equal(r.cost, 0.0101);
    assert.equal(r.attempts, 1);
    assert.equal(r.taskId, 'task-1');
    assert.ok(Number.isFinite(r.latencyMs));
  });

  test('logs endpoint, latency and cost — and never the credentials', async () => {
    const { client, logs } = makeClient([jsonResponse(200, okEnvelope([], 0.05))]);
    await client.searchIntent({ keywords: ['x'], language_code: 'en' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[dataforseo\] endpoint=search_intent http=200 status=20000 latency_ms=\d+ cost=0\.05/);
    assert.doesNotMatch(logs.join('\n'), /hunter2|user@example|Basic /);
  });

  test('relatedKeywords sends the seed, a depth and a limit, ordered by volume', async () => {
    const { client, calls } = makeClient([jsonResponse(200, okEnvelope([]))]);
    await client.relatedKeywords({ keyword: 'Water Heater Repair', location_code: 2840, language_code: 'en', limit: 30 });
    assert.equal(calls[0].url, `https://api.dataforseo.com/v3${LABS_ENDPOINTS.related_keywords}`);
    const body = JSON.parse(String(calls[0].init.body))[0];
    assert.equal(body.keyword, 'Water Heater Repair');
    assert.equal(body.limit, 30);
    assert.equal(body.depth, 2);
    assert.deepEqual(body.order_by, ['keyword_data.keyword_info.search_volume,desc']);
  });
});

describe('createDataForSeoClient — timeout', () => {
  test('aborts after timeoutMs, reports kind=timeout and does NOT retry', async () => {
    const { client, calls, sleeps } = makeClient(['hang']);
    const err = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' }).catch((e) => e);
    assert.ok(err instanceof DataForSeoError);
    assert.equal(err.kind, 'timeout');
    assert.equal(err.level, 'transport');
    assert.equal(err.retryable, false);
    assert.equal(calls.length, 1, 'a timeout is not retried');
    assert.deepEqual(sleeps, []);
  });
});

describe('createDataForSeoClient — retry', () => {
  test('a 5xx is retried once with backoff and the retry result is returned', async () => {
    const { client, calls, sleeps, logs } = makeClient([
      jsonResponse(503, { status_code: 50001, status_message: 'Service Unavailable.' }),
      jsonResponse(200, okEnvelope([{ items: [] }])),
    ]);
    const r = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [5]);
    assert.equal(r.attempts, 2);
    assert.match(logs[0], /error kind=server level=http http=503 status=50001 .*retry=yes/);
  });

  test('a network error is retried once', async () => {
    const { client, calls } = makeClient([
      Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }),
      jsonResponse(200, okEnvelope([])),
    ]);
    const r = await client.searchIntent({ keywords: ['x'], language_code: 'en' });
    assert.equal(calls.length, 2);
    assert.equal(r.attempts, 2);
  });

  test('two server failures surface as kind=server after exactly two attempts', async () => {
    const { client, calls } = makeClient([
      jsonResponse(500, { status_code: 50000, status_message: 'Internal Error.' }),
      jsonResponse(502, {}),
    ]);
    const err = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' }).catch((e) => e);
    assert.ok(err instanceof DataForSeoError);
    assert.equal(err.kind, 'server');
    assert.equal(err.httpStatus, 502);
    assert.equal(calls.length, 2);
  });

  test('a DataForSEO 5xxxx task status inside a 200 is retried like a 5xx', async () => {
    const bad = okEnvelope([]);
    bad.tasks![0].status_code = 50401;
    bad.tasks![0].status_message = 'Timeout.';
    const { client, calls } = makeClient([jsonResponse(200, bad), jsonResponse(200, okEnvelope([]))]);
    const r = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' });
    assert.equal(calls.length, 2);
    assert.equal(r.attempts, 2);
  });
});

describe('createDataForSeoClient — structured errors', () => {
  test('a task-level 4xxxx maps to bad_request at level=task and is not retried', async () => {
    const bad = okEnvelope([]);
    bad.tasks![0].status_code = 40501;
    bad.tasks![0].status_message = 'Invalid Field: language_code.';
    const { client, calls } = makeClient([jsonResponse(200, bad)]);
    const err = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'zz' }).catch((e) => e);
    assert.ok(err instanceof DataForSeoError);
    assert.equal(err.kind, 'bad_request');
    assert.equal(err.level, 'task');
    assert.equal(err.statusCode, 40501);
    assert.match(err.message, /Invalid Field/);
    assert.equal(calls.length, 1);
  });

  test('a task-level payment code maps to payment', async () => {
    const bad = okEnvelope([]);
    bad.tasks![0].status_code = 40201;
    bad.tasks![0].status_message = 'Insufficient money.';
    const { client } = makeClient([jsonResponse(200, bad)]);
    const err = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' }).catch((e) => e);
    assert.equal(err.kind, 'payment');
    assert.equal(err.retryable, false);
  });

  test('a top-level 40006 maps to rate_limit at level=response', async () => {
    const { client } = makeClient([jsonResponse(200, { status_code: 40006, status_message: 'Too many requests.', tasks: [] })]);
    const err = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' }).catch((e) => e);
    assert.equal(err.kind, 'rate_limit');
    assert.equal(err.level, 'response');
  });

  test('HTTP 401 is an auth error, never retried, and the message holds no credential', async () => {
    const { client, calls, logs } = makeClient([jsonResponse(401, { status_code: 40100, status_message: 'Not Authorized.' })]);
    const err = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' }).catch((e) => e);
    assert.ok(err instanceof DataForSeoError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.httpStatus, 401);
    assert.equal(err.statusCode, 40100);
    assert.equal(err.retryable, false);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(`${err.message}\n${logs.join('\n')}`, /hunter2|Basic /);
  });

  test('a non-JSON 200 body is a retryable server error', async () => {
    const { client, calls } = makeClient([
      new Response('<html>gateway</html>', { status: 200 }),
      jsonResponse(200, okEnvelope([])),
    ]);
    const r = await client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' });
    assert.equal(calls.length, 2);
    assert.equal(r.attempts, 2);
  });

  test('status code mapping table', () => {
    assert.equal(kindForStatusCode(40100), 'auth');
    assert.equal(kindForStatusCode(40101), 'auth');
    assert.equal(kindForStatusCode(40200), 'payment');
    assert.equal(kindForStatusCode(40201), 'payment');
    assert.equal(kindForStatusCode(40006), 'rate_limit');
    assert.equal(kindForStatusCode(40202), 'rate_limit');
    assert.equal(kindForStatusCode(40001), 'bad_request');
    assert.equal(kindForStatusCode(40400), 'bad_request');
    assert.equal(kindForStatusCode(50000), 'server');
    assert.equal(kindForStatusCode(20100), 'task_error');
    assert.equal(kindForHttpStatus(429), 'rate_limit');
    assert.equal(kindForHttpStatus(402), 'payment');
    assert.equal(kindForHttpStatus(403), 'auth');
    assert.equal(kindForHttpStatus(400), 'bad_request');
    assert.equal(kindForHttpStatus(500), 'server');
  });
});

describe('Labs-only guarantee', () => {
  test('every endpoint the client can call is under /dataforseo_labs/', () => {
    for (const p of Object.values(LABS_ENDPOINTS)) {
      assert.match(p, /^\/dataforseo_labs\/google\//);
      assertLabsPath(p);
    }
    assert.throws(() => assertLabsPath('/keywords_data/google_ads/search_volume/live'), /only Labs endpoints/);
  });

  test('the client source names no Google Ads / Keywords Data path', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'dataforseo.client.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    // Content v3 (search data lookup, approved 14 Nov) deliberately adds the Google SERP organic
    // live/advanced and locations endpoints; the Google Ads / Keywords Data family stays banned.
    // Was: assert.doesNotMatch(code, /keywords_data|google_ads|serp\/google\/organic/);
    assert.doesNotMatch(code, /keywords_data|google_ads/);
  });

  test('SERP access is exactly the two Content v3 paths', () => {
    assert.deepEqual(Object.values(SERP_ENDPOINTS), ['/serp/google/organic/live/advanced', '/serp/google/locations']);
    assertAllowedPath('/serp/google/organic/live/advanced');
    assertAllowedPath('/serp/google/locations/us');
    assertAllowedPath(LABS_ENDPOINTS.keyword_overview);
    for (const bad of ['/keywords_data/google_ads/search_volume/live', '/serp/google/organic/task_post', '/serp/bing/organic/live/advanced', '/serp/google/locations/usa', '/serp/google/locations/us/extra', '/backlinks/summary/live']) {
      assert.throws(() => assertAllowedPath(bad), /not allowed/, bad);
    }
  });

  test('refuses to build without credentials', () => {
    assert.throws(() => createDataForSeoClient({ login: '', password: 'x' }), /login and a password/);
  });
});
