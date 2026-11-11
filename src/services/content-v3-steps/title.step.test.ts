/**
 * The Title step with a scripted model, the in-code prompts and a fake keyword data service.
 *
 * What is being protected:
 *  1. Flag off (env unset, or request not opted in): V1 system prompt, no <keyword_data>, the
 *     keyword service is never consulted, and use_keyword_data:true changes NOTHING in the payload.
 *  2. Flag on + opted in + data available: V2 system prompt, the block in the USER message only,
 *     10 related keywords requested under the 8 s budget.
 *  3. Flag on but data unavailable (or not configured): byte-identical to flag off, with the
 *     fallback recorded.
 *  4. Code checks: a title over 70 characters, unreadable JSON or a bad form is a failed attempt,
 *     up to 3 attempts, every attempt's usage kept.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runTitleStep, buildTitleUserMessage, validateTitleOutput, normalizeTitleOutput } from './title.step.js';
import { TITLE_SYSTEM_V1, TITLE_SYSTEM_V2_KEYWORD_DATA, fallbackStepPromptResolver } from './prompts.js';
import { StepFailedError } from './attempts.js';
import type { KeywordDataService, PromptKeywordData } from '../keyword-data/keyword-data.service.js';
import type { ModelCall, StepDeps } from './step-common.js';

const ON = { ISEO_V3_KEYWORD_DATA: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const USAGE = { input_tokens: 10, output_tokens: 5 };

const GOOD = JSON.stringify({
  title: 'Water heater repair cost in Española: what drives the price',
  form: 'statement',
  items: null,
  main_concern: 'what it will cost',
  page_kind: 'cost breakdowns',
});

function fakeModel(outputs: Array<string | Error>) {
  const calls: Array<{ system: string; user: string; model?: string; maxTokens?: number }> = [];
  const model: ModelCall = async (opts) => {
    calls.push(opts);
    const next = outputs.shift();
    if (next === undefined) throw new Error('fakeModel: no more outputs');
    if (next instanceof Error) throw next;
    return { text: next, usage: USAGE };
  };
  return { model, calls };
}

const BLOCK =
  '<keyword_data scope="national" location="United States">\n' +
  'seed: water heater repair cost | volume 2400 | difficulty 18 | intent commercial\n' +
  'related:\n' +
  '- water heater replacement cost | volume 1900 | difficulty 22 | intent commercial\n' +
  '</keyword_data>';

const promptData = (): PromptKeywordData => ({
  block: BLOCK,
  seed: { keyword: 'water heater repair cost', search_volume: 2400, keyword_difficulty: 18, intent: 'commercial', scope: 'national', fetched_at: '2026-11-11T10:00:00.000Z' },
  related: [{ keyword: 'water heater replacement cost', search_volume: 1900, keyword_difficulty: 22, intent: 'commercial', scope: 'national', fetched_at: '2026-11-11T10:00:00.000Z' }],
  source: 'cache',
});

function fakeKeywordData(result: PromptKeywordData | null) {
  const calls: any[][] = [];
  const service = {
    configured: true,
    getMetrics: async () => { throw new Error('unused'); },
    getSeedWithRelated: async () => { throw new Error('unused'); },
    tryGetForPrompt: async (...args: any[]) => { calls.push(args); return result; },
  } as unknown as KeywordDataService;
  return { service, calls };
}

function deps(model: ModelCall, keywordData: KeywordDataService | null, env: NodeJS.ProcessEnv, logs: string[] = []): StepDeps {
  return { model, resolvePrompt: fallbackStepPromptResolver, keywordData, env, log: (l) => logs.push(l), maxAttempts: 3, modelName: 'test-model' };
}

const INPUT = {
  seed_keyword: 'water heater repair cost',
  language: 'English (US)',
  niche: 'plumbing',
  reach: 'local',
  target_town: 'Española',
  search_data: { location: 'Española, NM', ranking_titles: [{ text: 'Water heater repair cost guide', scope: 'local' as const }] },
  max_list_items: 7,
  previous_titles: ['Old title'],
};

describe('keyword data gating', () => {
  test('flag off: V1 prompt, no block, service never consulted — and opting in changes nothing', async () => {
    const kd = fakeKeywordData(promptData());
    const a = await runTitleStep(INPUT, deps(fakeModel([GOOD]).model, kd.service, OFF));
    const b = await runTitleStep({ ...INPUT, use_keyword_data: true }, deps(fakeModel([GOOD]).model, kd.service, OFF));
    assert.equal(a.messages.system, TITLE_SYSTEM_V1);
    assert.equal(b.messages.system, TITLE_SYSTEM_V1);
    assert.equal(a.messages.user, b.messages.user, 'byte-identical payload with the flag off');
    assert.doesNotMatch(a.messages.user, /<keyword_data|volume/);
    assert.equal(kd.calls.length, 0);
    assert.deepEqual(b.keyword_data, { requested: true, effective: false, used: false, ms: 0 });
    assert.equal(a.prompt.version, 'v1');
    assert.equal(a.prompt.templateType, 'content_v3_title');
  });

  test('flag on + opted in + data: V2 prompt, block in the USER message, 10 related under the 8 s budget', async () => {
    const kd = fakeKeywordData(promptData());
    const m = fakeModel([GOOD]);
    const r = await runTitleStep({ ...INPUT, use_keyword_data: true, location_code: 2826, language_code: 'en' }, deps(m.model, kd.service, ON));
    assert.equal(r.messages.system, TITLE_SYSTEM_V2_KEYWORD_DATA);
    assert.equal(m.calls[0].system, TITLE_SYSTEM_V2_KEYWORD_DATA);
    assert.equal(m.calls[0].model, 'test-model');
    assert.ok(r.messages.user.includes(BLOCK));
    assert.ok(r.messages.user.endsWith('</keyword_data>\n\nWrite the title.'));
    assert.ok(r.messages.user.indexOf('</previous_titles>') < r.messages.user.indexOf('<keyword_data'), 'block comes after the other data tags');
    assert.doesNotMatch(r.messages.system, /2400|1900/, 'numbers never enter the system prompt');
    assert.deepEqual(kd.calls[0], ['water heater repair cost', 2826, 'en', 10, 8000]);
    assert.equal(r.keyword_data.used, true);
    assert.equal(r.keyword_data.source, 'cache');
    assert.equal(r.keyword_data.related_count, 1);
    assert.equal(r.prompt.version, 'v2_keyword_data');
    assert.equal(r.prompt.templateType, 'content_v3_title_keyword_data');
  });

  test('flag on but data unavailable: exactly the flag-off payload, with the fallback recorded', async () => {
    const base = await runTitleStep(INPUT, deps(fakeModel([GOOD]).model, fakeKeywordData(null).service, OFF));
    const kd = fakeKeywordData(null);
    const r = await runTitleStep({ ...INPUT, use_keyword_data: true }, deps(fakeModel([GOOD]).model, kd.service, ON));
    assert.equal(kd.calls.length, 1);
    assert.equal(r.messages.system, TITLE_SYSTEM_V1);
    assert.equal(r.messages.user, base.messages.user);
    assert.equal(r.keyword_data.requested, true);
    assert.equal(r.keyword_data.effective, true);
    assert.equal(r.keyword_data.used, false);
    assert.equal(r.keyword_data.reason, 'unavailable');
    assert.equal(r.prompt.version, 'v1');
  });

  test('flag on but no keyword data service wired: reason not_configured, V1, logged', async () => {
    const logs: string[] = [];
    const r = await runTitleStep({ ...INPUT, use_keyword_data: true }, deps(fakeModel([GOOD]).model, null, ON, logs));
    assert.equal(r.messages.system, TITLE_SYSTEM_V1);
    assert.equal(r.keyword_data.reason, 'not_configured');
    assert.match(logs.join('\n'), /\[keyword-data\] fallback step=title seed="water heater repair cost" reason=not_configured/);
  });

  test('a string "true" does not opt in', async () => {
    const kd = fakeKeywordData(promptData());
    const r = await runTitleStep({ ...INPUT, use_keyword_data: 'true' as unknown as boolean }, deps(fakeModel([GOOD]).model, kd.service, ON));
    assert.equal(r.keyword_data.effective, false);
    assert.equal(kd.calls.length, 0);
  });
});

describe('user message', () => {
  test('tags in the doc order, empty tags left out, closing instruction last', () => {
    assert.equal(buildTitleUserMessage({ seed_keyword: 'x', niche: '', target_town: undefined, previous_titles: [] }, null), '<seed_keyword>x</seed_keyword>\n\nWrite the title.');
    const u = buildTitleUserMessage(INPUT, null);
    const order = ['<seed_keyword>', '<language>', '<niche>', '<reach>', '<target_town>', '<search_data location="Española, NM">', '<max_list_items>7</max_list_items>', '<previous_titles>'];
    let last = -1;
    for (const t of order) {
      const i = u.indexOf(t);
      assert.ok(i > last, `${t} in order`);
      last = i;
    }
    assert.ok(u.includes('<previous_titles>\n  <title>Old title</title>\n</previous_titles>'));
    assert.doesNotMatch(u, /<proof_level>|<ideal_client>|<featured_service>/);
    assert.ok(u.endsWith('\n\nWrite the title.'));
  });
});

describe('code checks and retries', () => {
  const LONG = JSON.stringify({ title: 'A'.repeat(71), form: 'statement', items: null, main_concern: '', page_kind: '' });

  test('a title over 70 characters is a failed attempt; the retry is used and both usages are kept', async () => {
    const m = fakeModel([LONG, GOOD]);
    const r = await runTitleStep(INPUT, deps(m.model, null, OFF));
    assert.equal(m.calls.length, 2);
    assert.equal(r.attempts.length, 2);
    assert.match(r.attempts[0].reason ?? '', /title_too_long: 71 chars/);
    assert.equal(r.attempts[1].ok, true);
    assert.equal(r.output.title, 'Water heater repair cost in Española: what drives the price');
    assert.equal(r.usage.length, 2);
    assert.equal(m.calls[0].user, m.calls[1].user, 'same inputs on every attempt');
  });

  test('unreadable JSON and an invalid form are failed attempts', async () => {
    const m = fakeModel(['I cannot help with that.', JSON.stringify({ title: 'x', form: 'poem' }), GOOD]);
    const r = await runTitleStep(INPUT, deps(m.model, null, OFF));
    assert.match(r.attempts[0].reason ?? '', /unreadable_json/);
    assert.match(r.attempts[1].reason ?? '', /invalid_form: poem/);
    assert.equal(r.attempts[2].ok, true);
  });

  test('three failures throw StepFailedError carrying the attempt log', async () => {
    const m = fakeModel([new Error('api down'), 'nope', LONG]);
    const err = await runTitleStep(INPUT, deps(m.model, null, OFF)).catch((e) => e);
    assert.ok(err instanceof StepFailedError);
    assert.equal(err.step, 'title');
    assert.equal(err.attempts.length, 3);
    assert.match(err.attempts[0].reason ?? '', /call_failed: api down/);
    assert.match(err.attempts[1].reason ?? '', /unreadable_json/);
    assert.match(err.attempts[2].reason ?? '', /title_too_long/);
  });

  test('validateTitleOutput: numbered form needs items, within max_list_items', () => {
    const base = { title: 'Seven signs', main_concern: '', page_kind: '' };
    assert.equal(validateTitleOutput({ ...base, form: 'numbered', items: null }, {}), 'numbered_without_items');
    assert.equal(validateTitleOutput({ ...base, form: 'numbered', items: 9 }, { max_list_items: 7 }), 'items_exceed_max_list_items: 9 > 7');
    assert.equal(validateTitleOutput({ ...base, form: 'numbered', items: 5 }, { max_list_items: 7 }), null);
    assert.equal(validateTitleOutput({ ...base, form: 'statement', items: 0 }, {}), 'invalid_items');
    assert.equal(validateTitleOutput({ ...base, title: '', form: 'statement', items: null }, {}), 'empty_title');
  });

  test('normalizeTitleOutput coerces form case and numeric strings, rejects non-objects', () => {
    const o = normalizeTitleOutput({ title: '  Seven   signs ', form: 'Numbered', items: '7' });
    assert.deepEqual(o, { title: 'Seven signs', form: 'numbered', items: 7, main_concern: '', page_kind: '' });
    assert.throws(() => normalizeTitleOutput(['x']), /not a JSON object/);
    assert.throws(() => normalizeTitleOutput(null), /not a JSON object/);
  });
});
