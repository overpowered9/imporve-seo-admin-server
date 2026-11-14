import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, fakePluginAuth, PLUGIN_HEADERS, type TestApp } from '../test/helpers/http-app.js';
import { createContentV3ArticleRouter, regulatedV3Allowed, type BillingDeps, type GenerationRow } from './content-v3-article.handler.js';
import { createMemoryContentV3Store } from '../services/content-v3/store.js';
import type { ArticleV3Input, ArticleV3Result } from '../services/writer/article.js';

const KEY = 'iseo_tk_0123456789abcdef0123456789abcdef';
const ON = { CONTENT_V3_ENABLED: 'true' };

const SESSION = {
  approved: { title: 'Water heater repair cost in Española', seed_keyword: 'water heater repair cost', language: 'US English', niche_key: 'plumbing', reach: 'local', target_town: 'Española', proof_level: 'standard' },
  plan: { article_type: 'cost', post_size: 'medium', body_questions: ['a'], faq_questions: ['f'], searcher_profile: { readiness: 'comparing' } },
  regulated: { suggested: true, by: 'list' },
  research: { result: { research: { facts: [], sources: {} } } },
  cost: { search_data: 0.0043, title: 0.015, planner: 0.035 },
};

function result(over: Partial<ArticleV3Result> = {}): ArticleV3Result {
  return {
    content: '<p>article</p>', meta_title: 'm', meta_description: 'd', faq: [], faq_schema: null,
    validator: { passed: true, errors: 0, warnings: 1, issues: [{ code: 'em_dash', severity: 'warning', message: 'Some paragraphs use more than one em dash.' }], word_count: 1500 },
    needs_review: false, repaired: false, proof_level: 'regulated', article_type: 'cost', picks: { opening: 'reader_stakes' } as any, fingerprint: 'abc123', headings: ['H1', 'H2'],
    linked_sources: [], writer_json: { facts_used: [], claims_to_check: [], items_delivered: null }, writer_attempts: 1,
    cost: { writer: 0.21, meta: 0.01 }, usage: { writer: [], meta: [] }, prompt_version: 'content_v3_writer@code#deadbeef', model: 'claude-opus-4-8',
    messages: { system: 'S', user: 'U', blueprint: 'B', niche_profile: 'N' }, timings: { writer_ms: 1, meta_ms: 1, total_ms: 2 },
    ...over,
  };
}

let app: TestApp | null = null;
afterEach(async () => {
  const a = app;
  app = null;
  await a?.close();
});

async function start(opts: { env?: NodeJS.ProcessEnv; session?: Record<string, unknown> | null; generate?: (i: ArticleV3Input) => Promise<ArticleV3Result>; regen?: boolean; reserveOk?: boolean; disclaimerKeys?: string[] } = {}) {
  const store = createMemoryContentV3Store();
  if (opts.session !== null) await store.mergeSession(7, 3, KEY, opts.session ?? SESSION);
  const events: string[] = [];
  const rows: GenerationRow[] = [];
  const inputs: ArticleV3Input[] = [];
  const logs: string[] = [];
  const billing: BillingDeps = {
    isRegeneration: async () => !!opts.regen,
    price: (action, variant) => ({ content: { small: 6, medium: 10, large: 14 }, content_regen: { small: 3, medium: 5, large: 7 } })[action][variant],
    reserve: async (_u, cost) => {
      events.push(`reserve:${cost}`);
      return opts.reserveOk === false ? { ok: false } : { ok: true, balance_after: 90 };
    },
    refund: async (_u, cost) => {
      events.push(`refund:${cost}`);
    },
    shortfall: async () => ({ available: 4, also_affords: 'an AI image' }),
  };
  const router = createContentV3ArticleRouter({
    auth: fakePluginAuth({ id: 7 }, { id: 3 }),
    store: async () => store,
    billing,
    generate: async (input) => {
      events.push('generate');
      inputs.push(input);
      return opts.generate ? opts.generate(input) : result();
    },
    insertGeneration: async (row) => {
      rows.push(row);
      return 555;
    },
    env: opts.env ?? ON,
    log: (l) => logs.push(l),
    disclaimerKeys: async () => opts.disclaimerKeys ?? [],
  });
  app = await startTestApp([['/api/v1/content-v3', router]]);
  return { app, store, events, rows, inputs, logs };
}

const BODY = { session_key: KEY, post_size: 'medium', regulated: true, point_of_view: 'we', tone: 'friendly', owner_answers: [{ question: 'Typical cost?', answer: 'About $300.' }], anything_else: 'Mention same-day service.', cta_text: 'Book a visit', cta_url: 'https://acme.example/book' };

describe('POST /content-v3/article', () => {
  test('reserves the v2 price for the size BEFORE writing; records the generation and the post; logs the cost line', async () => {
    const { app, events, rows, inputs, store, logs } = await start();
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(events, ['reserve:10', 'generate']);
    assert.equal(r.body.data.generation_id, 555);
    assert.equal(r.body.data.review.issues[0].severity, 'warning');
    assert.deepEqual(r.body.metadata.credits, { charged: 10, action: 'content', variant: 'medium', balance_after: 90 });
    assert.equal(inputs[0].regulated_suggested, true);
    assert.equal(inputs[0].regulated_choice, true);
    assert.equal(inputs[0].niche, 'plumbing');
    assert.deepEqual(inputs[0].post_answers, [{ question: 'Typical cost?', answer: 'About $300.' }]);
    assert.equal(rows[0].metadata.model, 'claude-opus-4-8');
    assert.equal(rows[0].target_key, KEY);
    assert.equal(rows[0].custom_instruction, 'Mention same-day service.');
    const posts = await store.recentPosts(7, 3, 20);
    assert.equal(posts[0].fingerprint, 'abc123');
    assert.deepEqual(posts[0].headings, ['H1', 'H2']);
    assert.match(logs.join('\n'), /\[content-v3\] cost run=iseo_tk_\w+ search_data=0\.0043 title=0\.0150 planner=0\.0350 writer=0\.2100 meta=0\.0100 total=0\.2743/);
  });

  test('regeneration is priced from server history; history feeds the blueprint', async () => {
    const { app, events, store, inputs } = await start({ regen: true });
    await store.recordPost({ user_id: 7, website_id: 3, picks: { opening: 'myth_correction' }, headings: ['Old heading'], article_type: 'cost', fingerprint: 'old' });
    await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.deepEqual(events, ['reserve:5', 'generate']);
    assert.equal(inputs[0].history[0].fingerprint, 'old');
    assert.deepEqual(inputs[0].history[0].headings, ['Old heading']);
  });

  test('a failure refunds exactly what was charged, with a plain message', async () => {
    const { app, events } = await start({ generate: async () => { throw Object.assign(new Error('529 overloaded_error'), { status: 529 }); } });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 503);
    assert.deepEqual(events, ['reserve:10', 'generate', 'refund:10']);
    assert.doesNotMatch(r.body.message, /529|overloaded/);
  });

  test('402 when the balance is short: nothing written, the v2 wording', async () => {
    const { app, events } = await start({ reserveOk: false });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 402);
    assert.deepEqual(events, ['reserve:10']);
    assert.equal(r.body.message, 'Not enough credits: this needs 10 and you have 4. Your balance is still enough for an AI image.');
  });

  test('no plan in the session → 409 session_expired, nothing charged', async () => {
    const { app, events } = await start({ session: null });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'session_expired');
    assert.deepEqual(events, []);
  });

  test('a second request for the same session while one runs is refused (charged once)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, events } = await start({ generate: async () => { await gate; return result(); } });
    const first = app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    await new Promise((r) => setTimeout(r, 50));
    const second = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    release();
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'already_generating');
    assert.equal((await first).status, 200);
    assert.equal(events.filter((e) => e.startsWith('reserve')).length, 1);
  });

  test('A3: a Regulated business whose niche has no disclaimer text stays on v2 (409, nothing charged)', async () => {
    const regulated = { ...SESSION, approved: { ...SESSION.approved, niche_key: 'dental', proof_level: 'regulated' } };
    const off = await start({ session: regulated });
    const r = await off.app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'v3_regulated_disabled');
    assert.deepEqual(off.events, [], 'no reserve, no generation');
    assert.match(off.logs.join('\n'), /article refused run=iseo_tk_\w+ reason=regulated_without_disclaimer niche=dental/);
    await off.app.close();
    app = null;
    // With a text for the niche (or its profile), the article goes ahead as usual.
    const on = await start({ session: regulated, disclaimerKeys: ['dental'] });
    const r2 = await on.app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(on.events, ['reserve:10', 'generate']);
    // A Standard business never needs a disclaimer text.
    assert.equal(regulatedV3Allowed([], 'plumbing', null), false);
    assert.equal(regulatedV3Allowed(['health_regulated'], 'dental', 'health_regulated'), true);
  });

  test('v3 off → 409 v3_disabled; bad input → 400', async () => {
    const off = await start({ env: {} });
    assert.equal((await off.app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS)).body.error, 'v3_disabled');
    await off.app.close();
    app = null;
    const on = await start();
    const r = await on.app.post('/api/v1/content-v3/article', { ...BODY, post_size: 'huge' }, PLUGIN_HEADERS);
    assert.equal(r.status, 400);
    const r2 = await on.app.post('/api/v1/content-v3/article', { ...BODY, cta_url: 'javascript:alert(1)' }, PLUGIN_HEADERS);
    assert.equal(r2.status, 400);
  });
});
