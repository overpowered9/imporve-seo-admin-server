import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, fakePluginAuth, PLUGIN_HEADERS, type TestApp } from '../test/helpers/http-app.js';
import { abortInFlightArticles, createContentV3ArticleRouter, regulatedV3Allowed, type BillingDeps, type GenerationRow } from './content-v3-article.handler.js';
import { createMemoryContentV3Store } from '../services/content-v3/store.js';
import { createMemoryRunsStore, retryPendingRefunds, type RunsStore } from '../services/content-v3/runs.js';
import { createMemoryQuotaStore, type QuotaStore } from '../services/content-v3/quota.js';
import type { RequestHandler } from 'express';
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

async function start(opts: { env?: NodeJS.ProcessEnv; session?: Record<string, unknown> | null; generate?: (i: ArticleV3Input) => Promise<ArticleV3Result>; regen?: boolean; reserveOk?: boolean; disclaimerKeys?: string[]; runs?: RunsStore; deadlineMs?: number; refundFails?: boolean; quota?: QuotaStore; rateLimit?: RequestHandler; ready?: () => Promise<boolean> } = {}) {
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
      if (opts.refundFails) throw new Error('billing down');
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
    runs: opts.runs,
    deadlineMs: opts.deadlineMs,
    quota: opts.quota ? async () => opts.quota! : undefined,
    rateLimit: opts.rateLimit,
    ready: opts.ready,
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

  test('B-3: the same click retried replays the stored article — charged once, written once', async () => {
    const runs = createMemoryRunsStore();
    const { app, events } = await start({ runs });
    const body = { ...BODY, request_id: 'iseo_rq_0123456789abcdef' };
    const first = await app.post('/api/v1/content-v3/article', body, PLUGIN_HEADERS);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await app.post('/api/v1/content-v3/article', body, PLUGIN_HEADERS);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body, 'the replay is the stored answer');
    assert.deepEqual(events, ['reserve:10', 'generate'], 'one charge, one generation');
    assert.equal(runs.rows[0].status, 'succeeded');
    assert.equal(runs.rows[0].generation_id, 555);
  });

  test('B-3: a different click while one runs is refused by the ledger (any instance)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runs = createMemoryRunsStore();
    const { app, events } = await start({ runs, generate: async () => { await gate; return result(); } });
    const first = app.post('/api/v1/content-v3/article', { ...BODY, request_id: 'iseo_rq_aaaaaaaaaaaaaaaa' }, PLUGIN_HEADERS);
    await new Promise((r) => setTimeout(r, 50));
    // A second router (another server instance) sharing the same ledger.
    const other = await startTestApp([['/api/v1/content-v3', createContentV3ArticleRouter({
      auth: fakePluginAuth({ id: 7 }, { id: 3 }),
      store: async () => { const s = createMemoryContentV3Store(); await s.mergeSession(7, 3, KEY, SESSION); return s; },
      billing: { isRegeneration: async () => false, price: () => 10, reserve: async () => { events.push('reserve:other'); return { ok: true }; }, refund: async () => {}, shortfall: async () => ({ available: 0, also_affords: null }) },
      generate: async () => result(),
      insertGeneration: async () => 1,
      env: ON,
      log: () => {},
      runs,
    })]]);
    const second = await other.post('/api/v1/content-v3/article', { ...BODY, request_id: 'iseo_rq_bbbbbbbbbbbbbbbb' }, PLUGIN_HEADERS);
    await other.close();
    release();
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'already_generating');
    assert.equal((await first).status, 200);
    assert.deepEqual(events.filter((e) => e.startsWith('reserve')), ['reserve:10']);
  });

  test('B-3: a refund that fails is queued (refund_pending) and the retry loop refunds it', async () => {
    const runs = createMemoryRunsStore();
    const { app, events, logs } = await start({ runs, refundFails: true, generate: async () => { throw new Error('writer: no valid output after 3 attempts'); } });
    const r = await app.post('/api/v1/content-v3/article', { ...BODY, request_id: 'iseo_rq_cccccccccccccccc' }, PLUGIN_HEADERS);
    assert.equal(r.status, 500);
    assert.equal(runs.rows[0].status, 'refund_pending');
    assert.match(logs.join('\n'), /REFUND FAILED user=7 amount=10 \(queued for retry\)/);
    const done = await retryPendingRefunds(runs, async () => {}, () => {});
    assert.deepEqual(done, { refunded: 1, failed: 0 });
    assert.equal(runs.rows[0].status, 'refunded');
    assert.deepEqual(events, ['reserve:10', 'generate', 'refund:10']);
  });

  test('B-3: a generation that hangs past the deadline is answered as a timeout and refunded', async () => {
    const runs = createMemoryRunsStore();
    const { app, events } = await start({ runs, deadlineMs: 30, generate: () => new Promise<ArticleV3Result>(() => {}) });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 504, JSON.stringify(r.body));
    assert.equal(r.body.error, 'timeout');
    assert.deepEqual(events, ['reserve:10', 'generate', 'refund:10']);
    assert.equal(runs.rows[0].status, 'refunded');
  });

  test('B-3: with the ledger unavailable (no migration 024), the in-process lock still guards and the article is made', async () => {
    const broken: RunsStore = { ...createMemoryRunsStore(), claim: async () => { throw new Error('relation "content_v3_runs" does not exist'); } };
    const { app, events, logs } = await start({ runs: broken });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.deepEqual(events, ['reserve:10', 'generate']);
    assert.match(logs.join('\n'), /runs ledger unavailable — using the in-process lock/);
  });

  test('H2: a shutdown fails an article in progress at once: refunded, with a plain message', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, events } = await start({ generate: async () => { await gate; return result(); } });
    const pending = app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    for (let i = 0; i < 200 && !events.includes('generate'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(abortInFlightArticles(), 1);
    const r = await pending;
    assert.equal(r.status, 503);
    assert.match(r.body.message, /restarted .* credits were refunded/);
    assert.deepEqual(events, ['reserve:10', 'generate', 'refund:10']);
    assert.equal(abortInFlightArticles(), 0, 'nothing left registered');
    release();
  });

  test('M1: with the v3 tables missing the article answers v3 off, before anything', async () => {
    const { app, events } = await start({ ready: async () => false });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'v3_disabled');
    assert.deepEqual(events, []);
  });

  test('M1: two requests at the same moment without the ledger: one runs, the other is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, events } = await start({ generate: async () => { await gate; return result(); } });
    const a = app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    const b = app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    // Whichever arrives second must be refused while the first is still writing (never wait on it).
    const tooLong = new Promise<{ status: number }>((r) => setTimeout(() => r({ status: -1 }), 5000));
    const first = await Promise.race([a.then((x) => ({ who: 'a', x })), b.then((x) => ({ who: 'b', x })), tooLong.then((x) => ({ who: 'none', x }))]);
    assert.equal(first.x.status, 409, 'the second request is refused at once');
    release();
    const other = await (first.who === 'a' ? b : a);
    assert.equal(other.status, 200);
    assert.deepEqual(events.filter((e) => e.startsWith('reserve')), ['reserve:10'], 'charged once');
  });

  test('D: an article that cost more than its size\'s ceiling logs a warning (billing unchanged)', async () => {
    const pricey = await start({ session: { ...SESSION, cost: { search_data: 0.01, title: 0.02, research: 0.2, planner: 0.05 } } });
    assert.equal((await pricey.app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS)).status, 200);
    assert.match(pricey.logs.join('\n'), /\[content-v3\] cost over ceiling run=iseo_tk_\w+ size=medium total=0\.5\d{3} ceiling=0\.35 credits=10/);
    assert.match(pricey.logs.join('\n'), /\[content-v3\] latency run=iseo_tk_\w+ route=article ms=\d+/);
    assert.deepEqual(pricey.events, ['reserve:10', 'generate']);
    await pricey.app.close();
    app = null;
    const cheap = await start({ session: { ...SESSION, cost: { title: 0.01 } } });
    await cheap.app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.doesNotMatch(cheap.logs.join('\n'), /cost over ceiling/);
  });

  test('W8: a size below the numbered title\'s minimum is refused on the server, before any charge', async () => {
    const { app, events } = await start({ session: { ...SESSION, plan_meta: { minimum_size: 'large' } } });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /at least a Large post/);
    assert.deepEqual(events, []);
    assert.equal((await app.post('/api/v1/content-v3/article', { ...BODY, post_size: 'large' }, PLUGIN_HEADERS)).status, 200);
  });

  test('B-5: a delivered article is counted for the free steps\' allowance; a replay or a failure is not', async () => {
    const quota = createMemoryQuotaStore();
    const runs = createMemoryRunsStore();
    const ok = await start({ quota, runs });
    const body = { ...BODY, request_id: 'iseo_rq_0123456789abcdef' };
    assert.equal((await ok.app.post('/api/v1/content-v3/article', body, PLUGIN_HEADERS)).status, 200);
    assert.equal((await ok.app.post('/api/v1/content-v3/article', body, PLUGIN_HEADERS)).status, 200, 'replayed');
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(quota.counts.get(`7|${today}|article`), 1);
    await ok.app.close();
    app = null;
    const q2 = createMemoryQuotaStore();
    const failing = await start({ quota: q2, generate: async () => { throw new Error('writer down'); } });
    assert.notEqual((await failing.app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS)).status, 200);
    assert.equal(q2.counts.size, 0);
  });

  test('B-5: the per-minute limiter runs after auth and before anything is charged', async () => {
    const limiter: RequestHandler = (_req, res) => res.status(429).json({ success: false, error: 'rate_limited', message: 'Too many requests in a short time. Please wait a minute and try again.' });
    const { app, events } = await start({ rateLimit: limiter });
    const r = await app.post('/api/v1/content-v3/article', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 429);
    assert.deepEqual(events, []);
    assert.equal((await app.post('/api/v1/content-v3/article', BODY)).status, 401, 'auth still first');
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
