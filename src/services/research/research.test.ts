import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  competitorDenylist,
  isSkippedDomain,
  mapResearch,
  outputText,
  runResearch,
  searchResults,
  toResearchInput,
  userLocation,
  type PplxAgentResponse,
} from './research.service.js';
import { buildResearchInput, RESEARCH_INSTRUCTIONS_V1, RESEARCH_OUTPUT_SCHEMA } from './prompt.js';
import { researchConfig, DEFAULT_SKIP_DOMAINS } from '../../config/research.config.js';
import { researchBlock } from '../content-v3-steps/xml.js';

const RESULTS = [
  { id: 1, url: 'https://www.energy.gov/water-heaters', title: 'Water heaters', date: '2025-03-01' },
  { id: 2, url: 'https://nmenv.gov/permits', title: 'NM permits', date: '2026-01-10' },
  { id: 3, url: 'https://www.reddit.com/r/plumbing/x', title: 'Reddit thread', date: null, last_updated: '2026-02-02' },
  { id: 4, url: 'not-a-url', title: 'bad' },
];

function response(answer: object, results = RESULTS, cost = 0.0412): PplxAgentResponse {
  return {
    output: [
      { type: 'search_results', results },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
    ],
    usage: { input_tokens: 3000, output_tokens: 600, cost: { total_cost: cost } },
  };
}

const ANSWER = {
  facts: [
    { claim: 'Tank water heaters last 8 to 12 years.', scope: 'national', source_ids: [1], conflict: false },
    { claim: 'Made-up fact.', scope: 'general', source_ids: [99], conflict: false },
    { claim: 'A permit is required to replace a water heater in New Mexico.', scope: 'state', source_ids: [99, 2], conflict: true },
  ],
  follow_up_questions: [
    { question: 'Can I replace my own water heater?', source_ids: [3] },
    { question: 'Invented question?', source_ids: [] },
  ],
  local_conditions: [{ claim: 'Hard water is common in the Española valley.', source_ids: [2] }],
  notes: 'One price source is older than three years.',
};

describe('prompt pieces', () => {
  test('input: the doc tags in order, empties left out, scoped questions, the closing line', () => {
    const out = buildResearchInput({
      title: 'Water heater repair cost in Española',
      seed_keyword: 'water heater repair',
      language: 'US English',
      reach: 'local',
      target_town: 'Española',
      people_also_ask: [{ text: 'How much is it?', scope: 'local' }, { text: 'How long do they last?', scope: 'national' }],
    });
    assert.equal(
      out,
      [
        '<title>Water heater repair cost in Española</title>',
        '<seed_keyword>water heater repair</seed_keyword>',
        '<language>US English</language>',
        '<reach>local</reach>',
        '<target_town>Española</target_town>',
        '<people_also_ask>',
        '  <item scope="local">How much is it?</item>',
        '  <item scope="national">How long do they last?</item>',
        '</people_also_ask>',
        '',
        'Research this article.',
      ].join('\n'),
    );
  });

  test('schema mirrors the doc: four required keys and the scope enum', () => {
    assert.deepEqual(RESEARCH_OUTPUT_SCHEMA.required, ['facts', 'follow_up_questions', 'local_conditions', 'notes']);
    assert.deepEqual(RESEARCH_OUTPUT_SCHEMA.properties.facts.items.properties.scope.enum, ['local', 'state', 'national', 'general']);
    assert.ok(RESEARCH_INSTRUCTIONS_V1.startsWith('You research facts for one blog article'));
  });
});

describe('competitor filter (R4) and location (R3)', () => {
  test('local domains become a denylist; gov/edu/encyclopedia/news skipped; max 20; deduped', () => {
    const skip = [...DEFAULT_SKIP_DOMAINS];
    assert.equal(isSkippedDomain('nmenv.gov', skip), true);
    assert.equal(isSkippedDomain('extension.unm.edu', skip), true);
    assert.equal(isSkippedDomain('en.wikipedia.org', skip), true);
    assert.equal(isSkippedDomain('www.nytimes.com', skip), true);
    assert.equal(isSkippedDomain('espanolaplumbing.com', skip), false);
    const many = Array.from({ length: 30 }, (_, i) => `biz${i}.com`);
    const list = competitorDenylist(['www.espanolaplumbing.com', 'espanolaplumbing.com', 'nm.gov', 'yelp.com', ...many], skip);
    assert.equal(list[0], '-espanolaplumbing.com');
    assert.equal(list[1], '-yelp.com');
    assert.equal(list.length, 20);
    assert.ok(!list.includes('-nm.gov'));
  });

  test('user_location: city, region from the state, two-letter country', () => {
    assert.deepEqual(userLocation('Española, NM'), { city: 'Española', region: 'New Mexico', country: 'US' });
    assert.deepEqual(userLocation('Española', 'NM'), { city: 'Española', region: 'New Mexico', country: 'US' });
    assert.deepEqual(userLocation('Springfield'), { city: 'Springfield', country: 'US' });
    assert.equal(userLocation(''), null);
  });
});

describe('mapping (R5, R6, R10)', () => {
  test('unmatched sources dropped; first matching source kept; tokens S1… then local conditions continue', () => {
    const m = mapResearch(
      { ...ANSWER, facts: ANSWER.facts.map((f) => ({ ...f, scope: f.scope as any })) },
      RESULTS,
      { allowLocalConditions: true },
    );
    assert.deepEqual(m.facts.map((f) => [f.token, f.source.url]), [
      ['S1', 'https://www.energy.gov/water-heaters'],
      ['S2', 'https://nmenv.gov/permits'],
    ]);
    assert.equal(m.facts[1].conflict, true);
    assert.equal(m.follow_up_questions.length, 1);
    assert.equal(m.follow_up_questions[0].source.date, '2026-02-02', 'falls back to last_updated');
    assert.deepEqual(m.local_conditions.map((c) => c.token), ['S3']);
    assert.deepEqual(Object.keys(m.sources), ['S1', 'S2', 'S3']);
    assert.deepEqual(m.dropped, { facts: 1, questions: 1, conditions: 0 });
  });

  test('no target town → no local conditions even if returned', () => {
    const m = mapResearch({ ...ANSWER, facts: [], follow_up_questions: [] } as any, RESULTS, { allowLocalConditions: false });
    assert.equal(m.local_conditions.length, 0);
  });

  test('caps: 15 facts, 10 questions, 6 local conditions', () => {
    const facts = Array.from({ length: 20 }, (_, i) => ({ claim: `fact ${i}`, scope: 'general' as const, source_ids: [1], conflict: false }));
    const qs = Array.from({ length: 14 }, (_, i) => ({ question: `q ${i}?`, source_ids: [3] }));
    const conds = Array.from({ length: 9 }, (_, i) => ({ claim: `c ${i}`, source_ids: [2] }));
    const m = mapResearch({ facts, follow_up_questions: qs, local_conditions: conds, notes: '' }, RESULTS, { allowLocalConditions: true });
    assert.equal(m.facts.length, 15);
    assert.equal(m.follow_up_questions.length, 10);
    assert.equal(m.local_conditions.length, 6);
    assert.equal(m.local_conditions[0].token, 'S16');
  });

  test('the <research> block carries the tokens', () => {
    const m = mapResearch({ ...ANSWER, facts: ANSWER.facts as any }, RESULTS, { allowLocalConditions: true });
    const xml = researchBlock(toResearchInput(m));
    assert.match(xml, /<fact id="S1" scope="national">Tank water heaters last 8 to 12 years\.<\/fact>/);
    assert.match(xml, /<fact id="S2" scope="state" conflict="true">/);
    assert.match(xml, /<condition id="S3">Hard water is common/);
  });

  test('outputText / searchResults read the Agent API output items', () => {
    const r = response(ANSWER);
    assert.equal(JSON.parse(outputText(r)).notes, ANSWER.notes);
    assert.equal(searchResults(r).length, 4);
    assert.equal(outputText({ output_text: '{"a":1}' }), '{"a":1}');
  });
});

function fakeFetch(answers: Array<PplxAgentResponse | number | 'hang'>) {
  const calls: any[] = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === 'hang') {
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (typeof a === 'number') return new Response(JSON.stringify({ error: { message: 'secret provider detail' } }), { status: a });
    return new Response(JSON.stringify(a), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const REQ = {
  title: 'Water heater repair cost in Española',
  seed_keyword: 'water heater repair',
  language: 'US English',
  reach: 'local',
  target_town: 'Española, NM',
  people_also_ask: [{ text: 'How much is it?', scope: 'local' as const }],
  local_domains: ['espanolaplumbing.com', 'nm.gov'],
};
const CFG = { ...researchConfig({ PERPLEXITY_API_KEY: 'test-key' }), timeoutMs: 200 };

describe('runResearch', () => {
  test('request shape (R1): instructions, input, web_search with filter + user_location, json_schema, effort', async () => {
    const f = fakeFetch([response(ANSWER)]);
    const logs: string[] = [];
    const r = await runResearch(REQ, { config: CFG, fetchImpl: f.impl, log: (l) => logs.push(l), runId: 'iseo_tk_x' });
    assert.equal(r.status, 'ok');
    assert.equal(f.calls[0].url, 'https://api.perplexity.ai/v1/agent');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer test-key');
    const body = f.calls[0].body;
    assert.equal(body.instructions, RESEARCH_INSTRUCTIONS_V1);
    assert.match(body.input, /^<title>Water heater repair cost in Española<\/title>/);
    assert.match(body.input, /<target_town>Española, NM<\/target_town>/);
    assert.equal(body.effort, 'low');
    assert.deepEqual(body.tools, [{ type: 'web_search', max_results: 20, filters: { search_domain_filter: ['-espanolaplumbing.com'] }, user_location: { city: 'Española', region: 'New Mexico', country: 'US' } }]);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.name, 'research');
    assert.equal(r.cost_usd, 0.0412);
    assert.equal(r.research!.facts.length, 2);
    assert.match(logs.join('\n'), /\[model-call\] step=research model=perplexity:low prompt=content_v3_research@code#\w{8} attempt=1\/3 outcome=ok in=3000 out=600 .*cost_usd=0\.041200/);
    assert.match(logs.join('\n'), /\[research\] run=iseo_tk_x facts=2 questions=1 local_conditions=1 dropped=1\/1\/0/);
    assert.doesNotMatch(logs.join('\n'), /test-key|Tank water heaters/);
  });

  test('nationwide: no user_location, no target town in the input, no local conditions', async () => {
    const f = fakeFetch([response(ANSWER)]);
    const r = await runResearch({ ...REQ, reach: 'nationwide' }, { config: CFG, fetchImpl: f.impl, log: () => {} });
    assert.equal(f.calls[0].body.tools[0].user_location, undefined);
    assert.doesNotMatch(f.calls[0].body.input, /target_town/);
    assert.equal(r.research!.local_conditions.length, 0);
  });

  test('R7: unreadable, HTTP error and timeout each count; after 3 the run continues without research', async () => {
    const bad: PplxAgentResponse = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] };
    const f = fakeFetch([bad, 503, 'hang']);
    const logs: string[] = [];
    const r = await runResearch(REQ, { config: CFG, fetchImpl: f.impl, log: (l) => logs.push(l) });
    assert.equal(r.status, 'failed');
    assert.equal(r.research, null);
    assert.equal(r.attempts, 3);
    assert.match(logs.join('\n'), /\[research\] failed .* continuing without research/);
    assert.doesNotMatch(logs.join('\n'), /secret provider detail/);
  });

  test('R7: the spend of failed attempts is recorded, not zero', async () => {
    const bad = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }], usage: { input_tokens: 3000, output_tokens: 600, cost: { total_cost: 0.03 } } } as PplxAgentResponse;
    const f = fakeFetch([bad, bad, bad]);
    const logs: string[] = [];
    const r = await runResearch(REQ, { config: CFG, fetchImpl: f.impl, log: (l) => logs.push(l) });
    assert.equal(r.status, 'failed');
    assert.equal(r.cost_usd, 0.09);
    assert.match(logs.join('\n'), /\[research\] failed run=- attempts=3 cost_usd=0\.09 /);
  });

  test('R3: the town\'s country follows the search data country (SEARCH_DATA_COUNTRY_ISO)', async () => {
    const f = fakeFetch([response(ANSWER)]);
    await runResearch(REQ, { config: CFG, fetchImpl: f.impl, log: () => {}, countryIso: 'ca' });
    assert.equal(f.calls[0].body.tools[0].user_location.country, 'CA');
  });

  test('a retry succeeds on the second attempt', async () => {
    const f = fakeFetch([500, response(ANSWER)]);
    const r = await runResearch(REQ, { config: CFG, fetchImpl: f.impl, log: () => {} });
    assert.equal(r.status, 'ok');
    assert.equal(r.attempts, 2);
  });

  test('no PERPLEXITY_API_KEY: skipped, no request, run continues', async () => {
    const f = fakeFetch([response(ANSWER)]);
    const r = await runResearch(REQ, { config: researchConfig({}), fetchImpl: f.impl, log: () => {} });
    assert.equal(r.status, 'not_configured');
    assert.equal(f.calls.length, 0);
  });

  test('config: effort and model from env, unknown effort falls back to low', () => {
    assert.equal(researchConfig({ PERPLEXITY_EFFORT: 'high' }).effort, 'high');
    assert.equal(researchConfig({ PERPLEXITY_EFFORT: 'turbo' }).effort, 'low');
    assert.equal(researchConfig({ PERPLEXITY_MODEL: 'x/y' }).model, 'x/y');
    assert.ok(researchConfig({ RESEARCH_FILTER_SKIP_DOMAINS: 'angi.com, www.homeadvisor.com' }).skipDomains.includes('homeadvisor.com'));
  });
});
