import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSql } from '../../test/helpers/fake-sql.js';
import { createContentV3Store, createMemoryContentV3Store, MAX_SESSION_BYTES } from './store.js';

const KEY = 'iseo_tk_0123456789abcdef0123456789abcdef';

describe('sessions', () => {
  test('get is scoped to user + website + key and only returns live rows', async () => {
    const sql = createFakeSql().when(/FROM content_v3_sessions/, [{ data: { title: 'T' } }]);
    const store = createContentV3Store({ sql, ttlDays: 7, log: () => {} });
    assert.deepEqual(await store.getSession(5, 9, KEY), { title: 'T' });
    const q = sql.matching(/FROM content_v3_sessions/)[0];
    assert.match(q.text, /user_id = \? AND website_id = \? AND session_key = \?/);
    assert.match(q.text, /expires_at > NOW\(\)/);
    assert.deepEqual(q.params, [5, 9, KEY]);
  });

  test('a bad key or id never reaches the database', async () => {
    const sql = createFakeSql();
    const store = createContentV3Store({ sql, ttlDays: 7, log: () => {} });
    assert.equal(await store.getSession(5, 9, "x'; drop table"), null);
    assert.equal(await store.getSession(0, 9, KEY), null);
    assert.equal(await store.mergeSession(5, 9, 'short', { a: 1 }), false);
    assert.equal(sql.queries.length, 0);
  });

  test('merge is a JSONB || upsert that resets an expired row and pushes expiry out by the TTL', async () => {
    const sql = createFakeSql();
    const store = createContentV3Store({ sql, ttlDays: 7, log: () => {} });
    assert.equal(await store.mergeSession(5, 9, KEY, { search_data: { location: 'United States' } }), true);
    const q = sql.matching(/INSERT INTO content_v3_sessions/)[0];
    assert.match(q.text, /ON CONFLICT \(user_id, website_id, session_key\) DO UPDATE/);
    assert.match(q.text, /content_v3_sessions\.data \|\| EXCLUDED\.data ELSE EXCLUDED\.data/);
    assert.match(q.text, /make_interval\(days => \?\)/);
    assert.equal(q.params[4], 7);
    assert.equal(q.params[3], JSON.stringify({ search_data: { location: 'United States' } }));
  });

  test('an oversized patch is refused without a query', async () => {
    const logs: string[] = [];
    const sql = createFakeSql();
    const store = createContentV3Store({ sql, ttlDays: 7, log: (l) => logs.push(l) });
    assert.equal(await store.mergeSession(5, 9, KEY, { big: 'x'.repeat(MAX_SESSION_BYTES + 1) }), false);
    assert.equal(sql.queries.length, 0);
    assert.match(logs[0], /session patch skipped/);
  });

  test('fails open: a missing table is a miss and one log line, never a throw, never the data', async () => {
    const logs: string[] = [];
    const sql = createFakeSql().failOn(/content_v3_sessions/, new Error('relation "content_v3_sessions" does not exist'));
    const store = createContentV3Store({ sql, ttlDays: 7, log: (l) => logs.push(l) });
    assert.equal(await store.getSession(5, 9, KEY), null);
    assert.equal(await store.mergeSession(5, 9, KEY, { secret_answer: 'owner text' }), false);
    assert.equal(await store.deleteSession(5, 9, KEY), false);
    assert.equal(logs.length, 3);
    assert.ok(logs.every((l) => l.startsWith('[content-v3] store unavailable')));
    assert.doesNotMatch(logs.join('\n'), /owner text/);
  });

  test('delete is scoped the same way', async () => {
    const sql = createFakeSql();
    const store = createContentV3Store({ sql, ttlDays: 7, log: () => {} });
    assert.equal(await store.deleteSession(5, 9, KEY), true);
    assert.deepEqual(sql.matching(/DELETE FROM content_v3_sessions/)[0].params, [5, 9, KEY]);
  });
});

describe('posts', () => {
  test('recordPost stores picks and headings as JSONB; recentPosts reads newest first for the site', async () => {
    const sql = createFakeSql().when(/FROM content_v3_posts/, [
      { user_id: 5, website_id: 9, picks: '{"opening":"reader_situation"}', headings: '["A","B"]', article_type: 'cost', created_at: new Date('2026-11-14T00:00:00Z') },
    ]);
    const store = createContentV3Store({ sql, ttlDays: 7, log: () => {} });
    assert.equal(await store.recordPost({ user_id: 5, website_id: 9, picks: { opening: 'reader_situation' }, headings: ['A', 'B'], article_type: 'cost' }), true);
    const ins = sql.matching(/INSERT INTO content_v3_posts/)[0];
    assert.ok(ins.params.includes('{"opening":"reader_situation"}'));
    const rows = await store.recentPosts(5, 9, 20);
    assert.deepEqual(rows[0].picks, { opening: 'reader_situation' });
    assert.deepEqual(rows[0].headings, ['A', 'B']);
    assert.match(sql.matching(/FROM content_v3_posts/)[0].text, /ORDER BY created_at DESC, id DESC LIMIT \?/);
  });

  test('purge deletes expired sessions and old post rows', async () => {
    const sql = createFakeSql().when(/DELETE FROM content_v3_sessions/, [{}, {}]).when(/DELETE FROM content_v3_posts/, [{}]);
    const store = createContentV3Store({ sql, ttlDays: 7, log: () => {} });
    assert.equal(await store.purge(), 3);
  });
});

describe('memory store', () => {
  test('same merge semantics', async () => {
    const m = createMemoryContentV3Store();
    await m.mergeSession(1, 2, KEY, { a: 1 });
    await m.mergeSession(1, 2, KEY, { b: 2 });
    assert.deepEqual(await m.getSession(1, 2, KEY), { a: 1, b: 2 });
    assert.equal(await m.getSession(1, 3, KEY), null);
    await m.deleteSession(1, 2, KEY);
    assert.equal(await m.getSession(1, 2, KEY), null);
  });
});

describe('migration 023', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../../migrations/023-content-v3-store.ts'), 'utf8');
  test('idempotent DDL with RLS on both tables and cascade on user and website delete', () => {
    assert.match(src, /CREATE TABLE IF NOT EXISTS content_v3_sessions/);
    assert.match(src, /CREATE TABLE IF NOT EXISTS content_v3_posts/);
    for (const t of ['content_v3_sessions', 'content_v3_posts', 'schema_migrations']) {
      assert.match(src, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), t);
    }
    assert.equal((src.match(/REFERENCES users\(id\) ON DELETE CASCADE/g) || []).length, 2);
    assert.equal((src.match(/REFERENCES websites\(id\) ON DELETE CASCADE/g) || []).length, 2);
    assert.match(src, /PRIMARY KEY \(user_id, website_id, session_key\)/);
  });

  test('records itself in schema_migrations and ships its reversal (DOWN_SQL)', () => {
    assert.match(src, /INSERT INTO schema_migrations \(id\) VALUES \('023-content-v3-store'\) ON CONFLICT \(id\) DO NOTHING;/);
    assert.match(src, /export const DOWN_SQL = `\nDROP TABLE IF EXISTS content_v3_posts;\nDROP TABLE IF EXISTS content_v3_sessions;/);
  });
});
