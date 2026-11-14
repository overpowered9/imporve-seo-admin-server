import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableCallError, retryDelayMs, runWithAttempts, StepFailedError, defaultBackoff } from './attempts.js';

const usage = { input_tokens: 1, output_tokens: 1 } as never;
const fail = (status?: number, headers?: Record<string, string>) => Object.assign(new Error(`status ${status ?? 'none'}`), status ? { status } : {}, headers ? { headers } : {});

test('B-6: retries after a failed call wait exponentially (with jitter); a bad answer is retried at once', async () => {
  const waits: number[] = [];
  let n = 0;
  const r = await runWithAttempts<string>({
    step: 'title',
    call: async () => {
      n++;
      if (n <= 2) throw fail(529);
      if (n === 3) return { text: 'not json', usage };
      return { text: 'ok', usage };
    },
    parse: (t) => {
      if (t !== 'ok') throw new Error('bad');
      return t;
    },
    validate: () => null,
    maxAttempts: 4,
    log: () => {},
    backoff: { baseMs: 1000, maxMs: 8000 },
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 0.5, // jitter factor 1.0
  });
  assert.equal(r.value, 'ok');
  assert.deepEqual(waits, [1000, 2000], 'two waits after the two failed calls; none after the unreadable answer');
});

test('B-6: Retry-After wins; other 4xx are not retried; timeouts, 408/409/429/5xx are', async () => {
  assert.equal(retryDelayMs(fail(429, { 'retry-after': '3' }), 1, { baseMs: 1000, maxMs: 8000 }), 3000);
  assert.equal(retryDelayMs(fail(429), 3, { baseMs: 1000, maxMs: 8000 }, () => 0.5), 4000);
  assert.equal(retryDelayMs(fail(500), 9, { baseMs: 1000, maxMs: 8000 }, () => 0.5), 8000, 'capped');
  assert.equal(retryDelayMs(fail(500), 1, { baseMs: 0, maxMs: 0 }), 0, 'base 0 turns waiting off');
  for (const s of [408, 409, 429, 500, 503, 529]) assert.equal(isRetryableCallError(fail(s)), true, String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.equal(isRetryableCallError(fail(s)), false, String(s));
  assert.equal(isRetryableCallError(new Error('timed out after 60000 ms')), true);
  let calls = 0;
  await assert.rejects(
    runWithAttempts({ step: 'planner', call: async () => { calls++; throw fail(401); }, parse: (t) => t, validate: () => null, log: () => {}, sleep: async () => {} }),
    StepFailedError,
  );
  assert.equal(calls, 1, 'a rejected key is not retried');
});

test('B-3: no attempt starts after the deadline, and no wait runs past it', async () => {
  let t = 0;
  let calls = 0;
  const err = await runWithAttempts({
    step: 'writer',
    call: async () => {
      calls++;
      t += 5_000;
      throw fail(529);
    },
    parse: (x) => x,
    validate: () => null,
    log: () => {},
    now: () => t,
    deadlineAt: 6_000,
    backoff: { baseMs: 2_000, maxMs: 8_000 },
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0.5,
  }).catch((e) => e);
  assert.ok(err instanceof StepFailedError);
  assert.equal(calls, 1, 'the 2 s wait would pass the 6 s deadline, so no second call');
});

test('the default wait reads CONTENT_V3_RETRY_BASE_MS (the test runner sets 0)', () => {
  assert.deepEqual(defaultBackoff({}), { baseMs: 1000, maxMs: 8000 });
  assert.deepEqual(defaultBackoff({ CONTENT_V3_RETRY_BASE_MS: '0' }), { baseMs: 0, maxMs: 0 });
});

test('R7: runModelCall puts the spend of attempts that all failed on the StepFailedError', async () => {
  const { runModelCall } = await import('../model-call.js');
  const { StepFailedError } = await import('./attempts.js');
  let n = 0;
  const err = await runModelCall<{ ok: true }>({
    step: 'planner',
    model: 'claude-sonnet-5',
    promptVersion: 'p',
    system: 's',
    user: 'u',
    maxTokens: 10,
    timeoutMs: 1000,
    maxAttempts: 2,
    call: async () => {
      n++;
      return { text: 'not json', usage: { input_tokens: 1000, output_tokens: 100 }, cost_usd: 0.02 };
    },
    parse: (t) => JSON.parse(t),
    log: () => {},
  }).catch((e) => e);
  assert.ok(err instanceof StepFailedError);
  assert.equal(n, 2);
  assert.equal(err.cost_usd, 0.04);
});

test('L5: Retry-After is read from a fetch Response\'s headers too (Perplexity)', () => {
  const err = Object.assign(new Error('perplexity http 429'), { status: 429, headers: new Headers({ 'retry-after': '7' }) });
  assert.equal(retryDelayMs(err, 1, { baseMs: 1000, maxMs: 30_000 } as any, () => 0.5), 7000);
});
