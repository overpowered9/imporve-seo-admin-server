/**
 * POST /content-v3/title and /content-v3/planner over real HTTP, behind the REAL requireAdmin,
 * with fake step runners.
 *
 * What is being protected: admin auth first; the request contract (required fields, the 20-post
 * cap, use_keyword_data must be a boolean); unknown keys are stripped so nothing keyword-shaped
 * can be smuggled to a step; the response envelope; StepFailedError → 502 with the attempt log.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from '../test/helpers/http-app.js';
import { createContentV3StepsRouter } from './content-v3-steps.handler.js';
import { StepFailedError } from '../services/content-v3-steps/attempts.js';
import type { TitleStepResult } from '../services/content-v3-steps/title.step.js';
import type { PlannerStepResult } from '../services/content-v3-steps/planner.step.js';

// adminAuth reads ADMIN_PASSWORD at module load, so it is set before the dynamic import.
process.env.ADMIN_PASSWORD = 'test-admin-password-123456';
const { requireAdmin, issueAdminToken } = await import('../middleware/adminAuth.middleware.js');
const AUTH = { Authorization: `Bearer ${issueAdminToken().token}` };

const base = {
  attempts: [{ attempt: 1, ok: true, reason: null, ms: 5, raw_length: 100 }],
  usage: [{ input_tokens: 1, output_tokens: 1 }],
  keyword_data: { requested: false, effective: false, used: false, ms: 0 },
  prompt: { templateType: 'content_v3_title', source: 'fallback' as const, version: 'v1' as const },
  timings: { total_ms: 5, keyword_data_ms: 0, model_ms: 5 },
  messages: { system: 'SYS', user: 'USER' },
};

let app: TestApp | null = null;
let received: any[] = [];
afterEach(async () => { await app?.close(); app = null; received = []; });

async function start(opts: { titleError?: Error; plannerError?: Error } = {}) {
  const router = createContentV3StepsRouter({
    auth: requireAdmin,
    log: () => {},
    runTitle: async (input): Promise<TitleStepResult> => {
      received.push(input);
      if (opts.titleError) throw opts.titleError;
      return { ...base, output: { title: 'A title', form: 'statement', items: null, main_concern: 'c', page_kind: 'k' } };
    },
    runPlanner: async (input): Promise<PlannerStepResult> => {
      received.push(input);
      if (opts.plannerError) throw opts.plannerError;
      return {
        ...base,
        prompt: { templateType: 'content_v3_planner', source: 'fallback', version: 'v1' },
        recent_posts: { received: input.recent_posts?.length ?? 0, sent: [] },
        output: {
          article_type: 'cost', type_reason: '', post_size: 'medium', size_reason: '', body_questions: ['q'], faq_questions: [],
          searcher_profile: { situation: '', main_concern: '', desired_outcome: '', readiness: '', their_words: [], reassurance: '' },
          ideal_client_gap: '', owner_questions: [], regulated_topic: null, regulated_reason: '', demand_notes: null, overlap: null,
        },
      };
    },
  });
  app = await startTestApp([['/api/v1/content-v3', router]]);
  return app;
}

describe('auth (real requireAdmin)', () => {
  test('401 without a token, 401 with a bad token, 200 with a minted one', async () => {
    const a = await start();
    assert.equal((await a.post('/api/v1/content-v3/title', { seed_keyword: 'x' })).status, 401);
    assert.equal((await a.post('/api/v1/content-v3/title', { seed_keyword: 'x' }, { Authorization: 'Bearer nope.nope' })).status, 401);
    assert.equal((await a.post('/api/v1/content-v3/planner', { seed_keyword: 'x', title: 't' })).status, 401);
    assert.equal(received.length, 0);
    assert.equal((await a.post('/api/v1/content-v3/title', { seed_keyword: 'x' }, AUTH)).status, 200);
  });
});

describe('validation', () => {
  test('title: required seed_keyword; booleans must be booleans; caps hold', async () => {
    const a = await start();
    const cases: Array<[unknown, RegExp]> = [
      [{}, /seed_keyword is required/],
      [{ seed_keyword: '  ' }, /seed_keyword is required/],
      [{ seed_keyword: 'x', use_keyword_data: 'true' }, /use_keyword_data must be a boolean/],
      [{ seed_keyword: 'x', previous_titles: Array.from({ length: 11 }, () => 't') }, /previous_titles/],
      [{ seed_keyword: 'x', search_data: { ranking_titles: [{ text: 't', scope: 'global' }] } }, /search_data/],
      [{ seed_keyword: 'x', language_code: 'eng' }, /two-letter/],
      [{ seed_keyword: 'x', max_list_items: 0 }, /max_list_items/],
    ];
    for (const [body, re] of cases) {
      const r = await a.post('/api/v1/content-v3/title', body, AUTH);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'VALIDATION_ERROR');
      assert.match(r.body.error, re);
    }
    assert.equal(received.length, 0);
  });

  test('planner: required title and seed_keyword; at most 20 recent_posts with numeric ids', async () => {
    const a = await start();
    const cases: Array<[unknown, RegExp]> = [
      [{ seed_keyword: 'x' }, /title is required/],
      [{ title: 't' }, /seed_keyword is required/],
      [{ title: 't', seed_keyword: 'x', recent_posts: Array.from({ length: 21 }, (_, i) => ({ post_id: i + 1, title: 'p' })) }, /at most 20 posts/],
      [{ title: 't', seed_keyword: 'x', recent_posts: [{ post_id: '12', title: 'p' }] }, /post_id must be a number/],
      [{ title: 't', seed_keyword: 'x', minimum_size: 'xl' }, /minimum_size/],
      [{ title: 't', seed_keyword: 'x', use_keyword_data: 1 }, /use_keyword_data must be a boolean/],
    ];
    for (const [body, re] of cases) {
      const r = await a.post('/api/v1/content-v3/planner', body, AUTH);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, re);
    }
    assert.equal(received.length, 0);
  });
});

describe('responses', () => {
  test('title: envelope { success, data, metadata }, parsed input reaches the step, unknown keys are stripped', async () => {
    const a = await start();
    const r = await a.post(
      '/api/v1/content-v3/title',
      {
        seed_keyword: ' Water Heater Repair Cost ',
        search_data: { ranking_titles: ['Plain string item', { text: 'Scoped', scope: 'national' }] },
        use_keyword_data: true,
        language_code: 'EN',
        keyword_data: '<keyword_data>smuggled</keyword_data>',
        search_volume: 999,
      },
      AUTH,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.data, { title: 'A title', form: 'statement', items: null, main_concern: 'c', page_kind: 'k' });
    assert.deepEqual(Object.keys(r.body.metadata).sort(), ['attempts', 'keyword_data', 'messages', 'prompt', 'timings', 'usage']);
    const input = received[0];
    assert.equal(input.seed_keyword, 'Water Heater Repair Cost');
    assert.equal(input.use_keyword_data, true);
    assert.equal(input.language_code, 'en');
    assert.deepEqual(input.search_data.ranking_titles, [{ text: 'Plain string item', scope: 'local' }, { text: 'Scoped', scope: 'national' }]);
    assert.equal('keyword_data' in input, false);
    assert.equal('search_volume' in input, false);
  });

  test('planner: data always carries demand_notes and overlap; metadata carries recent_posts', async () => {
    const a = await start();
    const r = await a.post('/api/v1/content-v3/planner', { title: 'T', seed_keyword: 'x', recent_posts: [{ post_id: 1, title: 'p' }] }, AUTH);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.demand_notes, null);
    assert.equal(r.body.data.overlap, null);
    assert.deepEqual(r.body.metadata.recent_posts, { received: 1, sent: [] });
  });

  test('a step that gives up is a 502 with the attempt log; anything else a 500', async () => {
    const failing = new StepFailedError('title', [{ attempt: 1, ok: false, reason: 'title_too_long: 80 chars', ms: 1, raw_length: 10 }]);
    const a = await start({ titleError: failing, plannerError: new Error('boom') });
    const t = await a.post('/api/v1/content-v3/title', { seed_keyword: 'x' }, AUTH);
    assert.equal(t.status, 502);
    assert.equal(t.body.code, 'STEP_FAILED');
    assert.equal(t.body.attempts.length, 1);
    const p = await a.post('/api/v1/content-v3/planner', { title: 't', seed_keyword: 'x' }, AUTH);
    assert.equal(p.status, 500);
  });
});

describe('live wiring (source assertions)', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  test('both steps are requireAdmin and mounted on the v3 router; /article/test is untouched', () => {
    const wiring = fs.readFileSync(path.join(SRC, 'routes/content-v3-steps.routes.ts'), 'utf8');
    const v3 = fs.readFileSync(path.join(SRC, 'routes/content-v3.routes.ts'), 'utf8');
    assert.match(wiring, /auth: requireAdmin/);
    assert.match(wiring, /runTitleStep\(input, liveTitleDeps\(\)\)/);
    assert.match(wiring, /runPlannerStep\(input, livePlannerDeps\(\)\)/);
    assert.match(v3, /router\.use\('\/', stepsRoutes\);/);
    assert.match(v3, /router\.post\('\/article\/test', requireAdmin, async/);
  });
});
