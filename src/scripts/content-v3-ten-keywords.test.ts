import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOC_PATH } from '../services/content-v3/doc-blocks.js';
import { reviewSheet, testingChecklists } from './content-v3-ten-keywords.js';

test('the review sheet carries the doc\'s own "What to check in testing" lists', () => {
  const lists = testingChecklists(fs.readFileSync(DOC_PATH, 'utf8'));
  const sections = lists.map((l) => l.section);
  for (const s of ['PROMPT 1 · Title (#3)', 'PROMPT 2 · Research query (#1)', 'PROMPT 3 · Planner (#2)']) assert.ok(sections.includes(s), s);
  assert.ok(lists.every((l) => l.items.length > 0));
});

test('a failed case is listed with its error; HTML is escaped', () => {
  const html = reviewSheet([{ id: 'x', ok: false, error: '<script>bad</script>', case: { seed_keyword: 'k<b>' }, timings: { total_ms: 1 } }], []);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});

test('keyword data off and on in one sheet: side by side, own anchors, what each step got', () => {
  const row = (mode: 'off' | 'on', passed: boolean) => ({
    id: 'trades-hvac',
    ok: true,
    keyword_data_mode: mode,
    keyword_data: mode === 'on' ? { title: { requested: true, effective: true, used: true, related_count: 10, ms: 5 }, planner: { requested: true, effective: true, used: false, reason: 'unavailable', ms: 5 } } : { title: null, planner: null },
    step_prompts: { title: mode === 'on' ? 'content_v3_title@code#abc' : 'content_v3_title@code#d08', planner: null },
    case: { seed_keyword: 'furnace not turning on', niche: 'hvac', reach: 'local', target_town: 'Santa Fe', post_size: 'medium' },
    title: 'Furnace not turning on in Santa Fe',
    search_data: { mode: 'local', location: 'Santa Fe, NM', national_fallback: false, counts: { titles: 8, questions: 4, related: 6 } },
    research: { status: 'skipped', facts: 0, local_conditions: 0 },
    plan: { article_type: 'question', post_size: 'medium', size_reason: 'r', body_questions: ['Why?'], faq_questions: [], owner_questions: [], searcher_profile: { situation: 's', readiness: 'comparing' } },
    plan_fallback: false,
    regulated: { suggested: false },
    proof_level: 'standard',
    picks: { article_type: 'question', summary_form: 'quick_answer', opening: 'reader_stakes', sections: 4, word_targets: [540, 270, 270, 270], length_pattern: 'anchor', accent: 'one_list', order: 'faq_first', closing_move: 'next_step', firmness: 'medium', optional_elements: [] },
    fingerprint: 'f',
    validator: { passed, word_count: 1300, issues: passed ? [] : [{ code: 'word_count', severity: 'error', message: 'short' }] },
    repaired: false,
    writer_json: { claims_to_check: [] },
    meta_title: 'm',
    meta_description: 'd',
    content: '<h2 id="faq" data-iseo="faq">FAQ</h2><a href="#faq">x</a>',
    cost: { writer: 0.1 },
    timings: { total_ms: 1000 },
  });
  // Given on before off: the sheet still lists off first.
  const html = reviewSheet([row('on', true), row('off', false)], []);
  assert.ok(html.indexOf('id="trades-hvac"') < html.indexOf('id="trades-hvac-kd"'));
  assert.match(html, /id="trades-hvac-kd-faq"/);
  assert.match(html, /href="#trades-hvac-kd-faq"/);
  assert.match(html, /title: used, 10 related · planner: not used \(unavailable\)/);
  assert.match(html, /passed checks, keyword data off <b>0 of 1<\/b>/);
  assert.match(html, /passed checks, keyword data on <b>1 of 1<\/b>/);
  assert.match(html, /keywords <b>1<\/b><\/span><span>articles <b>2<\/b>/);
});
