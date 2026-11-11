import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKeywordDataBlock,
  formatKeywordLine,
  locationName,
  selectRelated,
  sortByVolumeDesc,
} from './keyword-data-block.js';
import type { KeywordMetricsItem } from './keyword-data.types.js';

const AT = '2026-11-11T10:00:00.000Z';
const item = (
  keyword: string,
  search_volume: number | null = null,
  keyword_difficulty: number | null = null,
  intent: KeywordMetricsItem['intent'] = null,
): KeywordMetricsItem => ({ keyword, search_volume, keyword_difficulty, intent, scope: 'national', fetched_at: AT });

describe('buildKeywordDataBlock', () => {
  test('renders the contract example byte for byte', () => {
    const seed = item('water heater repair cost', 2400, 18, 'commercial');
    const related = [item('water heater replacement cost', 1900, 22, 'commercial')];
    assert.equal(
      buildKeywordDataBlock(seed, related, 10),
      [
        '<keyword_data scope="national" location="United States">',
        'seed: water heater repair cost | volume 2400 | difficulty 18 | intent commercial',
        'related:',
        '- water heater replacement cost | volume 1900 | difficulty 22 | intent commercial',
        '</keyword_data>',
      ].join('\n'),
    );
  });

  test('sorts related by volume descending, unknown volume last, stable on ties', () => {
    const related = [item('c', 100), item('d'), item('a', 900), item('b', 900), item('e', 50)];
    const lines = buildKeywordDataBlock(item('seed', 1), related, 30).split('\n').filter((l) => l.startsWith('- '));
    assert.deepEqual(lines.map((l) => l.slice(2).split(' |')[0]), ['a', 'b', 'c', 'e', 'd']);
  });

  test('removes exact duplicates of the seed and duplicate related keywords', () => {
    const seed = item('water heater repair cost', 2400);
    const related = [item('water heater repair cost', 2400), item('x', 10), item('x', 10), item('y', 5)];
    const chosen = selectRelated(seed, related, 10);
    assert.deepEqual(chosen.map((i) => i.keyword), ['x', 'y']);
  });

  test('omits missing fields from a line; a seed with no data is just the keyword', () => {
    assert.equal(formatKeywordLine(item('foo')), 'foo');
    assert.equal(formatKeywordLine(item('foo', 0)), 'foo | volume 0');
    assert.equal(formatKeywordLine(item('foo', null, 40)), 'foo | difficulty 40');
    assert.equal(formatKeywordLine(item('foo', null, null, 'informational')), 'foo | intent informational');
    const block = buildKeywordDataBlock(item('foo'), [], 10);
    assert.equal(block, '<keyword_data scope="national" location="United States">\nseed: foo\n</keyword_data>');
    assert.doesNotMatch(block, /related:/);
  });

  test('applies the limit AFTER sorting and de-duplication: 10 for Title, 30 for Planner', () => {
    const seed = item('seed', 5000);
    const related = Array.from({ length: 45 }, (_, i) => item(`kw ${i}`, 45 - i));
    related.push(item('seed', 5000)); // duplicate of the seed must not eat a slot
    const title = buildKeywordDataBlock(seed, related, 10).split('\n').filter((l) => l.startsWith('- '));
    const planner = buildKeywordDataBlock(seed, related, 30).split('\n').filter((l) => l.startsWith('- '));
    assert.equal(title.length, 10);
    assert.equal(planner.length, 30);
    assert.equal(title[0], '- kw 0 | volume 45');
    assert.equal(planner[29], '- kw 29 | volume 16');
  });

  test('names the location from the code, with a plain fallback', () => {
    assert.equal(locationName(2840), 'United States');
    assert.equal(locationName(2826), 'United Kingdom');
    assert.equal(locationName(99999), 'location_code 99999');
    assert.match(buildKeywordDataBlock(item('x', 1), [], 5, { location_code: 2826 }), /location="United Kingdom"/);
  });

  test('escapes angle brackets so a keyword cannot break out of the tag', () => {
    const block = buildKeywordDataBlock(item('a <b> c', 1), [item('</keyword_data> x', 2)], 5);
    assert.doesNotMatch(block.split('\n').slice(1, -1).join('\n'), /<|>/);
    assert.match(block, /a &lt;b&gt; c/);
  });

  test('sortByVolumeDesc does not mutate its input', () => {
    const input = [item('a', 1), item('b', 2)];
    sortByVolumeDesc(input);
    assert.deepEqual(input.map((i) => i.keyword), ['a', 'b']);
  });
});
