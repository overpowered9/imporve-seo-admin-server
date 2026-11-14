/**
 * The step system prompts: V1 is the design doc byte for byte, V2 is V1 plus exactly the contract's
 * keyword-data rules, and the V1 texts know nothing about keyword data.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  TITLE_SYSTEM_V1,
  TITLE_SYSTEM_V2_KEYWORD_DATA,
  TITLE_KEYWORD_DATA_SECTION,
  PLANNER_SYSTEM_V1,
  PLANNER_SYSTEM_V2_KEYWORD_DATA,
  PLANNER_KEYWORD_DATA_SECTION,
  PLANNER_KEYWORD_DATA_JSON_SENTENCE,
  V3_STEP_PROMPT_DEFS,
  fallbackStepPromptResolver,
} from './prompts.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// sha256 of the fenced "System prompt" blocks of PROMPT 1 and PROMPT 3 in
// docs/content-v3-prompt-drafts.md (2026-11-11 copy). Change these only with a new doc revision.
const DOC_TITLE_SHA = 'd0881236521221e777c1c44b2163ced47d4b1ec96c8f88699fae9de38f40e487';
const DOC_PLANNER_SHA = '85e5204b3fad2737dbc09bbc79e35eb3cfddd169b66614a9199cfdf9a7379ee7';

describe('V1 = the design doc', () => {
  test('Title V1 is PROMPT 1, byte for byte', () => {
    assert.equal(sha(TITLE_SYSTEM_V1), DOC_TITLE_SHA);
  });
  test('Planner V1 is PROMPT 3, byte for byte', () => {
    assert.equal(sha(PLANNER_SYSTEM_V1), DOC_PLANNER_SHA);
  });
  test('V1 prompts never mention keyword data, recent posts, demand notes or overlap', () => {
    for (const p of [TITLE_SYSTEM_V1, PLANNER_SYSTEM_V1]) {
      assert.doesNotMatch(p, /keyword_data|recent_posts|demand_notes|overlap|search volume/i);
    }
  });
});

describe('V2 = V1 + exactly the contract rules', () => {
  const TITLE_RULES = [
    'Use keyword_data only to choose between wordings that mean the same thing; prefer the wording with higher search volume.',
    "Never change the title's angle or topic because of volume.",
    'Never put numbers from keyword_data in the title.',
    'All volumes are national; never imply local demand.',
  ];
  const PLANNER_RULES = [
    'Questions come only from People Also Ask, related searches and research. Never create a question from keyword_data.',
    'Rank questions by substance first; use search volume only to break ties between equally useful questions.',
    'Never drop a substantive question because its volume is low or missing.',
    "If the article's main question duplicates a post in recent_posts, set overlap to that post_id and give a one-sentence reason; otherwise set overlap to null.",
    'demand_notes: at most one sentence on how search demand affected the ranking, or null.',
  ];

  test('Title V2 carries the four rules, before BEFORE YOU ANSWER, and nothing else changes', () => {
    for (const rule of TITLE_RULES) assert.ok(TITLE_SYSTEM_V2_KEYWORD_DATA.includes(rule), rule);
    // T9 (C6): V1 byte for byte, then one appended block.
    assert.ok(TITLE_SYSTEM_V2_KEYWORD_DATA.startsWith(TITLE_SYSTEM_V1));
    assert.equal(TITLE_SYSTEM_V2_KEYWORD_DATA.slice(TITLE_SYSTEM_V1.length), `\n\n${TITLE_KEYWORD_DATA_SECTION.trimEnd()}`);
    assert.notEqual(TITLE_SYSTEM_V2_KEYWORD_DATA, TITLE_SYSTEM_V1);
  });

  test('Planner V2 carries the five rules as section 7 and adds demand_notes and overlap to the OUTPUT JSON', () => {
    for (const rule of PLANNER_RULES) assert.ok(PLANNER_SYSTEM_V2_KEYWORD_DATA.includes(rule), rule);
    // P6 (C6): V1 byte for byte, then the contract's rules and ONE new sentence naming the JSON fields.
    assert.ok(PLANNER_SYSTEM_V2_KEYWORD_DATA.startsWith(PLANNER_SYSTEM_V1));
    assert.equal(
      PLANNER_SYSTEM_V2_KEYWORD_DATA.slice(PLANNER_SYSTEM_V1.length),
      `\n\n${PLANNER_KEYWORD_DATA_SECTION.trimEnd()}\n${PLANNER_KEYWORD_DATA_JSON_SENTENCE}`,
    );
    assert.ok(PLANNER_SYSTEM_V2_KEYWORD_DATA.includes('"demand_notes": "one sentence, or null"'));
    assert.ok(PLANNER_SYSTEM_V2_KEYWORD_DATA.includes('"overlap": {"post_id": the post_id from recent_posts, "reason": "one sentence"} or null'));
  });

  test('both V2 prompts keep the doc\'s own output contract line', () => {
    assert.ok(TITLE_SYSTEM_V2_KEYWORD_DATA.includes('{"title": "...", "form": "question" or "statement" or "numbered"'));
    assert.ok(PLANNER_SYSTEM_V2_KEYWORD_DATA.includes('{"article_type": "cost" or "decision" or "question" or "topic"'));
  });
});

describe('template definitions', () => {
  test('four DB-tunable templates, each falling back to its constant', async () => {
    assert.deepEqual(
      Object.values(V3_STEP_PROMPT_DEFS).map((d) => d.templateType),
      ['content_v3_title', 'content_v3_title_keyword_data', 'content_v3_planner', 'content_v3_planner_keyword_data'],
    );
    assert.equal(V3_STEP_PROMPT_DEFS.title.fallback, TITLE_SYSTEM_V1);
    assert.equal(V3_STEP_PROMPT_DEFS.titleKeywordData.fallback, TITLE_SYSTEM_V2_KEYWORD_DATA);
    assert.equal(V3_STEP_PROMPT_DEFS.planner.fallback, PLANNER_SYSTEM_V1);
    assert.equal(V3_STEP_PROMPT_DEFS.plannerKeywordData.fallback, PLANNER_SYSTEM_V2_KEYWORD_DATA);
    const r = await fallbackStepPromptResolver(V3_STEP_PROMPT_DEFS.planner);
    assert.deepEqual(r, { text: PLANNER_SYSTEM_V1, source: 'fallback', templateType: 'content_v3_planner', displayName: V3_STEP_PROMPT_DEFS.planner.displayName });
  });
});
