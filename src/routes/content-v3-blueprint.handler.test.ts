import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestHandler } from 'express';
import { startTestApp, type TestApp } from '../test/helpers/http-app.js';
import { createBlueprintRouter, parseBlueprintPins } from './content-v3-blueprint.handler.js';

const admin: RequestHandler = (req, res, next) => (req.header('authorization') === 'Bearer admin' ? next() : res.status(401).json({ success: false }));
let app: TestApp | null = null;
afterEach(async () => {
  const a = app;
  app = null;
  await a?.close();
});

describe('pins contract (X1–X7)', () => {
  test('accepts the new dimensions; rejects the removed ones', () => {
    assert.deepEqual(parseBlueprintPins({ opening: 'reader_situation', accent: 'one_checklist', order: 'closing_first', toc: true }).pins, { opening: 'reader_situation', accent: 'one_checklist', order: 'closing_first', toc: true });
    assert.match(parseBlueprintPins({ opening: 'lived_scenario' }).error!, /blueprint_pins\.opening/);
    assert.match(parseBlueprintPins({ accent: 'pull_quote' }).error!, /blueprint_pins\.accent/);
    assert.match(parseBlueprintPins({ sectionCount: 5 }).error!, /Unrecognized key/);
    assert.match(parseBlueprintPins({ faqPlacement: 'woven' }).error!, /Unrecognized key/);
    assert.equal(parseBlueprintPins({}).pins, undefined);
    assert.equal(parseBlueprintPins(undefined).pins, undefined);
  });
});

describe('POST /blueprint/preview', () => {
  test('admin only; same seed → same blueprint; pins applied; niche firmness caps the closing', async () => {
    app = await startTestApp([['/api/v1/content-v3', createBlueprintRouter({ auth: admin })]]);
    const body = {
      article_type: 'cost', post_size: 'medium', title: 'Water heater repair cost in Española', niche: 'general_blog', readiness: 'ready to hire',
      body_questions: ['A?', 'B?', 'C?', 'D?', 'E?', 'F?'], faq_questions: ['F1?', 'F2?'], price_texts: ['Repairs cost $150 to $700.'], seed: 4,
      pins: { opening: 'direct_question' },
    };
    assert.equal((await app.post('/api/v1/content-v3/blueprint/preview', body)).status, 401);
    const a = await app.post('/api/v1/content-v3/blueprint/preview', body, { Authorization: 'Bearer admin' });
    const b = await app.post('/api/v1/content-v3/blueprint/preview', body, { Authorization: 'Bearer admin' });
    assert.equal(a.status, 200);
    assert.equal(a.body.data.blueprint, b.body.data.blueprint);
    assert.equal(a.body.data.picks.opening, 'direct_question');
    assert.equal(a.body.data.picks.firmness, 'soft', 'Content only caps the closing at soft');
    assert.match(a.body.data.niche_profile, /^<niche_profile>\nNICHE: General Blog\/Content Creator\. PROFILE: Content only\./);
    const bad = await app.post('/api/v1/content-v3/blueprint/preview', { ...body, pins: { sectionCount: 5 } }, { Authorization: 'Bearer admin' });
    assert.equal(bad.status, 400);
  });
});

describe('GET /blueprint/options', () => {
  test('pools come from the pieces', async () => {
    app = await startTestApp([['/api/v1/content-v3', createBlueprintRouter({ auth: admin })]]);
    const r = await app.get('/api/v1/content-v3/blueprint/options', { Authorization: 'Bearer admin' });
    assert.equal(r.body.data.pools.cost.length, 8);
    assert.deepEqual(r.body.data.pools.cost[2], { label: 'local price factors', local_only: true, supplied_only: false });
    assert.deepEqual(r.body.data.openings, ['reader_situation', 'reader_stakes', 'direct_question', 'contrarian_claim', 'myth_correction']);
  });
});
