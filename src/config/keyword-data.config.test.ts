import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYWORD_DATA_DEFAULTS,
  dataForSeoCredentials,
  keywordDataConfigured,
  keywordDataFlagOn,
  keywordDataEffective,
  parseKeywordMetricsCreditCost,
  keywordMetricsCreditCost,
} from './keyword-data.config.js';

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

describe('dataForSeoCredentials', () => {
  test('null unless BOTH halves are present', () => {
    assert.equal(dataForSeoCredentials(env({})), null);
    assert.equal(dataForSeoCredentials(env({ DATAFORSEO_LOGIN: 'a' })), null);
    assert.equal(dataForSeoCredentials(env({ DATAFORSEO_PASSWORD: 'b' })), null);
    assert.equal(dataForSeoCredentials(env({ DATAFORSEO_LOGIN: '  ', DATAFORSEO_PASSWORD: 'b' })), null);
    assert.equal(keywordDataConfigured(env({})), false);
  });

  test('trims both values', () => {
    assert.deepEqual(dataForSeoCredentials(env({ DATAFORSEO_LOGIN: ' a@b.c ', DATAFORSEO_PASSWORD: ' pw ' })), {
      login: 'a@b.c',
      password: 'pw',
    });
    assert.equal(keywordDataConfigured(env({ DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' })), true);
  });
});

describe('Option B flag', () => {
  test('only the literal "true" switches the env flag on', () => {
    assert.equal(keywordDataFlagOn(env({ ISEO_V3_KEYWORD_DATA: 'true' })), true);
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', '', undefined]) {
      assert.equal(keywordDataFlagOn(env({ ISEO_V3_KEYWORD_DATA: v })), false, `value ${JSON.stringify(v)}`);
    }
  });

  test('effective only when the env flag is on AND the request sent use_keyword_data: true (a boolean)', () => {
    const on = env({ ISEO_V3_KEYWORD_DATA: 'true' });
    const off = env({ ISEO_V3_KEYWORD_DATA: 'false' });
    assert.equal(keywordDataEffective(true, on), true);
    assert.equal(keywordDataEffective('true', on), false);
    assert.equal(keywordDataEffective(1, on), false);
    assert.equal(keywordDataEffective(undefined, on), false);
    assert.equal(keywordDataEffective(true, off), false);
    assert.equal(keywordDataEffective(true, env({})), false);
  });
});

describe('KEYWORD_METRICS_CREDIT_COST', () => {
  test('defaults to 0 (free) when unset or blank, with no warning', () => {
    assert.deepEqual(parseKeywordMetricsCreditCost(undefined), { cost: 0, warning: null });
    assert.deepEqual(parseKeywordMetricsCreditCost(''), { cost: 0, warning: null });
    assert.deepEqual(parseKeywordMetricsCreditCost('  '), { cost: 0, warning: null });
    assert.equal(keywordMetricsCreditCost(env({})), 0);
  });

  test('a clean non-negative integer is used as-is', () => {
    assert.equal(parseKeywordMetricsCreditCost('0').cost, 0);
    assert.equal(parseKeywordMetricsCreditCost('3').cost, 3);
    assert.equal(parseKeywordMetricsCreditCost(' 12 ').cost, 12);
    assert.equal(keywordMetricsCreditCost(env({ KEYWORD_METRICS_CREDIT_COST: '2' })), 2);
  });

  test('a malformed value falls back to 0 and says so', () => {
    for (const raw of ['-1', '1.5', 'abc', '1e3']) {
      const r = parseKeywordMetricsCreditCost(raw);
      assert.equal(r.cost, 0, raw);
      assert.match(r.warning ?? '', /KEYWORD_METRICS_CREDIT_COST/);
    }
  });
});

describe('KEYWORD_DATA_DEFAULTS', () => {
  test('national defaults and the contract limits', () => {
    assert.equal(KEYWORD_DATA_DEFAULTS.locationCode, 2840);
    assert.equal(KEYWORD_DATA_DEFAULTS.languageCode, 'en');
    assert.equal(KEYWORD_DATA_DEFAULTS.cacheTtlDays, 30);
    assert.equal(KEYWORD_DATA_DEFAULTS.fetchBudgetMs, 8000);
    assert.equal(KEYWORD_DATA_DEFAULTS.titleRelatedLimit, 10);
    assert.equal(KEYWORD_DATA_DEFAULTS.plannerRelatedLimit, 30);
    assert.equal(KEYWORD_DATA_DEFAULTS.metricsMaxKeywords, 100);
    assert.ok(Object.isFrozen(KEYWORD_DATA_DEFAULTS));
  });
});
