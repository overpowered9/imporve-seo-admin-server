import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCostLedger,
  formatModelCallLog,
  promptVersionLabel,
  runModelCall,
  withTimeout,
  ModelCallTimeoutError,
  type ProviderCall,
} from './model-call.js';
import { modelCostUsd, modelPrices } from './model-pricing.js';
import { StepFailedError } from './content-v3-steps/attempts.js';

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };

function scripted(answers: Array<string | Error | 'hang'>): { call: ProviderCall; seen: number } {
  const state = { call: undefined as unknown as ProviderCall, seen: 0 };
  state.call = async ({ signal }) => {
    const a = answers[Math.min(state.seen, answers.length - 1)];
    state.seen++;
    if (a === 'hang') {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (a instanceof Error) throw a;
    return { text: a as string, usage: USAGE, stop_reason: 'end_turn' };
  };
  return state;
}

describe('model pricing', () => {
  test('known model: input, output, cache read and cache write are all billed', () => {
    // sonnet-5: 1000*2 + 200*10 + 5000*0.2 = 5000 → $0.005
    assert.equal(modelCostUsd('claude-sonnet-5', USAGE, {}), 0.005);
  });

  test('unknown model costs null, never a guess', () => {
    assert.equal(modelCostUsd('some-new-model', USAGE, {}), null);
  });

  test('MODEL_PRICES_JSON overrides and adds; a malformed value keeps the defaults', () => {
    const env = { MODEL_PRICES_JSON: '{"x-model":{"input":1,"output":1,"cache_write":1,"cache_read":1},"bad":{"input":"1"}}' };
    assert.ok(modelPrices(env)['x-model']);
    assert.equal(modelPrices(env)['bad'], undefined);
    assert.ok(modelPrices({ MODEL_PRICES_JSON: '{not json' })['claude-sonnet-5']);
  });
});

describe('runModelCall', () => {
  test('happy path: one structured log line with tokens, cache, cost, prompt version; no content', async () => {
    const logs: string[] = [];
    const s = scripted(['{"ok":true}']);
    const r = await runModelCall({
      step: 'title',
      model: 'claude-sonnet-5',
      promptVersion: 'content_v3_title@v3#abcdef12',
      system: 'SYSTEM SECRET TEXT',
      user: 'USER CONTENT seed keyword',
      maxTokens: 100,
      timeoutMs: 1000,
      parse: (t) => JSON.parse(t) as { ok: boolean },
      call: s.call,
      log: (l) => logs.push(l),
      runId: 'iseo_tk_test',
      env: {},
    });
    assert.deepEqual(r.value, { ok: true });
    assert.equal(r.cost_usd, 0.005);
    assert.equal(logs.length, 1);
    assert.match(
      logs[0],
      /^\[model-call\] step=title model=claude-sonnet-5 prompt=content_v3_title@v3#abcdef12 attempt=1\/3 outcome=ok in=1000 out=200 cache_read=5000 cache_write=0 cost_usd=0\.005000 ms=\d+ run=iseo_tk_test$/,
    );
    assert.doesNotMatch(logs.join('\n'), /SECRET|USER CONTENT|seed keyword/);
  });

  test('unreadable then invalid then ok: three attempts logged, cost summed over all three', async () => {
    const logs: string[] = [];
    const s = scripted(['not json', '{"n":0}', '{"n":2}']);
    const r = await runModelCall({
      step: 'planner',
      model: 'claude-sonnet-5',
      promptVersion: 'p@code#00000000',
      system: 's',
      user: 'u',
      maxTokens: 100,
      timeoutMs: 1000,
      parse: (t) => JSON.parse(t) as { n: number },
      validate: (v) => (v.n > 0 ? null : 'n_not_positive'),
      call: s.call,
      log: (l) => logs.push(l),
      env: {},
    });
    assert.equal(r.value.n, 2);
    assert.equal(r.attempts.length, 3);
    assert.equal(r.cost_usd, 0.015);
    assert.match(logs[0], /attempt=1\/3 outcome=rejected .* reason="unreadable_json/);
    assert.match(logs[1], /attempt=2\/3 outcome=rejected .* reason="n_not_positive"/);
    assert.match(logs[2], /attempt=3\/3 outcome=ok/);
  });

  test('a hanging provider is aborted at the timeout and counts as a failed attempt', async () => {
    const logs: string[] = [];
    const s = scripted(['hang', '{"ok":1}']);
    const r = await runModelCall({
      step: 'writer',
      model: 'claude-sonnet-5',
      promptVersion: 'w@code#00000000',
      system: 's',
      user: 'u',
      maxTokens: 100,
      timeoutMs: 30,
      parse: (t) => JSON.parse(t),
      call: s.call,
      log: (l) => logs.push(l),
      env: {},
    });
    assert.deepEqual(r.value, { ok: 1 });
    assert.match(logs[0], /outcome=timeout .*cost_usd=0\.000000/);
  });

  test('three failures throw StepFailedError and log three lines', async () => {
    const logs: string[] = [];
    const s = scripted([new Error('overloaded')]);
    await assert.rejects(
      runModelCall({
        step: 'title',
        model: 'claude-sonnet-5',
        promptVersion: 't@code#00000000',
        system: 's',
        user: 'u',
        maxTokens: 100,
        timeoutMs: 1000,
        parse: (t) => t,
        call: s.call,
        log: (l) => logs.push(l),
        env: {},
      }),
      (err: unknown) => err instanceof StepFailedError && err.attempts.length === 3,
    );
    assert.equal(logs.length, 3);
    assert.ok(logs.every((l) => /outcome=call_failed/.test(l)));
  });

  test('a provider-reported cost (Perplexity) is used instead of the price table', async () => {
    const logs: string[] = [];
    const r = await runModelCall({
      step: 'research',
      model: 'sonar-x',
      promptVersion: 'r@code#00000000',
      system: 's',
      user: 'u',
      maxTokens: 100,
      timeoutMs: 1000,
      parse: (t) => t,
      call: async () => ({ text: 'x', usage: USAGE, cost_usd: 0.0125 }),
      log: (l) => logs.push(l),
      env: {},
    });
    assert.equal(r.cost_usd, 0.0125);
    assert.match(logs[0], /cost_usd=0\.012500/);
  });
});

describe('helpers', () => {
  test('withTimeout rejects with ModelCallTimeoutError and aborts the signal', async () => {
    let aborted = false;
    await assert.rejects(
      withTimeout(20, (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(resolve, 200);
        }),
      ),
      ModelCallTimeoutError,
    );
    assert.equal(aborted, true);
  });

  test('promptVersionLabel pins the exact text by hash', () => {
    const a = promptVersionLabel({ templateType: 'content_v3_title', source: 'db', dbVersion: 4, text: 'abc' });
    const b = promptVersionLabel({ templateType: 'content_v3_title', source: 'fallback', text: 'abc' });
    assert.equal(a, 'content_v3_title@v4#ba7816bf');
    assert.equal(b, 'content_v3_title@code#ba7816bf');
  });

  test('formatModelCallLog quotes and truncates the reason', () => {
    const line = formatModelCallLog({
      step: 's',
      model: 'm',
      prompt: 'p',
      attempt: 1,
      max_attempts: 3,
      outcome: 'rejected',
      reason: 'x'.repeat(500),
      usage: null,
      cost_usd: null,
      ms: 5,
    });
    assert.match(line, /cost_usd=null ms=5 reason="x{160}"$/);
  });

  test('cost ledger sums per step and in total; one unknown cost makes the total null', () => {
    const l = createCostLedger();
    l.add('title', 0.002, USAGE);
    l.add('title', 0.001, USAGE);
    l.add('writer', 0.04, [USAGE, USAGE]);
    assert.equal(l.total(), 0.043);
    assert.equal(l.steps().writer.cache_read, 10000);
    assert.match(l.line('run1'), /^\[content-v3\] cost run=run1 title=0\.0030 writer=0\.0400 total=0\.0430$/);
    l.add('research', null);
    assert.equal(l.total(), null);
  });
});
