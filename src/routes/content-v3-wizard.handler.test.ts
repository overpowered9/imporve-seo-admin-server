import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, fakePluginAuth, PLUGIN_HEADERS, type TestApp } from '../test/helpers/http-app.js';
import { createContentV3WizardRouter, MAX_LIST_ITEMS, addCost } from './content-v3-wizard.handler.js';
import { createMemoryContentV3Store } from '../services/content-v3/store.js';
import { StepFailedError } from '../services/content-v3-steps/attempts.js';
import type { TitleStepInput, TitleStepResult } from '../services/content-v3-steps/title.step.js';
import { staticLocationIndexProvider } from '../services/search-data/locations.js';
import { buildLocationIndex } from '../services/search-data/towns.js';
import type { CachedSearchData } from '../services/search-data/search-data.default.js';

const KEY = 'iseo_tk_0123456789abcdef0123456789abcdef';
const ON = { CONTENT_V3_ENABLED: 'true' };
const INDEX = buildLocationIndex([
  { location_code: 1, location_name: 'Espanola,New Mexico,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 2, location_name: 'Santa Fe,New Mexico,United States', country_iso_code: 'US', location_type: 'City' },
], 'us');

const SD: CachedSearchData = {
  cached: false,
  block: { location: 'Española, NM', national_fallback: false, ranking_titles: [{ text: 'A', scope: 'local' }], people_also_ask: [], related_searches: [] },
  meta: {
    mode: 'local', location_used: 'Española, NM', national_fallback: false, town_resolution: { status: 'listed', location_code: 1, location_name: 'x' },
    keyword_town: null, town_mismatch: null, calls: [], counts: { titles: 1, questions: 0, related: 0 }, local_domains: ['a.com'], cost_usd: 0.002, ms: 1,
  },
};

function titleResult(title: string): TitleStepResult {
  return {
    output: { title, form: 'statement', items: null, main_concern: 'price', page_kind: 'cost guides' },
    attempts: [{ attempt: 1, ok: true, reason: null, ms: 1, raw_length: 10 }],
    usage: [{ input_tokens: 10, output_tokens: 5 }],
    cost_usd: 0.001,
    model: 'm',
    keyword_data: { requested: false, effective: false, used: false, ms: 0 },
    prompt: { templateType: 'content_v3_title', source: 'fallback', version: 'v1', label: 'content_v3_title@code#d0881236' },
    timings: { total_ms: 1, keyword_data_ms: 0, model_ms: 1 },
    messages: { system: 'SYSTEM', user: 'USER' },
  };
}

let app: TestApp | null = null;
afterEach(async () => {
  const a = app;
  app = null;
  await a?.close();
});

async function start(opts: { env?: NodeJS.ProcessEnv; titles?: Array<string | Error>; sd?: CachedSearchData } = {}) {
  const store = createMemoryContentV3Store();
  const inputs: TitleStepInput[] = [];
  const logs: string[] = [];
  let n = 0;
  const router = createContentV3WizardRouter({
    auth: fakePluginAuth({ id: 5 }, { id: 9 }),
    rateLimit: (_req, _res, next) => next(),
    store: async () => store,
    searchData: async () => opts.sd ?? SD,
    runTitle: async (input) => {
      inputs.push(input);
      const t = (opts.titles ?? ['Water heater repair cost in Española'])[Math.min(n++, (opts.titles?.length ?? 1) - 1)];
      if (t instanceof Error) throw t;
      return titleResult(t);
    },
    locations: staticLocationIndexProvider(INDEX),
    env: opts.env ?? ON,
    log: (l) => logs.push(l),
  });
  app = await startTestApp([['/api/v1/content-v3', router]]);
  return { app, store, inputs, logs };
}

const BODY = { session_key: KEY, seed_keyword: 'water heater repair', reach: 'local', target_town: 'Española, NM', language: 'English' };

describe('POST /wizard/title', () => {
  test('409 with a plain message while CONTENT_V3_ENABLED is off; 401 without plugin auth', async () => {
    const { app } = await start({ env: {} });
    const r = await app.post('/api/v1/content-v3/wizard/title', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'v3_disabled');
    assert.equal((await app.post('/api/v1/content-v3/wizard/title', BODY)).status, 401);
  });

  test('returns only the title (W15); sends search data, town, max_list_items 15 (T3); logs the rest', async () => {
    const { app, inputs, logs, store } = await start();
    const r = await app.post('/api/v1/content-v3/wizard/title', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.title, 'Water heater repair cost in Española');
    assert.equal(r.body.data.form, undefined);
    assert.equal(r.body.data.main_concern, undefined);
    assert.equal(inputs[0].target_town, 'Española');
    assert.equal(inputs[0].max_list_items, MAX_LIST_ITEMS);
    assert.deepEqual(inputs[0].previous_titles, []);
    assert.equal(inputs[0].search_data?.location, 'Española, NM');
    assert.match(logs.join('\n'), /\[content-v3\] title run=iseo_tk_\w+ form=statement items=- page_kind="cost guides" main_concern="price"/);
    const s = await store.getSession(5, 9, KEY);
    assert.deepEqual((s!.titles as any).list, ['Water heater repair cost in Española']);
    assert.equal((s!.title_step as any).form, 'statement');
    assert.deepEqual(s!.cost, { search_data: 0.002, title: 0.001 });
  });

  test('Regenerate sends the titles already shown for this keyword (W12); a new keyword starts fresh', async () => {
    const { app, inputs } = await start({ titles: ['First title', 'Second title', 'Third title'] });
    await app.post('/api/v1/content-v3/wizard/title', BODY, PLUGIN_HEADERS);
    await app.post('/api/v1/content-v3/wizard/title', { ...BODY, regenerate: true }, PLUGIN_HEADERS);
    assert.deepEqual(inputs[1].previous_titles, ['First title']);
    await app.post('/api/v1/content-v3/wizard/title', { ...BODY, seed_keyword: 'tankless heater', regenerate: true }, PLUGIN_HEADERS);
    assert.deepEqual(inputs[2].previous_titles, []);
  });

  test('nationwide or "Not about a specific location": no target_town in the prompt data', async () => {
    const { app, inputs } = await start();
    await app.post('/api/v1/content-v3/wizard/title', { ...BODY, reach: 'nationwide' }, PLUGIN_HEADERS);
    await app.post('/api/v1/content-v3/wizard/title', { ...BODY, target_town: '', not_about_location: true }, PLUGIN_HEADERS);
    assert.equal(inputs[0].target_town, undefined);
    assert.equal(inputs[1].target_town, undefined);
  });

  test('after 3 failed attempts: 200, empty title, a plain message (T6)', async () => {
    const failed = new StepFailedError('title', [1, 2, 3].map((a) => ({ attempt: a, ok: false, reason: 'title_too_long: 81 chars', ms: 1, raw_length: 1 })));
    const { app } = await start({ titles: [failed] });
    const r = await app.post('/api/v1/content-v3/wizard/title', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.title, '');
    assert.equal(r.body.data.failed, true);
    assert.match(r.body.data.message, /Type your own title/);
  });

  test('a provider error is a plain message, never the raw text', async () => {
    const { app } = await start({ titles: [Object.assign(new Error('529 overloaded_error {"type":"error"}'), { status: 529 })] });
    const r = await app.post('/api/v1/content-v3/wizard/title', BODY, PLUGIN_HEADERS);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'service_unavailable');
    assert.doesNotMatch(r.body.message, /529|overloaded/);
  });

  test('the town check comes back with the title (W6)', async () => {
    const { app } = await start({ sd: { ...SD, meta: { ...SD.meta, town_mismatch: { keyword_town: 'santa fe', target_town: 'Española' } } } });
    const r = await app.post('/api/v1/content-v3/wizard/title', { ...BODY, seed_keyword: 'roof repair santa fe' }, PLUGIN_HEADERS);
    assert.deepEqual(r.body.data.town_check, { keyword_town: 'santa fe', target_town: 'Española' });
  });

  test('validation: no keyword is a plain 400', async () => {
    const { app } = await start();
    const r = await app.post('/api/v1/content-v3/wizard/title', { ...BODY, seed_keyword: '   ' }, PLUGIN_HEADERS);
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Please enter a seed keyword.');
  });
});

describe('POST /wizard/town-check', () => {
  test('another town in the keyword → one line; the chosen town or none → null', async () => {
    const { app } = await start();
    const a = await app.post('/api/v1/content-v3/wizard/town-check', { seed_keyword: 'roof repair santa fe', target_town: 'Española, NM' }, PLUGIN_HEADERS);
    assert.deepEqual(a.body.data.town_check, { keyword_town: 'santa fe', target_town: 'Española' });
    const b = await app.post('/api/v1/content-v3/wizard/town-check', { seed_keyword: 'roof repair espanola', target_town: 'Española, NM' }, PLUGIN_HEADERS);
    assert.equal(b.body.data.town_check, null);
    const c = await app.post('/api/v1/content-v3/wizard/town-check', { seed_keyword: 'roof repair', target_town: null }, PLUGIN_HEADERS);
    assert.equal(c.body.data.town_check, null);
  });
});

test('addCost accumulates per step', () => {
  assert.deepEqual(addCost(addCost(undefined, 'title', 0.001), 'title', 0.0015), { title: 0.0025 });
});
