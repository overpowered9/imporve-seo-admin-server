import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSearchData } from './search-data.default.js';
import { createMemoryContentV3Store } from '../content-v3/store.js';
import { staticLocationIndexProvider } from './locations.js';
import { buildLocationIndex } from './towns.js';
import { searchDataConfig } from '../../config/search-data.config.js';
import type { DataForSeoSerpClient } from '../keyword-data/dataforseo.client.js';

const KEY = 'iseo_tk_0123456789abcdef0123456789abcdef';
const IDS = { userId: 5, websiteId: 9, sessionKey: KEY };

function client(fail = false): DataForSeoSerpClient & { calls: number } {
  const c = {
    calls: 0,
    async serpOrganicAdvanced() {
      c.calls++;
      if (fail) throw Object.assign(new Error('x'), { kind: 'server' });
      return {
        result: [{ items: [
          { type: 'organic', title: 'Water heater repair cost', domain: 'a.com', url: 'https://a.com' },
          { type: 'people_also_ask', items: [{ type: 'people_also_ask_element', title: 'Q1?' }, { type: 'people_also_ask_element', title: 'Q2?' }, { type: 'people_also_ask_element', title: 'Q3?' }] },
          { type: 'related_searches', items: ['r1', 'r2', 'r3'] },
        ] }],
        cost: 0.002, latencyMs: 1, taskId: 't', attempts: 1,
      };
    },
    async serpGoogleLocations() {
      return { result: [], cost: 0, latencyMs: 1, taskId: 't', attempts: 1 };
    },
  };
  return c;
}

const deps = (c: DataForSeoSerpClient) => ({ client: c, locations: staticLocationIndexProvider(buildLocationIndex([], 'us')), config: searchDataConfig({}), log: () => {} });

describe('sessionSearchData (S9, W12)', () => {
  test('second request in the same session with the same keyword is served from the session', async () => {
    const store = createMemoryContentV3Store();
    const c = client();
    const a = await sessionSearchData(store, IDS, { seed_keyword: 'water heater repair', reach: 'nationwide' }, deps(c));
    const b = await sessionSearchData(store, IDS, { seed_keyword: 'Water heater repair', reach: 'nationwide' }, deps(c));
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(c.calls, 1);
    assert.deepEqual(b.block, a.block);
  });

  test('a different keyword or another site is a new lookup', async () => {
    const store = createMemoryContentV3Store();
    const c = client();
    await sessionSearchData(store, IDS, { seed_keyword: 'water heater repair', reach: 'nationwide' }, deps(c));
    await sessionSearchData(store, IDS, { seed_keyword: 'tankless water heater', reach: 'nationwide' }, deps(c));
    await sessionSearchData(store, { ...IDS, websiteId: 10 }, { seed_keyword: 'tankless water heater', reach: 'nationwide' }, deps(c));
    assert.equal(c.calls, 3);
  });

  test('a lookup where every call failed is not stored, so the next click retries', async () => {
    const store = createMemoryContentV3Store();
    const bad = client(true);
    const a = await sessionSearchData(store, IDS, { seed_keyword: 'x', reach: 'nationwide' }, deps(bad));
    assert.equal(a.block, null);
    assert.equal(await store.getSession(5, 9, KEY), null);
    const good = client();
    const b = await sessionSearchData(store, IDS, { seed_keyword: 'x', reach: 'nationwide' }, deps(good));
    assert.equal(b.cached, false);
    assert.equal(good.calls, 1);
  });

  test('no session key: plain lookup, nothing stored', async () => {
    const store = createMemoryContentV3Store();
    const c = client();
    await sessionSearchData(store, { ...IDS, sessionKey: null }, { seed_keyword: 'x', reach: 'nationwide' }, deps(c));
    await sessionSearchData(store, { ...IDS, sessionKey: null }, { seed_keyword: 'x', reach: 'nationwide' }, deps(c));
    assert.equal(c.calls, 2);
  });
});
