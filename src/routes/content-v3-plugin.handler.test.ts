import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestHandler } from 'express';
import { startTestApp, type TestApp } from '../test/helpers/http-app.js';
import { createContentV3PluginRouter } from './content-v3-plugin.handler.js';
import { createMemoryContentV3Store } from '../services/content-v3/store.js';
import { toV3UserError, v3Error } from '../services/content-v3/user-errors.js';
import { StepFailedError } from '../services/content-v3-steps/attempts.js';

const KEY = 'iseo_tk_0123456789abcdef0123456789abcdef';

// Stand-in for plugin auth: the real middleware sets req.user / req.website from the API key.
const fakeAuth: RequestHandler = (req, res, next) => {
  if (req.header('x-api-key') !== 'good') return res.status(401).json({ success: false });
  (req as any).user = { id: 5 };
  (req as any).website = { id: 9 };
  next();
};

let app: TestApp | null = null;
afterEach(async () => {
  const a = app;
  app = null;
  await a?.close();
});

async function start(env: NodeJS.ProcessEnv, store = createMemoryContentV3Store(), disclaimerKeys?: () => Promise<string[]>) {
  if (app) {
    const prev = app;
    app = null;
    await prev.close();
  }
  app = await startTestApp([['/api/v1/content-v3', createContentV3PluginRouter({ auth: fakeAuth, store: async () => store, env, log: () => {}, disclaimerKeys })]]);
  return { app, store };
}

describe('GET /status', () => {
  test('needs plugin auth', async () => {
    const { app } = await start({});
    assert.equal((await app.get('/api/v1/content-v3/status')).status, 401);
  });

  test('enabled only for the literal "true"; keyword_data needs the flag AND credentials', async () => {
    for (const [env, enabled, kd] of [
      [{}, false, false],
      [{ CONTENT_V3_ENABLED: '1' }, false, false],
      [{ CONTENT_V3_ENABLED: 'true', ISEO_V3_KEYWORD_DATA: 'true' }, true, false],
      [{ CONTENT_V3_ENABLED: 'true', ISEO_V3_KEYWORD_DATA: 'true', DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, true, true],
    ] as const) {
      const { app } = await start(env as NodeJS.ProcessEnv);
      const r = await app.get('/api/v1/content-v3/status', { 'x-api-key': 'good' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true, data: { enabled, keyword_data: kd, disclaimer_niches: [] } });
    }
  });

  test('A3: lists the niches that have a disclaimer text; unreadable settings list none (v2 for Regulated)', async () => {
    const ok = await start({ CONTENT_V3_ENABLED: 'true' }, undefined, async () => ['dental', 'legal']);
    assert.deepEqual((await ok.app.get('/api/v1/content-v3/status', { 'x-api-key': 'good' })).body.data.disclaimer_niches, ['dental', 'legal']);
    const broken = await start({ CONTENT_V3_ENABLED: 'true' }, undefined, async () => {
      throw new Error('mongo down');
    });
    const r = await broken.app.get('/api/v1/content-v3/status', { 'x-api-key': 'good' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.disclaimer_niches, []);
  });
});

describe('POST /session/clear', () => {
  test("deletes only this site's session, even when v3 is off", async () => {
    const store = createMemoryContentV3Store();
    await store.mergeSession(5, 9, KEY, { title: 'mine' });
    await store.mergeSession(5, 10, KEY, { title: 'other site' });
    const { app } = await start({}, store);
    const r = await app.post('/api/v1/content-v3/session/clear', { session_key: KEY }, { 'x-api-key': 'good' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, cleared: true });
    assert.equal(await store.getSession(5, 9, KEY), null);
    assert.deepEqual(await store.getSession(5, 10, KEY), { title: 'other site' });
  });

  test('Leave (left: true) also drops the post history row and blanks the article text; Submit keeps them', async () => {
    const store = createMemoryContentV3Store();
    const forgotten: Array<[number, string]> = [];
    if (app) {
      const prev = app;
      app = null;
      await prev.close();
    }
    const answers: Array<[number, string]> = [];
    app = await startTestApp([['/api/v1/content-v3', createContentV3PluginRouter({
      auth: fakeAuth, store: async () => store, env: {}, log: () => {},
      forgetArticles: async (u, k) => { forgotten.push([u, k]); return 1; },
      forgetRunResponses: async (u, k) => { answers.push([u, k]); return 1; },
    })]]);
    const post = { user_id: 5, website_id: 9, session_key: KEY, picks: {}, headings: [] };
    await store.recordPost(post);
    await app.post('/api/v1/content-v3/session/clear', { session_key: KEY }, { 'x-api-key': 'good' });
    assert.equal((await store.recentPosts(5, 9, 10)).length, 1, 'Submit keeps the post row');
    assert.deepEqual(forgotten, []);
    const r = await app.post('/api/v1/content-v3/session/clear', { session_key: KEY, left: true }, { 'x-api-key': 'good' });
    assert.equal(r.status, 200);
    assert.equal((await store.recentPosts(5, 9, 10)).length, 0);
    assert.deepEqual(forgotten, [[5, KEY]]);
    assert.deepEqual(answers, [[5, KEY]], 'M2: the stored answer in the run ledger goes too');
  });

  test('M1: switched on but its tables missing → status says off (every site stays on v2)', async () => {
    if (app) {
      const prev = app;
      app = null;
      await prev.close();
    }
    app = await startTestApp([['/api/v1/content-v3', createContentV3PluginRouter({ auth: fakeAuth, store: async () => createMemoryContentV3Store(), env: { CONTENT_V3_ENABLED: 'true' }, log: () => {}, ready: async () => false })]]);
    const r = await app.get('/api/v1/content-v3/status', { 'x-api-key': 'good' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.enabled, false);
  });

  test('a malformed key is a plain 400', async () => {
    const { app } = await start({});
    const r = await app.post('/api/v1/content-v3/session/clear', { session_key: '../x' }, { 'x-api-key': 'good' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_request');
    assert.equal(r.body.message, 'The wizard session could not be identified.');
  });
});

describe('user errors (OPS6)', () => {
  test('a step whose every attempt failed to reach the provider is service_unavailable (bulk waits)', () => {
    const down = new StepFailedError('writer', [1, 2, 3].map((a) => ({ attempt: a, ok: false, reason: 'call_failed: 529 overloaded_error', ms: 1, raw_length: 0 })));
    assert.equal(toV3UserError(down).code, 'service_unavailable');
    const bad = new StepFailedError('writer', [1, 2, 3].map((a) => ({ attempt: a, ok: false, reason: 'unreadable_json: x', ms: 1, raw_length: 5 })));
    assert.equal(toV3UserError(bad).code, 'step_failed');
  });

  test('raw provider and config errors become plain messages', () => {
    const cases: Array<[unknown, string]> = [
      [new Error('ANTHROPIC_API_KEY is not set — required for the v2 content route'), 'not_configured'],
      [Object.assign(new Error('529 {"type":"error","error":{"type":"overloaded_error"}}'), { status: 529 }), 'service_unavailable'],
      [Object.assign(new Error('rate'), { status: 429 }), 'rate_limited'],
      [new Error('Insufficient credits'), 'insufficient_credits'],
      [new Error('weird internal thing at line 5'), 'server_error'],
    ];
    for (const [err, code] of cases) {
      const u = toV3UserError(err);
      assert.equal(u.code, code);
      assert.doesNotMatch(u.message, /ANTHROPIC|529|overloaded_error|line 5/);
    }
  });

  test('a failed step names the step; all-timeout attempts read as a timeout', () => {
    const failed = new StepFailedError('title', [{ attempt: 1, ok: false, reason: 'unreadable_json: x', ms: 1, raw_length: 1 }]);
    assert.equal(toV3UserError(failed).message, "We couldn't write a title this time. Please try again.");
    const timedOut = new StepFailedError('writer', [1, 2, 3].map((n) => ({ attempt: n, ok: false, reason: 'call_failed: timed out after 300000 ms', ms: 1, raw_length: 0 })));
    assert.equal(toV3UserError(timedOut).code, 'timeout');
    assert.equal(v3Error('insufficient_credits').status, 402);
  });
});
