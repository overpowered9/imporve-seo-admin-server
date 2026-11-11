import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVolume,
  normalizeDifficulty,
  normalizeIntent,
  normalizeKeywordData,
  normalizeOverview,
  normalizeRelated,
  emptyItem,
} from './normalize.js';
import { normalizeKeyword, escapeTagText } from './keyword-data.types.js';

const AT = new Date('2026-11-11T10:00:00.000Z');

describe('field normalisation — missing becomes null, never 0', () => {
  test('volume: a number stays (0 included); anything else is null', () => {
    assert.equal(normalizeVolume(2400), 2400);
    assert.equal(normalizeVolume(0), 0);
    assert.equal(normalizeVolume(1900.6), 1901);
    assert.equal(normalizeVolume(null), null);
    assert.equal(normalizeVolume(undefined), null);
    assert.equal(normalizeVolume('2400'), null);
    assert.equal(normalizeVolume(-5), null);
    assert.equal(normalizeVolume(NaN), null);
  });

  test('difficulty: clamped to 0–100; non-numbers null', () => {
    assert.equal(normalizeDifficulty(18), 18);
    assert.equal(normalizeDifficulty(0), 0);
    assert.equal(normalizeDifficulty(150), 100);
    assert.equal(normalizeDifficulty(-5), 0);
    assert.equal(normalizeDifficulty(22.4), 22);
    assert.equal(normalizeDifficulty(null), null);
    assert.equal(normalizeDifficulty('18'), null);
  });

  test('intent: one of the four contract values, case- and space-insensitive; else null', () => {
    assert.equal(normalizeIntent('commercial'), 'commercial');
    assert.equal(normalizeIntent(' Informational '), 'informational');
    assert.equal(normalizeIntent('TRANSACTIONAL'), 'transactional');
    assert.equal(normalizeIntent('navigational'), 'navigational');
    assert.equal(normalizeIntent('unknown'), null);
    assert.equal(normalizeIntent(''), null);
    assert.equal(normalizeIntent(null), null);
    assert.equal(normalizeIntent(3), null);
  });
});

describe('normalizeKeywordData', () => {
  test('maps a full Labs item to the contract shape', () => {
    const item = normalizeKeywordData(
      {
        keyword: '  Water Heater  Repair Cost ',
        keyword_info: { search_volume: 2400, cpc: 3.1 },
        keyword_properties: { keyword_difficulty: 18 },
        search_intent_info: { main_intent: 'commercial', foreign_intent: ['informational'] },
      },
      AT,
    );
    assert.deepEqual(item, {
      keyword: 'water heater repair cost',
      search_volume: 2400,
      keyword_difficulty: 18,
      intent: 'commercial',
      scope: 'national',
      fetched_at: '2026-11-11T10:00:00.000Z',
    });
  });

  test('every missing sub-object becomes nulls', () => {
    const item = normalizeKeywordData({ keyword: 'x' }, AT);
    assert.equal(item.search_volume, null);
    assert.equal(item.keyword_difficulty, null);
    assert.equal(item.intent, null);
    assert.equal(item.scope, 'national');
    const nulls = normalizeKeywordData({ keyword: 'x', keyword_info: null, keyword_properties: null, search_intent_info: null }, AT);
    assert.equal(nulls.search_volume, null);
  });

  test('emptyItem is all null with the normalised keyword', () => {
    assert.deepEqual(emptyItem(' Foo  Bar ', AT), {
      keyword: 'foo bar',
      search_volume: null,
      keyword_difficulty: null,
      intent: null,
      scope: 'national',
      fetched_at: AT.toISOString(),
    });
  });
});

describe('normalizeOverview / normalizeRelated', () => {
  test('overview flattens result[].items[] and skips blank keywords', () => {
    const out = normalizeOverview(
      [
        { items: [{ keyword: 'a', keyword_info: { search_volume: 10 } }, { keyword: '  ' } as any, null as any] },
        { items: null },
        { items: [{ keyword: 'b' }] },
      ],
      AT,
    );
    assert.deepEqual(out.map((i) => [i.keyword, i.search_volume]), [['a', 10], ['b', null]]);
  });

  test('related reads items[].keyword_data', () => {
    const out = normalizeRelated(
      [
        {
          seed_keyword: 'a',
          items: [
            { keyword_data: { keyword: 'a b', keyword_info: { search_volume: 5 } }, depth: 1 },
            { keyword_data: { keyword: '' } },
            {} as any,
          ],
        },
      ],
      AT,
    );
    assert.deepEqual(out.map((i) => [i.keyword, i.search_volume]), [['a b', 5]]);
  });
});

describe('normalizeKeyword / escapeTagText', () => {
  test('trims, collapses whitespace, lower-cases, strips control characters', () => {
    assert.equal(normalizeKeyword('  Water   Heater\tRepair \n'), 'water heater repair');
    assert.equal(normalizeKeyword(undefined), '');
    assert.equal(normalizeKeyword('a\u0000b'), 'a b');
  });

  test('escapes the characters that could open or close a data tag', () => {
    assert.equal(escapeTagText('a <b> & c'), 'a &lt;b&gt; &amp; c');
  });
});
