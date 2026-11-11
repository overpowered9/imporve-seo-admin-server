/**
 * The keyword data cache against the fake postgres.js tag, plus source assertions on migration 022.
 *
 * What is being protected:
 *  1. A read only ever returns a LIVE row: the query filters on expires_at > NOW().
 *  2. The key is the normalised keyword + location + language.
 *  3. Writes are upserts on the primary key, with expires_at derived from fetched_at and the TTL.
 *  4. Every failure is swallowed and logged — the cache fails open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import { createKeywordDataCache, createMemoryKeywordDataCache } from './keyword-data-cache.js';
import type { KeywordMetricsItem } from './keyword-data.types.js';

const AT = '2026-11-11T10:00:00.000Z';
const item = (keyword: string, search_volume: number | null = null): KeywordMetricsItem => ({
  keyword,
  search_volume,
  keyword_difficulty: null,
  intent: null,
  scope: 'national',
  fetched_at: AT,
});

describe('getMetrics', () => {
  test('a hit comes back keyed by keyword, re-normalised, with an ISO fetched_at', async () => {
    const sql = createFakeSql().when(/FROM keyword_metrics_cache/, [
      { keyword: 'water heater', search_volume: '2400', keyword_difficulty: 18, intent: 'commercial', fetched_at: new Date(AT) },
    ]);
    const cache = createKeywordDataCache({ sql, log: () => {} });
    const out = await cache.getMetrics(['  Water Heater ', 'other'], 2840, 'EN');
    assert.equal(out.size, 1);
    assert.deepEqual(out.get('water heater'), {
      keyword: 'water heater',
      search_volume: 2400,
      keyword_difficulty: 18,
      intent: 'commercial',
      scope: 'national',
      fetched_at: AT,
    });
    const q = sql.matching(/FROM keyword_metrics_cache/)[0];
    assert.match(q.text, /expires_at > NOW\(\)/);
    assert.match(q.text, /keyword = ANY\(\?\)/);
    assert.deepEqual(q.params, [2840, 'en', ['water heater', 'other']]);
  });

  test('a miss is an empty map, and an empty request runs no query', async () => {
    const sql = createFakeSql();
    const cache = createKeywordDataCache({ sql, log: () => {} });
    assert.equal((await cache.getMetrics(['x'], 2840, 'en')).size, 0);
    assert.equal((await cache.getMetrics(['', '  '], 2840, 'en')).size, 0);
    assert.equal(sql.countMatching(/FROM keyword_metrics_cache/), 1);
  });

  test('fails open: a missing table is a miss plus one log line, never a throw', async () => {
    const logs: string[] = [];
    const sql = createFakeSql().failOn(/keyword_metrics_cache/, new Error('relation "keyword_metrics_cache" does not exist'));
    const cache = createKeywordDataCache({ sql, log: (l) => logs.push(l) });
    assert.equal((await cache.getMetrics(['x'], 2840, 'en')).size, 0);
    await cache.putMetrics([item('x', 1)], 2840, 'en');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /\[keyword-data\] cache unavailable \(getMetrics\): relation/);
    assert.match(logs[1], /cache unavailable \(putMetrics\)/);
  });
});

describe('putMetrics', () => {
  test('upserts one row per item inside a transaction, expiring TTL days after fetched_at', async () => {
    const sql = createFakeSql();
    const cache = createKeywordDataCache({ sql, log: () => {} });
    await cache.putMetrics([item('A', 10), item('b', null), item('  ', 1)], 2840, 'en');
    const writes = sql.matching(/INSERT INTO keyword_metrics_cache/);
    assert.equal(writes.length, 2, 'blank keywords are skipped');
    assert.match(writes[0].text, /ON CONFLICT \(keyword, location_code, language_code\) DO UPDATE/);
    assert.match(writes[0].text, /make_interval\(days => \?\)/);
    assert.deepEqual(writes[0].params, ['a', 2840, 'en', 10, null, null, AT, AT, 30]);
    assert.equal(writes[1].params[0], 'b');
  });

  test('honours a custom TTL', async () => {
    const sql = createFakeSql();
    const cache = createKeywordDataCache({ sql, ttlDays: 7, log: () => {} });
    await cache.putMetrics([item('a', 1)], 2840, 'en');
    assert.equal(sql.matching(/INSERT INTO keyword_metrics_cache/)[0].params.at(-1), 7);
  });
});

describe('related', () => {
  test('getRelated reads the live row and parses JSONB whether it arrives parsed or as text', async () => {
    const related = [item('a b', 5), { keyword: 'c', search_volume: 'junk' }];
    const sqlObj = createFakeSql().when(/FROM keyword_related_cache/, [{ related, fetched_at: new Date(AT) }]);
    const hit = await createKeywordDataCache({ sql: sqlObj, log: () => {} }).getRelated(' Seed ', 2840, 'en');
    assert.equal(hit?.fetched_at, AT);
    assert.deepEqual(hit?.related.map((i) => [i.keyword, i.search_volume]), [['a b', 5], ['c', null]]);
    const q = sqlObj.matching(/FROM keyword_related_cache/)[0];
    assert.match(q.text, /expires_at > NOW\(\)/);
    assert.deepEqual(q.params, ['seed', 2840, 'en']);

    const sqlText = createFakeSql().when(/FROM keyword_related_cache/, [{ related: JSON.stringify(related), fetched_at: AT }]);
    const hit2 = await createKeywordDataCache({ sql: sqlText, log: () => {} }).getRelated('seed', 2840, 'en');
    assert.equal(hit2?.related.length, 2);
  });

  test('getRelated misses return null; putRelated upserts the JSON list', async () => {
    const sql = createFakeSql();
    const cache = createKeywordDataCache({ sql, log: () => {} });
    assert.equal(await cache.getRelated('seed', 2840, 'en'), null);
    await cache.putRelated('Seed', 2840, 'en', [item('a', 1)], AT);
    const w = sql.matching(/INSERT INTO keyword_related_cache/)[0];
    assert.match(w.text, /ON CONFLICT \(seed, location_code, language_code\) DO UPDATE/);
    assert.equal(w.params[0], 'seed');
    assert.deepEqual(JSON.parse(w.params[3]), [item('a', 1)]);
    assert.equal(w.params.at(-1), 30);
  });
});

describe('memory cache (test double with the same contract)', () => {
  test('hits until the TTL passes', async () => {
    let t = new Date(AT).getTime();
    const cache = createMemoryKeywordDataCache(() => new Date(t), 30);
    await cache.putMetrics([item('a', 1)], 2840, 'en');
    assert.equal((await cache.getMetrics(['A'], 2840, 'en')).size, 1);
    t += 31 * 24 * 60 * 60 * 1000;
    assert.equal((await cache.getMetrics(['a'], 2840, 'en')).size, 0);
  });
});

describe('migration 022', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const migration = fs.readFileSync(path.join(SRC, 'migrations/022-keyword-data-cache.ts'), 'utf8');
  const printer = fs.readFileSync(path.join(SRC, 'scripts/print-migrations.ts'), 'utf8');
  const pkg = fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8');

  test('creates both tables idempotently, keyed by (keyword|seed, location, language)', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS keyword_metrics_cache/);
    assert.match(migration, /PRIMARY KEY \(keyword, location_code, language_code\)/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS keyword_related_cache/);
    assert.match(migration, /PRIMARY KEY \(seed, location_code, language_code\)/);
    assert.match(migration, /expires_at\s+TIMESTAMPTZ NOT NULL/);
  });

  test('closed to the public REST API', () => {
    assert.match(migration, /ALTER TABLE keyword_metrics_cache ENABLE ROW LEVEL SECURITY;/);
    assert.match(migration, /ALTER TABLE keyword_related_cache ENABLE ROW LEVEL SECURITY;/);
  });

  test('is in the paste-able migrations:print output and has an npm entry point', () => {
    assert.match(printer, /'\.\.\/migrations\/022-keyword-data-cache\.js'/);
    assert.match(pkg, /"migrate:keyword-data-cache": "tsx src\/migrations\/022-keyword-data-cache\.ts"/);
  });
});
