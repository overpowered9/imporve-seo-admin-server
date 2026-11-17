/**
 * The city -> state -> country ladder, against a fake Google Ads client. No network, no credentials.
 *
 * What is being protected:
 *  1. The ladder is the parent chain, not a guess at Google's location-type names.
 *  2. A figure carries the level it was measured at, and an escalation is always announced.
 *  3. Cost: one request per level, never per keyword, and never more levels than the cap.
 *  4. Keywords Google Ads would reject never reach the network and are reported, not dropped.
 *  5. null (Google said nothing) and 0 (Google said zero) stay distinct all the way through.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeoService,
  friendlyLocationName,
  requiredCoverage,
  GEO_SUFFICIENCY,
} from './keyword-geo.service.js';
import type { DataForSeoAdsClient, DfsAdsSearchVolumeItem, DfsLocation } from './dataforseo.client.js';

const US_LOCATIONS: DfsLocation[] = [
  { location_code: 2840, location_name: 'United States', location_code_parent: null, country_iso_code: 'US', location_type: 'Country' },
  { location_code: 21176, location_name: 'Texas,United States', location_code_parent: 2840, country_iso_code: 'US', location_type: 'State' },
  { location_code: 1026201, location_name: 'Austin,Texas,United States', location_code_parent: 21176, country_iso_code: 'US', location_type: 'City' },
  { location_code: 1026339, location_name: 'Port Austin,Michigan,United States', location_code_parent: 2840, country_iso_code: 'US', location_type: 'City' },
  { location_code: 9999, location_name: 'Española,New Mexico,United States', location_code_parent: 21176, country_iso_code: 'US', location_type: 'City' },
];

interface FakeCall {
  location_code: number;
  keywords: string[];
}

/** volumesByLocation: location_code -> keyword -> volume (missing = Google returned nothing). */
function makeClient(volumesByLocation: Record<number, Record<string, number | null>>, opts: { locationsCost?: number } = {}) {
  const calls: FakeCall[] = [];
  let locationsCalls = 0;
  const client: DataForSeoAdsClient = {
    async adsLocations() {
      locationsCalls += 1;
      return { result: US_LOCATIONS, cost: opts.locationsCost ?? 0, latencyMs: 1, taskId: 't', attempts: 1 };
    },
    async adsSearchVolume(params) {
      calls.push({ location_code: params.location_code, keywords: [...params.keywords] });
      const table = volumesByLocation[params.location_code] ?? {};
      const result: DfsAdsSearchVolumeItem[] = [];
      for (const k of params.keywords) {
        if (!(k in table)) continue; // Google returned nothing for this keyword at this location.
        result.push({ keyword: k, search_volume: table[k], location_code: params.location_code, language_code: 'en' });
      }
      return { result, cost: 0.09, latencyMs: 5, taskId: 't', attempts: 1 };
    },
  };
  return { client, calls, locationsCalls: () => locationsCalls };
}

const KWS = ['plumber austin', 'water heater repair', 'drain cleaning', 'emergency plumber', 'sump pump replacement', 'leak detection'];

describe('requiredCoverage', () => {
  test('scales with the list but keeps a floor, and never exceeds the list', () => {
    assert.equal(requiredCoverage(0), 0);
    // Floor applies to small lists, capped at the list size itself.
    assert.equal(requiredCoverage(3), 3);
    assert.equal(requiredCoverage(5), 5);
    // Ratio takes over once it exceeds the floor.
    assert.equal(requiredCoverage(20), 5);
    assert.equal(requiredCoverage(50), 10);
    assert.equal(requiredCoverage(100), 20);
  });
});

describe('friendlyLocationName', () => {
  test('drops the country a picker already implies', () => {
    assert.equal(friendlyLocationName({ location_code: 1, location_name: 'Austin,Texas,United States', location_type: 'City', parent_code: null, depth: 0 }), 'Austin, Texas');
    assert.equal(friendlyLocationName({ location_code: 1, location_name: 'Texas,United States', location_type: 'State', parent_code: null, depth: 0 }), 'Texas');
    assert.equal(friendlyLocationName({ location_code: 1, location_name: 'United States', location_type: 'Country', parent_code: null, depth: 0 }), 'United States');
  });
});

describe('resolveLadder', () => {
  test('walks the parent chain from the chosen location to the country', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    const ladder = await geo.resolveLadder('us', 1026201);
    assert.deepEqual(
      ladder.map((s) => [s.depth, s.location_code, s.location_type]),
      [
        [0, 1026201, 'City'],
        [1, 21176, 'State'],
        [2, 2840, 'Country'],
      ],
    );
  });

  test('a city whose parent is the country gives a two-rung ladder, no invented state', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    const ladder = await geo.resolveLadder('us', 1026339);
    assert.deepEqual(ladder.map((s) => s.location_code), [1026339, 2840]);
  });

  test('rejects a location code that is not in the country list', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    await assert.rejects(() => geo.resolveLadder('us', 424242), /not a Google Ads location/);
  });

  test('the free location list is fetched once and reused', async () => {
    const { client, locationsCalls } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    await geo.resolveLadder('us', 1026201);
    await geo.resolveLadder('us', 21176);
    await geo.searchLocations('us', 'austin');
    assert.equal(locationsCalls(), 1);
  });
});

describe('searchLocations', () => {
  test('a name starting with the query outranks one merely containing it', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    const found = await geo.searchLocations('us', 'austin');
    assert.deepEqual(found.map((f) => f.location_code), [1026201, 1026339]);
  });

  test('an empty query returns nothing rather than the whole country', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    assert.deepEqual(await geo.searchLocations('us', '   '), []);
  });
});

describe('localVolumes', () => {
  test('uses the chosen city when it has enough data, and says nothing about escalating', async () => {
    const city = Object.fromEntries(KWS.map((k, i) => [k, 100 + i * 10]));
    const { client, calls } = makeClient({ 1026201: city });
    const geo = createGeoService({ client, log: () => {} });

    const r = await geo.localVolumes({ keywords: KWS, country_iso: 'us', location_code: 1026201 });

    assert.equal(r.level_used?.location_code, 1026201);
    assert.equal(r.notice, null);
    assert.equal(r.requests, 1, 'one request for the whole list, not one per keyword');
    assert.equal(calls.length, 1);
    assert.equal(r.items.find((i) => i.keyword === 'plumber austin')?.search_volume, 100);
    assert.equal(r.ladder[0].sufficient, true);
    assert.equal(r.ladder[1].attempted, false, 'no reason to pay for a wider level');
  });

  test('escalates to the state when the city is too thin, and names both levels', async () => {
    const { client, calls } = makeClient({
      1026201: { 'plumber austin': 20 }, // 1 of 6 covered: below the floor of 5
      21176: Object.fromEntries(KWS.map((k, i) => [k, 500 + i])),
    });
    const geo = createGeoService({ client, log: () => {} });

    const r = await geo.localVolumes({ keywords: KWS, country_iso: 'us', location_code: 1026201 });

    assert.equal(r.level_used?.location_code, 21176);
    assert.equal(r.requests, 2);
    assert.deepEqual(calls.map((c) => c.location_code), [1026201, 21176]);
    assert.match(r.notice ?? '', /Not enough search data for Austin, Texas/);
    assert.match(r.notice ?? '', /1 of 6 keywords had figures/);
    assert.match(r.notice ?? '', /Showing Texas figures instead \(6 of 6\)/);
    assert.equal(r.items.find((i) => i.keyword === 'plumber austin')?.search_volume, 500);
  });

  test('a level that returns zero volumes is not "covered" — zero demand cannot rank a list', async () => {
    const { client } = makeClient({
      9999: Object.fromEntries(KWS.map((k) => [k, 0])), // Google answered, but with nothing to choose between
      21176: Object.fromEntries(KWS.map((k, i) => [k, 300 + i])),
    });
    const geo = createGeoService({ client, log: () => {} });

    const r = await geo.localVolumes({ keywords: KWS, country_iso: 'us', location_code: 9999 });

    assert.equal(r.ladder[0].covered, 0);
    assert.equal(r.ladder[0].sufficient, false);
    assert.equal(r.level_used?.location_code, 21176);
  });

  test('when no level clears the bar it uses the level that knew most, not the widest', async () => {
    const { client } = makeClient({
      1026201: { 'plumber austin': 20, 'drain cleaning': 30 }, // 2 covered
      21176: { 'plumber austin': 40 }, // 1 covered
      2840: {}, // nothing
    });
    const geo = createGeoService({ client, log: () => {} });

    const r = await geo.localVolumes({ keywords: KWS, country_iso: 'us', location_code: 1026201 });

    assert.equal(r.level_used?.location_code, 1026201, 'the city knew most, so its figures stand');
    assert.equal(r.requests, 3);
    assert.equal(r.notice, null, 'the chosen level was used, so there is nothing to announce');
  });

  test('never asks more levels than the cap, however deep the chain', async () => {
    const { client, calls } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    const r = await geo.localVolumes({ keywords: KWS, country_iso: 'us', location_code: 1026201 });
    assert.ok(calls.length <= GEO_SUFFICIENCY.maxLevels);
    assert.equal(r.requests, 3);
    assert.equal(r.level_used, null);
    assert.match(r.notice ?? '', /No local search data came back for Austin, Texas/);
    assert.ok(r.items.every((i) => i.search_volume === null));
  });

  test('keywords Google Ads would reject never reach the network and are reported', async () => {
    const long = 'a'.repeat(81);
    const emoji = 'leather wallet 🧡';
    const { client, calls } = makeClient({ 1026201: Object.fromEntries(KWS.map((k, i) => [k, 10 + i])) });
    const geo = createGeoService({ client, log: () => {} });

    const r = await geo.localVolumes({ keywords: [...KWS, long, emoji], country_iso: 'us', location_code: 1026201 });

    assert.deepEqual(r.skipped_keywords, [long, emoji]);
    assert.ok(!calls[0].keywords.includes(long));
    assert.ok(!calls[0].keywords.includes(emoji));
    // Still present in the output, with no number — dropped from the request, not from the answer.
    assert.equal(r.items.find((i) => i.keyword === long)?.search_volume, null);
    assert.equal(r.items.length, KWS.length + 2);
  });

  test('zero and unknown stay distinct', async () => {
    const { client } = makeClient({
      1026201: { 'plumber austin': 0, 'water heater repair': 90, 'drain cleaning': 80, 'emergency plumber': 70, 'sump pump replacement': 60, 'leak detection': 50 },
    });
    const geo = createGeoService({ client, log: () => {} });
    const r = await geo.localVolumes({ keywords: [...KWS, 'never asked about'], country_iso: 'us', location_code: 1026201 });
    assert.equal(r.items.find((i) => i.keyword === 'plumber austin')?.search_volume, 0, 'Google said zero');
    assert.equal(r.items.find((i) => i.keyword === 'never asked about')?.search_volume, null, 'Google said nothing');
  });

  test('normalises and de-duplicates before paying for a request', async () => {
    const { client, calls } = makeClient({ 1026201: { 'plumber austin': 10 } });
    const geo = createGeoService({ client, log: () => {} });
    const r = await geo.localVolumes({
      keywords: ['Plumber Austin', 'plumber  austin ', 'PLUMBER AUSTIN'],
      country_iso: 'us',
      location_code: 1026201,
    });
    assert.deepEqual(calls[0].keywords, ['plumber austin']);
    assert.equal(r.items.length, 1);
  });

  test('an empty keyword list costs nothing', async () => {
    const { client, calls } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    const r = await geo.localVolumes({ keywords: [], country_iso: 'us', location_code: 1026201 });
    assert.equal(calls.length, 0);
    assert.equal(r.requests, 0);
    assert.equal(r.cost_usd, 0);
  });
});

describe('countryLocationCode', () => {
  test('finds the country row, which is the only one without a parent', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    assert.equal(await geo.countryLocationCode('us'), 2840);
    assert.equal(await geo.countryLocationCode('US'), 2840, 'case does not matter');
  });

  test('refuses rather than guessing when the country row is absent', async () => {
    const { client } = makeClient({});
    const geo = createGeoService({ client, log: () => {} });
    await assert.rejects(() => geo.countryLocationCode('gb'), /no country row/);
  });
});
