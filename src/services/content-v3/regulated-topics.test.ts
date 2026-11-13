import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOC_PATH } from './doc-blocks.js';
import { DEFAULT_REGULATED_TOPICS, matchRegulatedTopic, parseRegulatedTopics, regulatedSuggestion } from './regulated-topics.js';
import { checkApprovedTitle, fallbackPlan, guessArticleType, minimumSizeFor } from './planner-fallback.js';

describe('regulated topics list = the doc table', () => {
  const md = fs.readFileSync(DOC_PATH, 'utf8');
  const section = md.slice(md.indexOf('### Regulated topics list'), md.indexOf('### Part 3: type adjustments'));

  test('each category row, term for term', () => {
    for (const [category, terms] of Object.entries(DEFAULT_REGULATED_TOPICS.categories)) {
      const row = section.split('\n').find((l) => l.startsWith(`| ${category} |`));
      assert.ok(row, `row for ${category}`);
      const docTerms = row!.split('|')[2].split(',').map((t) => t.trim());
      assert.deepEqual(terms, docTerms, category);
    }
  });

  test('the "never match on their own" exclusions are covered', () => {
    const line = section.split('\n').find((l) => l.startsWith('**Never match on their own**'))!;
    for (const phrase of ['injection molding', 'fuel injection', 'legal pad', 'legal size', 'photo shoot']) {
      assert.ok(line.includes(phrase));
      assert.ok(DEFAULT_REGULATED_TOPICS.exclusions.includes(phrase));
    }
    // "treatment (hair, lawn, water)" → the three phrases
    for (const p of ['hair treatment', 'lawn treatment', 'water treatment']) assert.ok(DEFAULT_REGULATED_TOPICS.exclusions.includes(p));
  });
});

describe('matching (G2)', () => {
  test('flags "lip fillers while breastfeeding", not "facial masks for dry skin" (the doc example)', () => {
    assert.deepEqual(matchRegulatedTopic('Lip filler while breastfeeding: is it safe?'), { category: 'Health and medical', term: 'lip filler' });
    assert.equal(matchRegulatedTopic('Facial masks for dry skin'), null);
  });

  test('whole phrases only; exclusions blank the phrase first', () => {
    assert.equal(matchRegulatedTopic('Fuel injection cleaning cost'), null);
    assert.equal(matchRegulatedTopic('Interest in home gardening'), null);
    assert.equal(matchRegulatedTopic('Water treatment systems for wells'), null);
    assert.equal(matchRegulatedTopic('What is a good credit score for a car loan')!.category, 'Financial');
    assert.equal(matchRegulatedTopic('Statute of limitations for a slip and fall')!.category, 'Legal');
    assert.equal(matchRegulatedTopic('IRA vs 401(k) for small business owners')!.term, '401(k)');
    assert.equal(matchRegulatedTopic('Pirate party ideas'), null, 'IRA must not match inside a word');
  });

  test('watchlist terms count', () => {
    assert.deepEqual(matchRegulatedTopic('Chemical peel aftercare', DEFAULT_REGULATED_TOPICS, ['chemical peel']), { category: 'Niche watchlist', term: 'chemical peel' });
  });

  test('suggestion: business Regulated wins; list or Planner is enough for Standard', () => {
    assert.equal(regulatedSuggestion({ businessProofLevel: 'regulated', title: 'x', seedKeyword: 'y', plannerRegulated: false }).by, 'business');
    assert.equal(regulatedSuggestion({ title: 'Botox aftercare', seedKeyword: 'botox', plannerRegulated: false }).by, 'list');
    const p = regulatedSuggestion({ title: 'How an insurance claim for a burst pipe works', seedKeyword: 'burst pipe', plannerRegulated: true, plannerReason: 'Insurance claims' });
    assert.equal(p.by, 'both');
    const only = regulatedSuggestion({ title: 'Sleep apnea and snoring', seedKeyword: 'snoring', plannerRegulated: true, plannerReason: 'Medical diagnosis' });
    assert.equal(only.by, 'planner');
    assert.equal(only.reason, 'Medical diagnosis');
    assert.equal(regulatedSuggestion({ title: 'Water heater repair', seedKeyword: 'water heater', plannerRegulated: false }).suggested, false);
  });

  test('admin-edited JSON replaces the list; invalid JSON is ignored', () => {
    const l = parseRegulatedTopics('{"categories":{"Health and medical":["tooth whitening"]},"exclusions":[]}')!;
    assert.equal(matchRegulatedTopic('Tooth whitening at home', l)!.term, 'tooth whitening');
    assert.equal(parseRegulatedTopics('{oops'), null);
    assert.equal(parseRegulatedTopics('{"categories":{}}'), null);
  });
});

describe('planner fallback, minimum size, title check', () => {
  test('minimum size from numbered titles (60 words per item over the body budget)', () => {
    assert.equal(minimumSizeFor('statement', null), 'small');
    assert.equal(minimumSizeFor('numbered', 8), 'small');
    assert.equal(minimumSizeFor('numbered', 9), 'medium');
    assert.equal(minimumSizeFor('numbered', 15), 'medium');
  });

  test('keyword guess', () => {
    assert.equal(guessArticleType('water heater repair cost'), 'cost');
    assert.equal(guessArticleType('repair or replace water heater'), 'decision');
    assert.equal(guessArticleType('how to flush a water heater'), 'question');
    assert.equal(guessArticleType('tankless water heaters'), 'topic');
  });

  test('fallback plan: keyword type, minimum size, no owner questions, no profile, PAA as FAQ', () => {
    const p = fallbackPlan({
      seedKeyword: 'water heater repair cost',
      title: 'Water heater repair cost in Española',
      minimumSize: 'small',
      searchData: { people_also_ask: Array.from({ length: 7 }, (_, i) => ({ text: `Q${i}?`, scope: 'local' as const })) },
    });
    assert.equal(p.article_type, 'cost');
    assert.equal(p.post_size, 'small');
    assert.deepEqual(p.owner_questions, []);
    assert.equal(p.searcher_profile.situation, '');
    assert.equal(p.faq_questions.length, 5);
  });

  test('title check: empty and markup blocked; long and keyword-less only noted', () => {
    assert.equal(checkApprovedTitle('   ', 'x').ok, false);
    assert.equal(checkApprovedTitle('<b>Water</b> heater repair', 'water heater').title, 'Water heater repair');
    const long = checkApprovedTitle('Water heater repair in Española: every sign, cost and fix you should know about', 'water heater repair');
    assert.equal(long.ok, true);
    assert.equal(long.notes.length, 1);
    assert.match(checkApprovedTitle('Roof care tips', 'water heater repair').notes[0], /does not use any words/);
    assert.equal(checkApprovedTitle('x'.repeat(151), 'x').ok, false);
  });
});
