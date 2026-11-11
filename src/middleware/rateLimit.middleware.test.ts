/**
 * The per-user limiter, exercised with plain request/response doubles.
 *
 * The one new fact being pinned: buckets are shared across limiter instances and keyed by user
 * id, so a second per-user limiter MUST pass `keyPrefix` or it counts /auxiliary's calls as its
 * own. The default (no prefix) stays exactly as before.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitPerUser, __resetRateLimitBuckets } from './rateLimit.middleware.js';

function call(mw: ReturnType<typeof rateLimitPerUser>, userId: number | undefined) {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  let nexted = false;
  mw({ user: userId ? { id: userId } : undefined } as any, res, () => { nexted = true; });
  return { nexted, res };
}

describe('rateLimitPerUser', () => {
  beforeEach(() => __resetRateLimitBuckets());

  test('allows `limit` calls per window, then answers 429 with Retry-After', () => {
    const mw = rateLimitPerUser({ limit: 2, windowMs: 60_000, message: 'slow down' });
    assert.equal(call(mw, 1).nexted, true);
    assert.equal(call(mw, 1).nexted, true);
    const third = call(mw, 1);
    assert.equal(third.nexted, false);
    assert.equal(third.res.statusCode, 429);
    assert.equal(third.res.body.error, 'slow down');
    assert.ok(Number(third.res.headers['Retry-After']) >= 1);
    assert.ok(third.res.body.retry_after_seconds >= 1);
  });

  test('buckets are per user', () => {
    const mw = rateLimitPerUser({ limit: 1, windowMs: 60_000 });
    assert.equal(call(mw, 1).nexted, true);
    assert.equal(call(mw, 2).nexted, true);
    assert.equal(call(mw, 1).nexted, false);
  });

  test('an unauthenticated request passes through unbucketed', () => {
    const mw = rateLimitPerUser({ limit: 1, windowMs: 60_000 });
    assert.equal(call(mw, undefined).nexted, true);
    assert.equal(call(mw, undefined).nexted, true);
  });

  test('two limiters WITHOUT a prefix share one bucket per user (the pre-existing behaviour)', () => {
    const a = rateLimitPerUser({ limit: 2, windowMs: 60_000 });
    const b = rateLimitPerUser({ limit: 2, windowMs: 60_000 });
    call(a, 1);
    call(b, 1);
    assert.equal(call(a, 1).nexted, false, 'b consumed a\'s bucket');
  });

  test('a keyPrefix gives a limiter its own buckets, so routes do not count each other', () => {
    const aux = rateLimitPerUser({ limit: 2, windowMs: 60_000 });
    const metrics = rateLimitPerUser({ limit: 2, windowMs: 60_000, keyPrefix: 'keyword-metrics' });
    call(aux, 1);
    call(aux, 1);
    assert.equal(call(aux, 1).nexted, false);
    assert.equal(call(metrics, 1).nexted, true, 'aux calls must not count against metrics');
    assert.equal(call(metrics, 1).nexted, true);
    assert.equal(call(metrics, 1).nexted, false);
  });
});
