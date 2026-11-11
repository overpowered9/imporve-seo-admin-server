/**
 * The Planner step with a scripted model, the in-code prompts and a fake keyword data service.
 *
 * What is being protected, beyond what title.step.test.ts covers for the shared gating:
 *  1. With V1, neither <keyword_data> nor <recent_posts> is sent and demand_notes/overlap are
 *     forced to null in the output, whatever the model returned.
 *  2. With V2, recent posts are chosen IN CODE (overlap score ≥ 0.2, top 5) and only those ids are
 *     valid in `overlap`; 30 related keywords are requested.
 *  3. The doc's code checks (size floor, FAQ/body rules, owner questions) and the contract's
 *     (demand_notes, overlap) each reject an attempt and trigger the retry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPlannerStep, buildPlannerUserMessage, normalizePlannerOutput, validatePlannerOutput } from './planner.step.js';
import { PLANNER_SYSTEM_V1, PLANNER_SYSTEM_V2_KEYWORD_DATA, fallbackStepPromptResolver } from './prompts.js';
import type { KeywordDataService, PromptKeywordData } from '../keyword-data/keyword-data.service.js';
import type { ModelCall, StepDeps } from './step-common.js';

const ON = { ISEO_V3_KEYWORD_DATA: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const USAGE = { input_tokens: 10, output_tokens: 5 };

const PLAN = {
  article_type: 'cost',
  type_reason: 'The title asks what it costs.',
  post_size: 'medium',
  size_reason: 'Medium: five separate questions to answer.',
  body_questions: ['How much does water heater repair cost?', 'What drives the price up or down?'],
  faq_questions: ['Is it worth repairing an old water heater?'],
  searcher_profile: { situation: 'tank is leaking', main_concern: 'cost', desired_outcome: 'hot water back', readiness: 'comparing', their_words: ['leaking from the bottom'], reassurance: 'a realistic range' },
  ideal_client_gap: '',
  owner_questions: ['What does a typical repair cost you?'],
  regulated_topic: false,
  regulated_reason: '',
};
const PLAN_WITH_OVERLAP = { ...PLAN, demand_notes: 'Volume broke one tie between two FAQ questions.', overlap: { post_id: 2, reason: 'Same main question as post 2.' } };
const j = (o: unknown) => JSON.stringify(o);

const INPUT = {
  title: 'Water heater repair cost in Española: what drives the price',
  seed_keyword: 'water heater repair cost',
  language: 'English (US)',
  niche: 'plumbing',
  research: { facts: [{ claim: 'Average repair is $150–$700', scope: 'national' as const }] },
  recent_posts: [
    { post_id: 1, title: 'Best plumbers in Española' },
    { post_id: 2, title: 'How much does water heater repair cost?' },
    { post_id: 3, title: 'Tankless water heater installation' },
  ],
};

const BLOCK = '<keyword_data scope="national" location="United States">\nseed: water heater repair cost | volume 2400\nrelated:\n- water heater replacement cost | volume 1900\n</keyword_data>';
const promptData = (): PromptKeywordData => ({
  block: BLOCK,
  seed: { keyword: 'water heater repair cost', search_volume: 2400, keyword_difficulty: null, intent: null, scope: 'national', fetched_at: '2026-11-11T10:00:00.000Z' },
  related: [{ keyword: 'water heater replacement cost', search_volume: 1900, keyword_difficulty: null, intent: null, scope: 'national', fetched_at: '2026-11-11T10:00:00.000Z' }],
  source: 'dataforseo',
});

function fakeModel(outputs: Array<string | Error>) {
  const calls: Array<{ system: string; user: string }> = [];
  const model: ModelCall = async (opts) => {
    calls.push(opts);
    const next = outputs.shift();
    if (next === undefined) throw new Error('fakeModel: no more outputs');
    if (next instanceof Error) throw next;
    return { text: next, usage: USAGE };
  };
  return { model, calls };
}
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
function deps(model: ModelCall, keywordData: KeywordDataService | null, env: NodeJS.ProcessEnv): StepDeps {
  return { model, resolvePrompt: fallbackStepPromptResolver, keywordData, env, log: () => {}, maxAttempts: 3 };
}

describe('V1 (flag off)', () => {
  test('no keyword_data, no recent_posts, demand_notes/overlap forced null, and recent_posts does not change the payload', async () => {
    const kd = fakeKeywordData(promptData());
    const withPosts = await runPlannerStep({ ...INPUT, use_keyword_data: true }, deps(fakeModel([j(PLAN_WITH_OVERLAP)]).model, kd.service, OFF));
    const withoutPosts = await runPlannerStep({ ...INPUT, recent_posts: undefined }, deps(fakeModel([j(PLAN)]).model, kd.service, OFF));
    assert.equal(withPosts.messages.system, PLANNER_SYSTEM_V1);
    assert.equal(withPosts.messages.user, withoutPosts.messages.user);
    assert.doesNotMatch(withPosts.messages.user, /<keyword_data|<recent_posts|volume/);
    assert.equal(kd.calls.length, 0);
    assert.equal(withPosts.output.demand_notes, null);
    assert.equal(withPosts.output.overlap, null);
    assert.deepEqual(withPosts.recent_posts, { received: 3, sent: [] });
    assert.equal(withPosts.prompt.templateType, 'content_v3_planner');
  });
});

describe('V2 (flag on, data available)', () => {
  test('block + code-selected recent posts in the USER message; 30 related requested; overlap/demand_notes pass through', async () => {
    const kd = fakeKeywordData(promptData());
    const m = fakeModel([j(PLAN_WITH_OVERLAP)]);
    const r = await runPlannerStep({ ...INPUT, use_keyword_data: true }, deps(m.model, kd.service, ON));
    assert.equal(r.messages.system, PLANNER_SYSTEM_V2_KEYWORD_DATA);
    assert.ok(r.messages.user.includes(BLOCK));
    const posts = r.messages.user.slice(r.messages.user.indexOf('<recent_posts>'), r.messages.user.indexOf('</recent_posts>'));
    assert.match(posts, /<post id="2">How much does water heater repair cost\?<\/post>/);
    assert.match(posts, /<post id="3">Tankless water heater installation<\/post>/);
    assert.doesNotMatch(posts, /id="1"/, 'the Española-only post scores under the threshold');
    assert.ok(posts.indexOf('id="2"') < posts.indexOf('id="3"'), 'best score first');
    assert.ok(r.messages.user.endsWith('</recent_posts>\n\nPlan the article.'));
    assert.deepEqual(kd.calls[0].slice(3), [30, 8000]);
    assert.deepEqual(r.output.overlap, { post_id: 2, reason: 'Same main question as post 2.' });
    assert.equal(r.output.demand_notes, 'Volume broke one tie between two FAQ questions.');
    assert.deepEqual(r.recent_posts.sent.map((s) => s.post_id), [2, 3]);
    assert.ok(r.recent_posts.sent[0].score > r.recent_posts.sent[1].score);
    assert.equal(r.prompt.version, 'v2_keyword_data');
    assert.equal(r.prompt.templateType, 'content_v3_planner_keyword_data');
  });

  test('fallback (data unavailable): identical to the flag-off payload, no recent_posts, nulls', async () => {
    const base = await runPlannerStep(INPUT, deps(fakeModel([j(PLAN)]).model, fakeKeywordData(null).service, OFF));
    const r = await runPlannerStep({ ...INPUT, use_keyword_data: true }, deps(fakeModel([j(PLAN_WITH_OVERLAP)]).model, fakeKeywordData(null).service, ON));
    assert.equal(r.messages.system, PLANNER_SYSTEM_V1);
    assert.equal(r.messages.user, base.messages.user);
    assert.equal(r.output.overlap, null);
    assert.equal(r.output.demand_notes, null);
    assert.equal(r.keyword_data.effective, true);
    assert.equal(r.keyword_data.used, false);
  });

  test('an overlap naming a post that was not sent is rejected and retried', async () => {
    const m = fakeModel([j({ ...PLAN_WITH_OVERLAP, overlap: { post_id: 99, reason: 'x' } }), j(PLAN_WITH_OVERLAP)]);
    const r = await runPlannerStep({ ...INPUT, use_keyword_data: true }, deps(m.model, fakeKeywordData(promptData()).service, ON));
    assert.equal(r.attempts.length, 2);
    assert.match(r.attempts[0].reason ?? '', /invalid_overlap: post_id 99 was not in recent_posts/);
    assert.equal(r.output.overlap?.post_id, 2);
  });

  test('demand_notes over 240 characters is rejected and retried; null is fine', async () => {
    const m = fakeModel([j({ ...PLAN_WITH_OVERLAP, demand_notes: 'x'.repeat(241) }), j({ ...PLAN_WITH_OVERLAP, demand_notes: null, overlap: null })]);
    const r = await runPlannerStep({ ...INPUT, use_keyword_data: true }, deps(m.model, fakeKeywordData(promptData()).service, ON));
    assert.match(r.attempts[0].reason ?? '', /invalid_demand_notes: 241 chars/);
    assert.equal(r.output.demand_notes, null);
    assert.equal(r.output.overlap, null);
  });
});

describe("the doc's code checks", () => {
  test('post_size below minimum_size is rejected, then the compliant retry is used', async () => {
    const m = fakeModel([j({ ...PLAN, post_size: 'small' }), j(PLAN)]);
    const r = await runPlannerStep({ ...INPUT, minimum_size: 'medium' }, deps(m.model, null, OFF));
    assert.match(r.attempts[0].reason ?? '', /post_size_below_minimum: small < medium/);
    assert.equal(r.output.post_size, 'medium');
  });

  test('each rule rejects', () => {
    const ctx = { minimumSize: 'small' as const, keywordDataInEffect: false, sentPostIds: new Set<number>() };
    const base = normalizePlannerOutput(PLAN);
    assert.equal(validatePlannerOutput(base, ctx), null);
    assert.match(validatePlannerOutput({ ...base, article_type: 'listicle' as any }, ctx) ?? '', /invalid_article_type/);
    assert.match(validatePlannerOutput({ ...base, post_size: 'huge' as any }, ctx) ?? '', /invalid_post_size/);
    assert.match(validatePlannerOutput({ ...base, body_questions: Array.from({ length: 10 }, (_, i) => `q${i}`) }, ctx) ?? '', /too_many_body_questions: 10/);
    assert.match(validatePlannerOutput({ ...base, faq_questions: ['1', '2', '3', '4', '5', '6'] }, ctx) ?? '', /too_many_faq_questions: 6/);
    assert.match(validatePlannerOutput({ ...base, faq_questions: ['How much does water heater repair cost'] }, ctx) ?? '', /faq_repeats_body_question/);
    assert.match(validatePlannerOutput({ ...base, owner_questions: ['a', 'b', 'c'] }, ctx) ?? '', /too_many_owner_questions: 3/);
    const v2 = { ...ctx, keywordDataInEffect: true, sentPostIds: new Set([2]) };
    assert.match(validatePlannerOutput({ ...base, overlap: { post_id: 2, reason: '' } }, v2) ?? '', /reason is empty/);
    assert.match(validatePlannerOutput({ ...base, overlap: { post_id: NaN, reason: 'x' } }, v2) ?? '', /not an integer/);
    assert.equal(validatePlannerOutput({ ...base, overlap: { post_id: 2, reason: 'dup' }, demand_notes: 'one line' }, v2), null);
    // With V1 the two contract fields are not judged at all.
    assert.equal(validatePlannerOutput({ ...base, overlap: { post_id: 99, reason: '' }, demand_notes: 'x'.repeat(500) }, ctx), null);
  });

  test('normalizePlannerOutput coerces loosely and never throws on shapes', () => {
    const o = normalizePlannerOutput({
      article_type: 'Cost',
      post_size: 'MEDIUM',
      body_questions: ['a', 3, '  ', 'b'],
      faq_questions: 'nope',
      searcher_profile: { readiness: 'Comparing', their_words: Array.from({ length: 12 }, (_, i) => `w${i}`) },
      owner_questions: null,
      regulated_topic: 'yes',
      demand_notes: '   ',
      overlap: 'post 2',
    });
    assert.equal(o.article_type, 'cost');
    assert.equal(o.post_size, 'medium');
    assert.deepEqual(o.body_questions, ['a', 'b']);
    assert.deepEqual(o.faq_questions, []);
    assert.equal(o.searcher_profile.readiness, 'comparing');
    assert.equal(o.searcher_profile.their_words.length, 8);
    assert.equal(o.regulated_topic, null);
    assert.equal(o.demand_notes, null);
    assert.ok(Number.isNaN(o.overlap?.post_id));
    assert.throws(() => normalizePlannerOutput('text'), /not a JSON object/);
  });
});

describe('user message', () => {
  test('size table and minimum default, research rendered, closing instruction last', () => {
    const u = buildPlannerUserMessage(INPUT, null, []);
    assert.ok(u.startsWith('<title>Water heater repair cost in Española: what drives the price</title>\n<seed_keyword>water heater repair cost</seed_keyword>'));
    assert.ok(u.includes('<research>\n  <facts>\n    <fact id="S1" scope="national">Average repair is $150–$700</fact>\n  </facts>\n</research>'));
    assert.ok(u.includes('<size_options>small: 600 to 1200 words | medium: 1200 to 2400 words | large: 2400 to 3600 words</size_options>'));
    assert.ok(u.includes('<minimum_size>small</minimum_size>'));
    assert.ok(u.endsWith('\n\nPlan the article.'));
    const custom = buildPlannerUserMessage({ ...INPUT, size_options: { medium: '1000 to 2000 words' }, minimum_size: 'medium' }, null, []);
    assert.ok(custom.includes('medium: 1000 to 2000 words'));
    assert.ok(custom.includes('<minimum_size>medium</minimum_size>'));
  });
});
