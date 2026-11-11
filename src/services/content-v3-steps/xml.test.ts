import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tag, listTag, searchDataBlock, researchBlock, recentPostsBlock, joinBlocks, inline } from './xml.js';

describe('tag', () => {
  test('a blank value leaves the tag out entirely', () => {
    assert.equal(tag('target_town', ''), '');
    assert.equal(tag('target_town', '   '), '');
    assert.equal(tag('target_town', undefined), '');
    assert.equal(tag('target_town', null), '');
    assert.equal(tag('items', []), '');
  });

  test('renders value and attributes, escaping anything tag-like', () => {
    assert.equal(tag('seed_keyword', ' water  heater\nrepair '), '<seed_keyword>water heater repair</seed_keyword>');
    assert.equal(tag('x', 'a < b', { scope: 'local', n: 3, skip: undefined, blank: '' }), '<x scope="local" n="3">a &lt; b</x>');
    assert.equal(tag('x', 'v', { flag: true, off: false }), '<x flag="yes" off="no">v</x>');
    assert.equal(inline('</seed_keyword><evil>'), '&lt;/seed_keyword&gt;&lt;evil&gt;');
  });
});

describe('blocks', () => {
  test('search_data: scoped items, counts, location and fallback flag; empty → omitted', () => {
    assert.equal(searchDataBlock(undefined), '');
    assert.equal(searchDataBlock({ location: 'X', ranking_titles: [], people_also_ask: [] }), '');
    const out = searchDataBlock({
      location: 'Española, NM',
      national_fallback: true,
      ranking_titles: [{ text: 'Water heater repair cost', scope: 'local' }],
      people_also_ask: [{ text: 'Is it worth repairing?', scope: 'local' }, { text: 'How long do they last?', scope: 'national' }],
      related_searches: [{ text: ' ', scope: 'local' }],
    });
    assert.equal(
      out,
      [
        '<search_data location="Española, NM" national_fallback="yes">',
        '  <ranking_titles>',
        '    <item scope="local">Water heater repair cost</item>',
        '  </ranking_titles>',
        '  <people_also_ask count="2">',
        '    <item scope="local">Is it worth repairing?</item>',
        '    <item scope="national">How long do they last?</item>',
        '  </people_also_ask>',
        '</search_data>',
      ].join('\n'),
    );
  });

  test('research: numbered facts with scope and conflict, questions, conditions, notes', () => {
    assert.equal(researchBlock(undefined), '');
    assert.equal(researchBlock({ facts: [], notes: '' }), '');
    const out = researchBlock({
      facts: [{ claim: 'Average repair is $150–$700', scope: 'national', source_ids: [1] }, { claim: 'Permit required', conflict: true }],
      follow_up_questions: [{ question: 'Can I DIY?' }],
      local_conditions: [{ claim: 'Hard water shortens tank life' }],
      notes: 'one source older than 3 years',
    });
    assert.equal(
      out,
      [
        '<research>',
        '  <facts>',
        '    <fact id="S1" scope="national">Average repair is $150–$700</fact>',
        '    <fact id="S2" conflict="true">Permit required</fact>',
        '  </facts>',
        '  <follow_up_questions>',
        '    <question>Can I DIY?</question>',
        '  </follow_up_questions>',
        '  <local_conditions>',
        '    <condition>Hard water shortens tank life</condition>',
        '  </local_conditions>',
        '  <notes>one source older than 3 years</notes>',
        '</research>',
      ].join('\n'),
    );
  });

  test('recent_posts: one <post id> line per post; empty → omitted', () => {
    assert.equal(recentPostsBlock([]), '');
    assert.equal(
      recentPostsBlock([{ post_id: 12, title: 'Water heater repair cost', seed_keyword: 'water heater repair' }, { post_id: 13, title: 'Signs <b>' }]),
      '<recent_posts>\n  <post id="12" seed_keyword="water heater repair">Water heater repair cost</post>\n  <post id="13">Signs &lt;b&gt;</post>\n</recent_posts>',
    );
  });

  test('listTag and joinBlocks drop blanks', () => {
    assert.equal(listTag('x', ['', '  ']), '');
    assert.equal(joinBlocks(['<a>1</a>', '', null, undefined, false, '<b>2</b>']), '<a>1</a>\n<b>2</b>');
  });
});
