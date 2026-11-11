/**
 * The A/B harness with scripted steps: both arms run per keyword, inputs are frozen across arms,
 * keyword data is prefetched once, the ON arm is forced on regardless of the env flag, failures are
 * recorded rather than thrown, and the JSON + CSV are written.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runKeywordDataAbTest, abResultToCsv, modelPrices, AB_CSV_COLUMNS } from './keyword-data-ab.js';
import { fallbackStepPromptResolver, TITLE_SYSTEM_V1, TITLE_SYSTEM_V2_KEYWORD_DATA, PLANNER_SYSTEM_V2_KEYWORD_DATA } from '../content-v3-steps/prompts.js';
import type { KeywordDataService, PromptKeywordData, SeedWithRelated } from '../keyword-data/keyword-data.service.js';
import type { ModelCall, StepDeps } from '../content-v3-steps/step-common.js';

const USAGE = { input_tokens: 100, output_tokens: 20 };
const TITLE = (t: string) => JSON.stringify({ title: t, form: 'statement', items: null, main_concern: 'c', page_kind: 'k' });
const PLAN = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    article_type: 'cost', type_reason: '', post_size: 'medium', size_reason: '', body_questions: ['How much?', 'What drives it?'], faq_questions: ['Worth it?'],
    searcher_profile: { situation: '', main_concern: '', desired_outcome: '', readiness: 'comparing', their_words: [], reassurance: '' },
    ideal_client_gap: '', owner_questions: [], regulated_topic: false, regulated_reason: '', ...extra,
  });

/** Answers by looking at which system prompt arrived, so arms can be told apart without ordering assumptions. */
function scriptedModel(opts: { failPlannerOn?: boolean } = {}) {
  const calls: Array<{ system: string; user: string }> = [];
  const model: ModelCall = async ({ system, user }) => {
    calls.push({ system, user });
    const isTitle = system === TITLE_SYSTEM_V1 || system === TITLE_SYSTEM_V2_KEYWORD_DATA;
    const on = system === TITLE_SYSTEM_V2_KEYWORD_DATA || system === PLANNER_SYSTEM_V2_KEYWORD_DATA;
    if (isTitle) return { text: TITLE(on ? 'Title with keyword data' : 'Title without keyword data'), usage: USAGE };
    if (on && opts.failPlannerOn) throw new Error('planner exploded');
    return { text: PLAN(on ? { demand_notes: 'Volume broke a tie.', overlap: null } : {}), usage: USAGE };
  };
  return { model, calls };
}

function fakeKeywordData() {
  const prefetches: any[][] = [];
  const prompts: any[][] = [];
  const seed = { keyword: 'water heater repair cost', search_volume: 2400, keyword_difficulty: 18, intent: 'commercial' as const, scope: 'national' as const, fetched_at: '2026-11-11T10:00:00.000Z' };
  const data: PromptKeywordData = { block: '<keyword_data scope="national" location="United States">\nseed: water heater repair cost | volume 2400\n</keyword_data>', seed, related: [], source: 'cache' };
  const service = {
    configured: true,
    getMetrics: async () => { throw new Error('unused'); },
    getSeedWithRelated: async (...args: any[]): Promise<SeedWithRelated> => { prefetches.push(args); return { status: 'ready', seed, related: [seed], cost_usd: 0.02, source: 'dataforseo' }; },
    tryGetForPrompt: async (...args: any[]) => { prompts.push(args); return data; },
  } as unknown as KeywordDataService;
  return { service, prefetches, prompts };
}

function stepDeps(model: ModelCall, keywordData: KeywordDataService): StepDeps {
  return { model, resolvePrompt: fallbackStepPromptResolver, keywordData, log: () => {} };
}

describe('runKeywordDataAbTest', () => {
  test('runs OFF then ON per keyword with frozen fixtures, prefetches once, forces the ON arm on, saves JSON + CSV', async () => {
    const m = scriptedModel();
    const kd = fakeKeywordData();
    const written: Record<string, string> = {};
    const result = await runKeywordDataAbTest(
      {
        keywords: ['water heater repair cost', 'boiler service'],
        business: { niche: 'plumbing', target_town: 'Española', recent_posts: [{ post_id: 2, title: 'How much does water heater repair cost?' }] },
        fixtures: { 'Water Heater Repair Cost': { search_data: { ranking_titles: [{ text: 'FROZEN-TITLE', scope: 'local' }] }, research: { facts: [{ claim: 'FROZEN-FACT' }] } } },
      },
      {
        titleDeps: stepDeps(m.model, kd.service),
        plannerDeps: stepDeps(m.model, kd.service),
        keywordData: kd.service,
        env: { ISEO_V3_KEYWORD_DATA: 'false' } as NodeJS.ProcessEnv,
        now: () => new Date('2026-11-11T10:00:00.000Z'),
        log: () => {},
        outDir: 'data/ab-tests',
        writeFile: async (p, c) => { written[p] = c; },
        runId: () => 'run-1',
      },
    );

    assert.equal(result.run_id, 'run-1');
    assert.equal(result.flag_env_on, false, 'the live flag was off…');
    assert.equal(result.keywords.length, 2);
    const first = result.keywords[0];
    assert.equal(first.off.title.prompt_version, 'v1');
    assert.equal(first.on.title.prompt_version, 'v2_keyword_data', '…but the ON arm still ran with keyword data');
    assert.equal(first.on.title.keyword_data_used, true);
    assert.equal(first.off.title.title, 'Title without keyword data');
    assert.equal(first.on.title.title, 'Title with keyword data');
    assert.equal(first.on.planner.demand_notes, 'Volume broke a tie.');
    assert.equal(first.off.planner.demand_notes, null);
    assert.deepEqual(first.frozen, { search_data: true, research: true });
    assert.deepEqual(result.keywords[1].frozen, { search_data: false, research: false });

    // Frozen inputs: the same fixture text reached both arms' Title and Planner.
    const kw1Calls = m.calls.slice(0, 4);
    assert.ok(kw1Calls.every((c) => c.user.includes('FROZEN-TITLE')), 'search_data frozen across arms');
    assert.ok(kw1Calls.filter((_, i) => i % 2 === 1).every((c) => c.user.includes('FROZEN-FACT')), 'research frozen across arms');
    assert.equal(m.calls.length, 8, '2 keywords × 2 arms × (title + planner)');

    // Keyword data: one prefetch per keyword; the ON arm's two steps read through tryGetForPrompt.
    assert.equal(kd.prefetches.length, 2);
    assert.deepEqual(kd.prefetches[0].slice(0, 3), ['water heater repair cost', 2840, 'en']);
    assert.equal(kd.prompts.length, 4, 'title + planner, ON arm only, per keyword');
    assert.equal(first.prefetch.cost_usd, 0.02);

    // Accounting.
    assert.equal(first.on.title.tokens.input, 100);
    assert.equal(first.on.title.model_cost_usd, null, 'no price configured → no invented dollars');
    assert.equal(result.totals.dataforseo_cost_usd, 0.04);
    assert.equal(result.totals.tokens.input, 800);
    assert.equal(result.model_prices_configured, false);

    // Files.
    assert.deepEqual(result.files, { json: 'data/ab-tests/run-1.json', csv: 'data/ab-tests/run-1.csv' });
    assert.ok(JSON.parse(written['data/ab-tests/run-1.json']).keywords.length === 2);
    const csv = written['data/ab-tests/run-1.csv'].trim().split('\n');
    assert.equal(csv[0], AB_CSV_COLUMNS.join(','));
    assert.equal(csv.length, 5, 'header + 2 keywords × 2 arms');
    assert.match(csv[1], /^run-1,water heater repair cost,off,ready,Title without keyword data,statement,v1,false,1,100,20,,/);
    assert.match(csv[2], /^run-1,water heater repair cost,on,ready,Title with keyword data,statement,v2_keyword_data,true,/);
    assert.match(csv[2], /How much\? \|\| What drives it\?/);
  });

  test('a failing step is recorded on its arm; the run continues and nothing throws', async () => {
    const m = scriptedModel({ failPlannerOn: true });
    const kd = fakeKeywordData();
    const result = await runKeywordDataAbTest(
      { keywords: ['a'] },
      { titleDeps: stepDeps(m.model, kd.service), plannerDeps: { ...stepDeps(m.model, kd.service), maxAttempts: 1 }, keywordData: kd.service, env: {} as NodeJS.ProcessEnv, log: () => {}, outDir: null },
    );
    const k = result.keywords[0];
    assert.equal(k.off.planner.ok, true);
    assert.equal(k.on.planner.ok, false);
    assert.match(k.on.planner.error ?? '', /planner exploded/);
    assert.equal(result.files, null);
  });

  test('model prices from env turn tokens into dollars; otherwise null', () => {
    assert.equal(modelPrices({} as NodeJS.ProcessEnv), null);
    assert.deepEqual(modelPrices({ AB_MODEL_PRICE_INPUT_PER_MTOK: '3', AB_MODEL_PRICE_OUTPUT_PER_MTOK: '15' } as NodeJS.ProcessEnv), { input: 3, output: 15 });
    assert.equal(modelPrices({ AB_MODEL_PRICE_INPUT_PER_MTOK: 'x' } as NodeJS.ProcessEnv), null);
  });

  test('CSV escapes commas, quotes and newlines', () => {
    const csv = abResultToCsv({
      run_id: 'r', started_at: '', finished_at: '', location_code: 2840, language_code: 'en', flag_env_on: false, model_prices_configured: false, files: null,
      totals: { dataforseo_cost_usd: 0, model_cost_usd: null, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, latency_ms: 0 },
      keywords: [{
        keyword: 'k', prefetch: { status: 'ready', source: 'cache', related_count: 0, cost_usd: 0, ms: 0 }, frozen: { search_data: false, research: false },
        off: { keyword_data: 'off', title: { ok: true, attempts: 1, attempt_log: [], tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, model_cost_usd: null, latency_ms: 0, prompt_version: 'v1', keyword_data_used: false, title: 'A, "quoted"\ntitle', form: 'statement', items: null },
          planner: { ok: true, attempts: 1, attempt_log: [], tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, model_cost_usd: null, latency_ms: 0, prompt_version: 'v1', keyword_data_used: false, article_type: 'cost', post_size: 'small', body_questions: [], faq_questions: [], demand_notes: null, overlap: null, recent_posts_sent: [] } },
        on: { keyword_data: 'on', title: { ok: false, error: 'x', attempts: 0, attempt_log: [], tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, model_cost_usd: null, latency_ms: 0, prompt_version: null, keyword_data_used: false, title: null, form: null, items: null },
          planner: { ok: false, error: 'skipped: no title', attempts: 0, attempt_log: [], tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, model_cost_usd: null, latency_ms: 0, prompt_version: null, keyword_data_used: false, article_type: null, post_size: null, body_questions: [], faq_questions: [], demand_notes: null, overlap: null, recent_posts_sent: [] } },
      }],
    });
    assert.ok(csv.includes('"A, ""quoted""\ntitle"'));
    // Header + 2 arm rows. A quoted field may hold a newline, so count row starts, not lines.
    assert.equal((csv.match(/^r,k,(off|on),/gm) ?? []).length, 2);
    assert.ok(csv.startsWith(AB_CSV_COLUMNS.join(',') + '\n'));
  });
});
