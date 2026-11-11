/**
 * POST /content-v3/keyword-data/ab-test behind the real requireAdmin, with a fake runner.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from '../test/helpers/http-app.js';
import { createKeywordDataAbRouter } from './content-v3-ab.handler.js';

process.env.ADMIN_PASSWORD = 'test-admin-password-123456';
const { requireAdmin, issueAdminToken } = await import('../middleware/adminAuth.middleware.js');
const AUTH = { Authorization: `Bearer ${issueAdminToken().token}` };

let app: TestApp | null = null;
let received: any[] = [];
afterEach(async () => { await app?.close(); app = null; received = []; });

async function start() {
  const router = createKeywordDataAbRouter({
    auth: requireAdmin,
    log: () => {},
    run: async (input, options) => {
      received.push({ input, options });
      return {
        run_id: 'r1', started_at: 's', finished_at: 'f', location_code: input.location_code ?? 2840, language_code: input.language_code ?? 'en', flag_env_on: false, model_prices_configured: false,
        keywords: [], totals: { dataforseo_cost_usd: 0, model_cost_usd: null, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, latency_ms: 0 }, files: null,
      };
    },
  });
  app = await startTestApp([['/api/v1/content-v3/keyword-data', router]]);
  return app;
}
const URL = '/api/v1/content-v3/keyword-data/ab-test';

describe('ab-test route', () => {
  test('admin-only', async () => {
    const a = await start();
    assert.equal((await a.post(URL, { keywords: ['a'] })).status, 401);
    assert.equal(received.length, 0);
  });

  test('validation: 1..10 keywords, booleans, caps', async () => {
    const a = await start();
    for (const [body, re] of [
      [{}, /keywords is required/],
      [{ keywords: [] }, /at least 1/],
      [{ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }, /at most 10/],
      [{ keywords: ['a'], save: 'yes' }, /save/],
      [{ keywords: ['a'], business: { recent_posts: Array.from({ length: 21 }, (_, i) => ({ post_id: i + 1, title: 't' })) } }, /recent_posts/],
    ] as Array<[unknown, RegExp]>) {
      const r = await a.post(URL, body, AUTH);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, re);
    }
    assert.equal(received.length, 0);
  });

  test('200: passes the parsed input and save option to the runner and returns the result', async () => {
    const a = await start();
    const r = await a.post(URL, { keywords: [' a ', 'b'], language_code: 'EN', save: false, fixtures: { a: { search_data: { ranking_titles: ['t'] } } }, extra: 'dropped' }, AUTH);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.data.run_id, 'r1');
    assert.deepEqual(received[0].input.keywords, ['a', 'b']);
    assert.equal(received[0].input.language_code, 'en');
    assert.deepEqual(received[0].options, { save: false });
    assert.deepEqual(received[0].input.fixtures.a.search_data.ranking_titles, [{ text: 't', scope: 'local' }]);
    assert.equal('extra' in received[0].input, false);
    assert.equal('save' in received[0].input, false);
  });
});

describe('live wiring (source assertions)', () => {
  test('mounted on the keyword-data router behind requireAdmin, saving under data/ab-tests', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const wiring = fs.readFileSync(path.join(SRC, 'routes/content-v3-keyword-data.routes.ts'), 'utf8');
    const live = fs.readFileSync(path.join(SRC, 'services/ab-harness/keyword-data-ab.default.ts'), 'utf8');
    assert.match(wiring, /createKeywordDataAbRouter\(\{\s*auth: requireAdmin/);
    assert.match(live, /path\.join\(process\.cwd\(\), 'data', 'ab-tests'\)/);
    assert.doesNotMatch(live, /uploads/);
  });
});
