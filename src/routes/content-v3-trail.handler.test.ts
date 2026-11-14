import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrailRouter } from './content-v3-trail.handler.js';
import { startTestApp } from '../test/helpers/http-app.js';

const KEY = 'iseo_tk_0123456789abcdef0123456789abcdef';
const admin = (req: any, res: any, next: any) => (req.headers['x-admin'] === 'yes' ? next() : res.status(401).json({ success: false }));

test('admin trail: runs (no stored article), generations (billing, versions, verdict), post row; admin only', async () => {
  const app = await startTestApp([['/api/v1/content-v3', createTrailRouter({
    auth: admin,
    runs: async () => [{ id: 1, user_id: 5, website_id: 9, session_key: KEY, request_id: 'iseo_rq_1', status: 'succeeded', cost: 10, action: 'content', variant: 'medium', generation_id: 77, response: { data: { content: '<p>secret article</p>' } }, step_costs: { writer: 0.2 }, timings: { total_ms: 90000 }, error: null, created_at: 'a', updated_at: 'b' }],
    generations: async () => [{ id: 77, user_id: 5, website_id: 9, type: 'content_v3', status: 'success', created_at: 'c', processing_time_ms: 90000, metadata: JSON.stringify({ model: 'claude-x', prompt_version: 'w@code#1', billed: { cost: 10 }, validator: { passed: true, errors: 0, warnings: 1, word_count: 1500, issues: [] } }) }],
    posts: async () => [{ id: 3, article_type: 'cost', post_size: 'medium', fingerprint: 'f', validator: { passed: true } }],
  })]]);
  try {
    assert.equal((await app.get(`/api/v1/content-v3/admin/trail?run=${KEY}`)).status, 401);
    assert.equal((await app.get('/api/v1/content-v3/admin/trail?run=../x', { 'x-admin': 'yes' })).status, 400);
    const r = await app.get(`/api/v1/content-v3/admin/trail?run=${KEY}`, { 'x-admin': 'yes' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.log_query, `run=${KEY}`);
    assert.equal(r.body.data.runs[0].has_stored_answer, true);
    assert.equal(r.body.data.runs[0].response, undefined);
    assert.deepEqual(r.body.data.generations[0].billed, { cost: 10 });
    assert.deepEqual(r.body.data.generations[0].validator, { passed: true, errors: 0, warnings: 1, word_count: 1500 });
    assert.equal(r.body.data.posts[0].validator_passed, true);
    assert.doesNotMatch(JSON.stringify(r.body), /secret article/);
  } finally {
    await app.close();
  }
});

test('admin trail: a missing table shows as unavailable, the rest still answers', async () => {
  const app = await startTestApp([['/api/v1/content-v3', createTrailRouter({
    auth: (_req, _res, next) => next(),
    runs: async () => { throw new Error('relation "content_v3_runs" does not exist'); },
    generations: async () => [],
    posts: async () => [],
  })]]);
  try {
    const r = await app.get(`/api/v1/content-v3/admin/trail?run=${KEY}`);
    assert.equal(r.status, 200);
    assert.match(r.body.data.runs.unavailable, /content_v3_runs/);
    assert.deepEqual(r.body.data.generations, []);
  } finally {
    await app.close();
  }
});
