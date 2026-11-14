import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repoDocBlocks } from '../content-v3/doc-blocks.js';
import { piecesFromDoc } from './pieces-parse.js';
import { BLUEPRINT_PIECES_V1, OPENINGS, CLOSING_MOVES, parseBlueprintPieces } from './pieces.js';
import {
  assembleBlueprint,
  buildBlueprint,
  firmnessFor,
  mulberry32,
  numberedFromTitle,
  optionalPool,
  patternShares,
  priceAvailable,
  recentHeadingsBlock,
  rescaledBlueprint,
  scaleTargets,
  structureFingerprint,
  tocAuto,
  topicTriggers,
  wordTargets,
  type BlueprintInput,
  type HistoryPost,
} from './blueprint.js';

const BASE: BlueprintInput = {
  articleType: 'cost',
  postSize: 'medium',
  suggestedSize: 'medium',
  title: 'Water heater repair cost in Española',
  reach: 'local',
  readiness: 'comparing',
  bodyQuestions: ['What does it cost?', 'What drives the price?', 'When is replacing better?', 'How to avoid overpaying?', 'What about permits?', 'How long does it take?', 'Q7?'],
  faqQuestions: ['F1?', 'F2?', 'F3?', 'F4?', 'F5?'],
  firmest: 'direct',
  priceAvailable: true,
  businessSupplied: true,
};

describe('pieces (B1) = the doc', () => {
  test('every key, byte for byte', () => {
    const fromDoc = piecesFromDoc(repoDocBlocks());
    assert.deepEqual(Object.keys(BLUEPRINT_PIECES_V1).sort(), Object.keys(fromDoc).sort());
    for (const k of Object.keys(fromDoc)) assert.equal(BLUEPRINT_PIECES_V1[k], fromDoc[k], k);
  });

  test('an edited record must keep every key; otherwise the default is used', () => {
    assert.ok(parseBlueprintPieces(JSON.stringify(BLUEPRINT_PIECES_V1)));
    const { punch_line: _drop, ...missing } = BLUEPRINT_PIECES_V1;
    assert.equal(parseBlueprintPieces(JSON.stringify(missing)), null);
    assert.equal(parseBlueprintPieces('{nope'), null);
  });

  test('optional pools parse with their markers', () => {
    const pool = optionalPool(BLUEPRINT_PIECES_V1.cost_guide);
    assert.equal(pool.length, 8);
    assert.deepEqual(pool.find((p) => p.label === 'local price factors'), { label: 'local price factors', localOnly: true, suppliedOnly: false, sourcedOrSupplied: false });
    assert.equal(pool.find((p) => p.label === 'financing, insurance or payment options')!.suppliedOnly, true);
    assert.equal(optionalPool(BLUEPRINT_PIECES_V1.topic_guide).find((p) => p.label === 'cost')!.sourcedOrSupplied, true);
  });
});

describe('draw rules (B2–B7, B10, B11)', () => {
  test('section count within the size range; never pinned; deterministic with a seed', () => {
    for (let s = 1; s <= 40; s++) {
      for (const size of ['small', 'medium', 'large'] as const) {
        const r = buildBlueprint({ ...BASE, postSize: size, suggestedSize: size, rng: mulberry32(s) });
        const [lo, hi] = { small: [2, 3], medium: [4, 6], large: [6, 9] }[size];
        assert.ok(r.picks.sections >= lo && r.picks.sections <= hi, `${size} ${r.picks.sections}`);
        assert.ok(r.picks.word_targets.every((w) => w >= 120), `${size} ${r.picks.word_targets}`);
      }
    }
    const a = buildBlueprint({ ...BASE, rng: mulberry32(7) });
    const b = buildBlueprint({ ...BASE, rng: mulberry32(7) });
    assert.equal(a.block, b.block);
  });

  test('word targets: middle of the range minus the fixed parts, by pattern, rounded to 10, none under 120', () => {
    assert.deepEqual(patternShares('anchor', 4), [2, 1, 1, 1]);
    assert.deepEqual(wordTargets(1350, 'anchor', 4), [540, 270, 270, 270]);
    const fh = wordTargets(1350, 'front_heavy', 4);
    assert.ok(fh[0] > fh[1] && fh[1] > fh[2] && fh[2] > fh[3]);
    const bh = wordTargets(1350, 'back_heavy', 4);
    assert.ok(bh[0] < bh[3]);
    assert.deepEqual(wordTargets(1260, 'alternating', 3).map((w) => w % 10), [0, 0, 0]);
    for (let s = 1; s <= 30; s++) {
      const r = buildBlueprint({ ...BASE, postSize: 'small', suggestedSize: 'small', rng: mulberry32(s) });
      assert.ok(r.picks.word_targets.every((w) => w >= 120), JSON.stringify(r.picks.word_targets));
      assert.equal(r.picks.word_targets.length, r.picks.sections);
    }
  });

  test('3m never takes the body below the chosen size\'s section range (Medium over a suggested Small)', () => {
    for (let s = 1; s <= 40; s++) {
      const r = buildBlueprint({ ...BASE, postSize: 'medium', suggestedSize: 'small', rng: mulberry32(s) });
      assert.ok(r.picks.sections >= 4, `${r.picks.length_pattern} ${r.picks.sections}`);
      assert.ok(r.picks.word_targets.every((w) => w >= 120), r.picks.word_targets.join('/'));
    }
  });

  test('C12: sections never above body questions + optional elements, never below the size\'s minimum', () => {
    const cap = (r: ReturnType<typeof buildBlueprint>, questions: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, questions + r.picks.optional_elements.length));
    for (let s = 1; s <= 40; s++) {
      // 3m over 4 questions: the top of Medium (6), capped at 4 questions + the optional elements.
      const four = buildBlueprint({ ...BASE, bodyQuestions: BASE.bodyQuestions.slice(0, 4), postSize: 'medium', suggestedSize: 'small', rng: mulberry32(s) });
      assert.equal(four.picks.sections, cap(four, 4, 4, 6), `3m over 4 questions: ${four.picks.sections}`);
      assert.match(four.block, /Body questions, most important first:\n1\. .*\n2\. .*\n3\. .*\n4\. [^\n]*\nFORMAT:/);
      const five = buildBlueprint({ ...BASE, bodyQuestions: BASE.bodyQuestions.slice(0, 5), postSize: 'medium', suggestedSize: 'medium', rng: mulberry32(s) });
      assert.ok(five.picks.sections >= 4 && five.picks.sections <= cap(five, 5, 4, 6), `medium over 5 questions: ${five.picks.sections}`);
      // Too few questions and elements for Large: the size's minimum holds.
      const two = buildBlueprint({ ...BASE, bodyQuestions: BASE.bodyQuestions.slice(0, 2), postSize: 'large', suggestedSize: 'medium', rng: mulberry32(s) });
      assert.equal(two.picks.sections, 6, `large keeps its minimum: ${two.picks.sections}`);
    }
  });

  test('A1: calibrated targets — the BODY line carries word_targets × the factor; picks and fingerprint keep the doc formula', () => {
    assert.deepEqual(scaleTargets([540, 270, 270, 270], 1), [540, 270, 270, 270]);
    assert.deepEqual(scaleTargets([540, 270], 1.3), [700, 350]);
    for (let s = 1; s <= 20; s++) {
      const plain = buildBlueprint({ ...BASE, rng: mulberry32(s) });
      const scaled = buildBlueprint({ ...BASE, rng: mulberry32(s), targetScale: 1.3 });
      assert.deepEqual(scaled.picks.word_targets, plain.picks.word_targets, 'the doc formula is unchanged');
      assert.deepEqual(scaled.picks.writer_targets, scaleTargets(plain.picks.word_targets, 1.3));
      assert.equal(scaled.fingerprint, plain.fingerprint, 'calibration is not a structure pick');
      // Same wording; only the numbers in the BODY line differ.
      const words = (b: string) => b.replace(/\d+/g, '#');
      assert.equal(words(scaled.block), words(plain.block));
      for (const n of scaled.picks.writer_targets) assert.ok(scaled.block.includes(String(n)), `${n} in the BODY line`);
    }
  });

  test('A1: rescaledBlueprint changes only the numbers of the BODY line', () => {
    const bp = buildBlueprint({ ...BASE, rng: mulberry32(3), targetScale: 1.3 });
    const again = rescaledBlueprint(bp.picks, BASE, 1.5);
    assert.deepEqual(again.picks.writer_targets, scaleTargets(bp.picks.writer_targets, 1.5));
    assert.deepEqual(again.picks.word_targets, bp.picks.word_targets);
    assert.equal(again.block.replace(/\d+/g, '#'), bp.block.replace(/\d+/g, '#'));
    assert.notEqual(again.block, bp.block);
  });

  test('3m: larger than suggested → top section count, top optional count, aim at the bottom of the range', () => {
    const r = buildBlueprint({ ...BASE, postSize: 'large', suggestedSize: 'small', rng: mulberry32(3) });
    assert.equal(r.picks.larger_than_suggested, true);
    assert.equal(r.picks.optional_elements.length, 3);
    const total = r.picks.word_targets.reduce((a, b) => a + b, 0);
    // A quarter into the Large range (2,700), minus the fixed parts — never the 2,400 edge itself.
    assert.ok(Math.abs(total - (2700 - 540)) <= 10 * r.picks.sections, String(total));
  });

  test('optional elements: count by size; nationwide never "local only"; supplied-only needs business details', () => {
    for (let s = 1; s <= 40; s++) {
      const r = buildBlueprint({ ...BASE, reach: 'nationwide', businessSupplied: false, rng: mulberry32(s) });
      assert.ok(r.picks.optional_elements.length >= 1 && r.picks.optional_elements.length <= 2);
      assert.ok(!r.picks.optional_elements.includes('local price factors'));
      assert.ok(!r.picks.optional_elements.includes('financing, insurance or payment options'));
    }
  });

  test('firmness from readiness, capped by the niche; soft when missing (3k, N5)', () => {
    assert.equal(firmnessFor('researching', 'direct'), 'soft');
    assert.equal(firmnessFor('comparing', 'direct'), 'medium');
    assert.equal(firmnessFor('ready to hire', 'direct'), 'direct');
    assert.equal(firmnessFor('ready to hire', 'soft'), 'soft');
    assert.equal(firmnessFor('', 'direct'), 'soft');
  });

  test('FAQ top 3/4/5 by size, fewer when fewer exist; TOC auto by size (B10)', () => {
    assert.equal(buildBlueprint({ ...BASE, postSize: 'small', suggestedSize: 'small' }).picks.faq_count, 3);
    assert.equal(buildBlueprint({ ...BASE, postSize: 'large', suggestedSize: 'large' }).picks.faq_count, 5);
    assert.equal(buildBlueprint({ ...BASE, faqQuestions: ['only one?'] }).picks.faq_count, 1);
    assert.equal(tocAuto('small'), false);
    assert.equal(tocAuto('medium'), true);
    assert.equal(buildBlueprint({ ...BASE, pins: { toc: false } }).picks.toc, false);
  });

  test('pins (B11) are taken as pinned', () => {
    const r = buildBlueprint({ ...BASE, pins: { opening: 'myth_correction', accent: 'one_checklist', order: 'closing_first', closing_move: 'punch_line', closing_format: 'cta_own_line', firmness: 'direct', length_pattern: 'anchor', summary: { form: 'takeaways', points: 5, list: 'numbered' }, article_type: 'decision', optional_elements: ['warning signs'] } });
    const p = r.picks;
    assert.deepEqual([p.opening, p.accent, p.order, p.closing_move, p.closing_format, p.firmness, p.length_pattern, p.summary_form, p.takeaway_points, p.takeaway_list, p.article_type], ['myth_correction', 'one_checklist', 'closing_first', 'punch_line', 'cta_own_line', 'direct', 'anchor', 'takeaways', 5, 'numbered', 'decision']);
    assert.deepEqual(p.optional_elements, ['warning signs']);
  });

  test('cost guide with no price → the "no figure" piece follows the type piece (B8)', () => {
    const r = buildBlueprint({ ...BASE, priceAvailable: false, businessSupplied: false });
    assert.equal(r.picks.no_figure, true);
    assert.match(r.block, /COST GUIDE, NO FIGURE AVAILABLE\nReplace the price range with how pricing works/);
    assert.doesNotMatch(r.block, /code sends this instead/);
    assert.equal(priceAvailable(['Repairs run $150 to $700 in New Mexico.']), true);
    assert.equal(priceAvailable(['Tanks last 8 to 12 years.']), false);
  });

  test('topic guide keeps only the trigger lines found in the title', () => {
    assert.deepEqual(topicTriggers('How to flush a water heater before winter'), ['task', 'time']);
    const r = buildBlueprint({ ...BASE, articleType: 'topic', title: 'How to flush a water heater' });
    assert.match(r.block, /- Task \(how to/);
    assert.doesNotMatch(r.block, /- Time \(a season/);
    assert.doesNotMatch(r.block, /Add when code finds the trigger/);
  });
});

describe('numbered titles (B6)', () => {
  test('item count, kind, minimum words; capped at 15', () => {
    assert.deepEqual(numberedFromTitle('7 signs your water heater is failing'), { items: 7, kind: 'signs', min_words: 60 });
    assert.deepEqual(numberedFromTitle('5 steps to winterize pipes'), { items: 5, kind: 'steps', min_words: 40 });
    assert.deepEqual(numberedFromTitle('12 questions to ask a plumber'), { items: 12, kind: 'questions', min_words: 35 });
    assert.equal(numberedFromTitle('Water heater repair cost in 2026'), null);
    assert.equal(numberedFromTitle('25 tips for homeowners', 'numbered', 25)!.items, 15);
  });

  test('items replace the body count; no optional elements; no extra list; table only on Medium/Large', () => {
    for (let s = 1; s <= 20; s++) {
      const small = buildBlueprint({ ...BASE, postSize: 'small', suggestedSize: 'small', title: '6 signs your water heater is failing', titleForm: 'numbered', titleItems: 6, rng: mulberry32(s) });
      assert.equal(small.picks.sections, 6);
      assert.deepEqual(small.picks.optional_elements, []);
      assert.equal(small.picks.accent, 'prose_only');
      const med = buildBlueprint({ ...BASE, title: '6 signs your water heater is failing', titleForm: 'numbered', titleItems: 6, rng: mulberry32(s) });
      assert.ok(['prose_only', 'one_table'].includes(med.picks.accent));
    }
    const r = buildBlueprint({ ...BASE, title: '6 signs your water heater is failing', titleForm: 'numbered', titleItems: 6 });
    assert.match(r.block, /NUMBERED: The title promises 6 signs\. Deliver exactly 6, .* Items are at least 60 words each\. Group them as items as H2 sections\. Order them by priority\./);
    assert.match(r.block, /BODY: the 6 signs, at least 60 words each\./);
    const big = buildBlueprint({ ...BASE, title: '10 tips to cut heating costs', titleForm: 'numbered', titleItems: 10 });
    assert.equal(big.picks.numbered!.grouping, 'grouped_h3');
    assert.equal(big.picks.numbered!.order_by, 'cost');
  });
});

describe('history checks (B4, B5)', () => {
  const hist = (n: number, fn: (i: number) => Partial<HistoryPost['picks']>, type = 'cost'): HistoryPost[] =>
    Array.from({ length: n }, (_, i) => ({ article_type: type, picks: { article_type: type, ...fn(i) } as any }));

  test('no opening or closing move from the previous 2 posts of this type', () => {
    const history = hist(2, (i) => ({ opening: OPENINGS[i], closing_move: CLOSING_MOVES[i] }));
    for (let s = 1; s <= 40; s++) {
      const r = buildBlueprint({ ...BASE, history, rng: mulberry32(s) });
      assert.ok(!['reader_situation', 'reader_stakes'].includes(r.picks.opening));
      assert.ok(!['forward_question', 'quiet_close'].includes(r.picks.closing_move));
    }
    // Other types' posts do not count.
    const other = hist(2, () => ({ opening: 'reader_situation' }), 'topic');
    const seen = new Set<string>();
    for (let s = 1; s <= 60; s++) seen.add(buildBlueprint({ ...BASE, history: other, rng: mulberry32(s) }).picks.opening);
    assert.ok(seen.has('reader_situation'));
  });

  test('an exact repeat of one of the last 10 is redrawn', () => {
    // Opening and closing pinned, so the "previous 2 posts" rule cannot be what changes the draw.
    const pins = { opening: 'direct_question' as const, closing_move: 'next_step' as const };
    const first = buildBlueprint({ ...BASE, pins, rng: mulberry32(11) });
    const history: HistoryPost[] = [{ article_type: 'cost', picks: first.picks as any, fingerprint: first.fingerprint }];
    const again = buildBlueprint({ ...BASE, pins, history, rng: mulberry32(11) });
    assert.notEqual(again.fingerprint, first.fingerprint);
    assert.ok(again.redraws >= 1);
  });

  test('no single pick in more than 40% of the last 20', () => {
    const history = hist(20, (i) => ({ accent: i < 10 ? 'one_table' : 'prose_only', opening: 'myth_correction' }), 'topic');
    for (let s = 1; s <= 30; s++) {
      const r = buildBlueprint({ ...BASE, history, rng: mulberry32(s) });
      assert.ok(!['one_table', 'prose_only'].includes(r.picks.accent), r.picks.accent);
      assert.notEqual(r.picks.opening, 'myth_correction');
    }
  });

  test('after 5 redraws the result is accepted and logged', () => {
    // Every value of three dimensions already sits in 50% of the last 20: no draw can clear it.
    const forced = hist(20, (i) => ({ summary_form: i % 2 ? 'quick_answer' : 'takeaways', order: i % 2 ? 'faq_first' : 'closing_first', closing_format: i % 2 ? 'one_paragraph' : 'cta_own_line' }), 'topic');
    const logs: string[] = [];
    const r = buildBlueprint({ ...BASE, history: forced, rng: mulberry32(5) }, (l) => logs.push(l));
    assert.equal(r.accepted_after_max, true);
    assert.equal(r.redraws, 5);
    assert.match(logs[0], /\[blueprint\] accepted after 5 redraws \(spread:/);
  });

  test('a stored row with incomplete picks does not break the draw', () => {
    const r = buildBlueprint({ ...BASE, history: [{ article_type: 'cost', picks: { opening: 'reader_stakes' } as any }] });
    assert.ok(r.block.startsWith('<blueprint>'));
  });

  test('fingerprint ignores word targets and questions, changes with a structural pick', () => {
    const a = buildBlueprint({ ...BASE, rng: mulberry32(2) });
    const b = { ...a.picks, word_targets: [1, 2, 3] };
    assert.equal(structureFingerprint(b), a.fingerprint);
    assert.notEqual(structureFingerprint({ ...a.picks, accent: a.picks.accent === 'one_list' ? 'one_table' : 'one_list' }), a.fingerprint);
  });
});

describe('assembly (B9 and the fixed order)', () => {
  test('fixed order of the block, as in the doc example', () => {
    const r = buildBlueprint({ ...BASE, pins: { opening: 'reader_stakes', summary: { form: 'takeaways', points: 4, list: 'bullets' }, length_pattern: 'anchor', accent: 'one_table', order: 'faq_first', closing_move: 'forward_question', closing_format: 'one_paragraph', firmness: 'medium', optional_elements: ['extra or hidden costs', 'what a fair quote should include'] }, rng: mulberry32(1) });
    const order = ['ARTICLE TYPE: Cost guide.', 'OPENING: Open with what this decision', 'SUMMARY: key takeaways, directly after the introduction. 4 points, as a bulleted list. The first point answers the title. This is the only summary: no separate quick answer.', 'BODY: ', 'Also cover: extra or hidden costs; what a fair quote should include.', 'Body questions, most important first:\n1. What does it cost?', 'FORMAT: Use one table in the body', 'FAQ: these 4 questions, in this order:\n1. F1?\n2. F2?\n3. F3?\n4. F4?', 'ORDER OF THE LAST TWO SECTIONS: FAQ, then the closing.', 'CLOSING: End by turning the topic forward'];
    let at = 0;
    for (const part of order) {
      const i = r.block.indexOf(part, at);
      assert.ok(i >= at, `missing or out of order: ${part}`);
      at = i;
    }
    assert.match(r.block, /About \d+0 words for the main section, about \d+0 for each of the others\./);
    assert.match(r.block, /Firmness: Suggest what to check, ask or compare, and mention the business as one option\.\n<\/blueprint>$/);
    assert.ok(r.block.startsWith('<blueprint>\n'));
    assert.doesNotMatch(r.block, /Optional pool:/);
  });

  test('no FAQ questions → no FAQ section and no order line', () => {
    const r = buildBlueprint({ ...BASE, faqQuestions: [] });
    assert.match(r.block, /FAQ: no FAQ section in this article\./);
    assert.doesNotMatch(r.block, /ORDER OF THE LAST TWO SECTIONS/);
  });

  test('<recent_headings>: same type only, deduped, escaped; empty when none', () => {
    const block = recentHeadingsBlock(
      [
        { article_type: 'cost', headings: ['What drives the price', 'Permits & fees'] },
        { article_type: 'topic', headings: ['Not this one'] },
        { article_type: 'cost', headings: ['what drives the price', 'A <b> heading'] },
      ],
      'cost',
    );
    assert.equal(block, '<recent_headings>\n  <heading>What drives the price</heading>\n  <heading>Permits &amp; fees</heading>\n  <heading>A &lt;b&gt; heading</heading>\n</recent_headings>');
    assert.equal(recentHeadingsBlock([], 'cost'), '');
  });

  test('assembleBlueprint is pure: same picks → same text', () => {
    const r = buildBlueprint({ ...BASE, rng: mulberry32(9) });
    assert.equal(assembleBlueprint(r.picks, BASE), r.block);
  });
});

test('a quick-answer blueprint says it is the only summary (Writer added takeaways on top, 14 Nov run)', () => {
  const r = buildBlueprint({ ...BASE, pins: { summary: { form: 'quick_answer' } } });
  assert.match(r.block, /SUMMARY: a quick answer, directly after the introduction: one paragraph of 40 to 60 words\. Its first sentence answers the title\. This is the only summary: no key takeaways list\./);
});
