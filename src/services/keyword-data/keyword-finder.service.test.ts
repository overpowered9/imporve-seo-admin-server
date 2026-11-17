/**
 * The Keyword Finder pipeline, against fake Labs and geo services. No network, no credentials.
 *
 * What is being protected:
 *  1. Discovery comes from the keyword database, so rows arrive with numbers attached — the exact
 *     failure of the gpt-4o generator this replaces (14 of 30 rows blank on a real pull).
 *  2. The seed the user typed never silently disappears.
 *  3. Local figures are used and labelled as local; national ones are never passed off as local.
 *  4. Unscored rows sort last, not into the middle where they would read as mediocre.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKeywordFinderService, FINDER_DEFAULTS, reasonFor } from './keyword-finder.service.js';
import type { DataForSeoClient } from './dataforseo.client.js';
import type { GeoService, GeoStep } from './keyword-geo.service.js';

const US = 2840;
const AUSTIN: GeoStep = {
  location_code: 1026201,
  location_name: 'Austin,Texas,United States',
  location_type: 'City',
  parent_code: 21176,
  depth: 0,
};

type Row = { keyword: string; volume: number | null; kd: number | null; intent: string | null };

function labsFor(seedRow: Row | null, related: Row[], capture?: { depth?: number; limit?: number }): DataForSeoClient {
  const toItem = (r: Row) => ({
    keyword: r.keyword,
    keyword_info: { search_volume: r.volume },
    keyword_properties: { keyword_difficulty: r.kd },
    search_intent_info: { main_intent: r.intent },
  });
  return {
    async keywordOverview() {
      return {
        result: [{ items: seedRow ? [toItem(seedRow)] : [] }],
        cost: 0.012,
        latencyMs: 1,
        taskId: 't',
        attempts: 1,
      } as never;
    },
    async relatedKeywords(params) {
      if (capture) {
        capture.depth = params.depth;
        capture.limit = params.limit;
      }
      return {
        result: [{ items: related.map((r) => ({ keyword_data: toItem(r) })) }],
        cost: 0.0156,
        latencyMs: 1,
        taskId: 't',
        attempts: 1,
      } as never;
    },
    async searchIntent() {
      return { result: [], cost: 0, latencyMs: 1, taskId: 't', attempts: 1 } as never;
    },
  };
}

function geoFor(
  volumes: Record<string, number | null>,
  opts: { level?: GeoStep | null; notice?: string | null } = {},
): GeoService & { calls: number } {
  const svc = {
    calls: 0,
    async searchLocations() {
      return [];
    },
    async resolveLadder() {
      return [AUSTIN];
    },
    async localVolumes(params: { keywords: string[] }) {
      svc.calls += 1;
      return {
        level_used: opts.level === undefined ? AUSTIN : opts.level,
        ladder: [],
        items: params.keywords.map((k) => ({ keyword: k, search_volume: k in volumes ? volumes[k] : null })),
        notice: opts.notice ?? null,
        requests: 1,
        cost_usd: 0.09,
        skipped_keywords: [],
      };
    },
  };
  return svc as unknown as GeoService & { calls: number };
}

const RELATED: Row[] = [
  { keyword: 'best leather wallets for men', volume: 4400, kd: 9, intent: 'commercial' },
  { keyword: 'leather wallets for women', volume: 14800, kd: 35, intent: 'transactional' },
  { keyword: 'how to clean a leather wallet', volume: 720, kd: 4, intent: 'informational' },
  { keyword: 'louis vuitton wallet', volume: 60500, kd: 70, intent: 'navigational' },
];

const SEED_ROW: Row = { keyword: 'leather wallets', volume: 9900, kd: 28, intent: 'commercial' };

describe('discovery', () => {
  test('every row arrives with data, unlike the generator this replaces', async () => {
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), log: () => {} });
    const r = await finder.discover({ seed: 'leather wallets', country_iso: 'us', country_location_code: US });

    assert.equal(r.keywords_without_data, 0);
    assert.equal(r.items.length, RELATED.length + 1);
    assert.ok(r.items.every((i) => i.keyword_difficulty !== null && i.national_volume !== null));
  });

  test('the seed the user typed is always present, even when Labs knows nothing about it', async () => {
    const finder = createKeywordFinderService({ labs: labsFor(null, RELATED), log: () => {} });
    const r = await finder.discover({ seed: 'Leather Wallets', country_iso: 'us', country_location_code: US });

    const seed = r.items.find((i) => i.is_seed);
    assert.ok(seed, 'the seed must never silently disappear');
    assert.equal(seed.keyword, 'leather wallets', 'normalised');
    assert.equal(seed.opportunity_score, null);
    assert.equal(seed.light, 'unknown');
  });

  test('an empty seed is refused rather than paid for', async () => {
    const finder = createKeywordFinderService({ labs: labsFor(null, []), log: () => {} });
    await assert.rejects(() => finder.discover({ seed: '   ', country_iso: 'us', country_location_code: US }), /seed is required/);
  });

  test('mode sets the list size, and depth follows the size', async () => {
    const capture: { depth?: number; limit?: number } = {};
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED, capture), log: () => {} });

    await finder.discover({ seed: 'x', country_iso: 'us', country_location_code: US, mode: 'recommend' });
    assert.equal(capture.limit, FINDER_DEFAULTS.limit.recommend);
    assert.equal(capture.depth, 2, 'a short list does not need the expensive depth');

    await finder.discover({ seed: 'x', country_iso: 'us', country_location_code: US, mode: 'list' });
    assert.equal(capture.limit, FINDER_DEFAULTS.limit.list);
    assert.equal(capture.depth, 3, 'depth 2 tops out around 72 keywords');
  });
});

describe('ranking', () => {
  test('best opportunity first, unscored rows last', async () => {
    const withBlank = [...RELATED, { keyword: 'vegan alternatives to leather wallets', volume: null, kd: null, intent: null }];
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, withBlank), log: () => {} });
    const r = await finder.discover({ seed: 'leather wallets', country_iso: 'us', country_location_code: US });

    const scores = r.items.map((i) => i.opportunity_score);
    const scored = scores.filter((s): s is number => s !== null);
    assert.deepEqual(scored, [...scored].sort((a, b) => b - a), 'descending');
    assert.equal(scores[scores.length - 1], null, 'unmeasured goes last, not into the middle');
    assert.equal(r.keywords_without_data, 1);
  });

  test('a navigational head term is red however big it is', async () => {
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), log: () => {} });
    const r = await finder.discover({ seed: 'leather wallets', country_iso: 'us', country_location_code: US });
    const lv = r.items.find((i) => i.keyword === 'louis vuitton wallet');
    assert.equal(lv?.light, 'red');
  });
});

describe('local volume', () => {
  test('a town figure is used, labelled local, and the national figure is kept beside it', async () => {
    const geo = geoFor({ 'best leather wallets for men': 90, 'leather wallets': 40 });
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), geo, log: () => {} });

    const r = await finder.discover({
      seed: 'leather wallets',
      country_iso: 'us',
      country_location_code: US,
      location_code: AUSTIN.location_code,
    });

    assert.equal(r.level_used?.location_code, AUSTIN.location_code);
    const row = r.items.find((i) => i.keyword === 'best leather wallets for men')!;
    assert.equal(row.volume_scope, 'local');
    assert.equal(row.local_volume, 90);
    assert.equal(row.national_volume, 4400, 'the national figure is not thrown away');
    assert.equal(row.volume_used, 90, 'the score is computed from the local figure');
    assert.match(row.reason, /90 searches a month in Austin/);
  });

  test('90 a month in a town is a green, where it would be a yellow nationally', async () => {
    const geo = geoFor({ 'best leather wallets for men': 90 });
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), geo, log: () => {} });
    const local = await finder.discover({ seed: 'leather wallets', country_iso: 'us', country_location_code: US, location_code: AUSTIN.location_code });
    assert.equal(local.items.find((i) => i.keyword === 'best leather wallets for men')?.light, 'green');
  });

  test('no local level asked for means no Google Ads request at all', async () => {
    const geo = geoFor({});
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), geo, log: () => {} });

    await finder.discover({ seed: 'leather wallets', country_iso: 'us', country_location_code: US });
    assert.equal(geo.calls, 0);

    // Passing the country's own code is a national request, not a local one.
    await finder.discover({ seed: 'leather wallets', country_iso: 'us', country_location_code: US, location_code: US });
    assert.equal(geo.calls, 0);
  });

  test('when local data fails entirely the figures stay national and say so', async () => {
    const geo = geoFor({}, { level: null, notice: 'No local search data came back for Austin, Texas. The figures shown are national.' });
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), geo, log: () => {} });

    const r = await finder.discover({
      seed: 'leather wallets',
      country_iso: 'us',
      country_location_code: US,
      location_code: AUSTIN.location_code,
    });

    assert.equal(r.level_used, null);
    assert.match(r.notice ?? '', /figures shown are national/);
    const row = r.items.find((i) => i.keyword === 'best leather wallets for men')!;
    assert.equal(row.volume_scope, 'national', 'a national figure is never dressed up as local');
    assert.equal(row.volume_used, 4400);
    assert.ok(!/in Austin/.test(row.reason));
  });

  test('asking for a town without the geo service is a programming error, not a silent national result', async () => {
    const finder = createKeywordFinderService({ labs: labsFor(SEED_ROW, RELATED), log: () => {} });
    await assert.rejects(
      () => finder.discover({ seed: 'x', country_iso: 'us', country_location_code: US, location_code: AUSTIN.location_code }),
      /needs the geo service/,
    );
  });
});

describe('reasonFor', () => {
  const row = {
    keyword: 'k',
    is_seed: false,
    national_volume: 500,
    local_volume: null,
    volume_used: 500,
    volume_scope: 'national' as const,
    keyword_difficulty: 10,
    intent: 'commercial' as const,
    opportunity_score: 50,
    light: 'green' as const,
  };

  test('says plainly what is known and never implies what is not', () => {
    assert.match(reasonFor(row, null), /About 500 searches a month, and the pages ranking for it are weak/);
    assert.match(reasonFor({ ...row, keyword_difficulty: 40 }, null), /established pages to get past/);
    assert.match(reasonFor({ ...row, keyword_difficulty: 80 }, null), /dominated by strong sites/);
    assert.match(reasonFor({ ...row, keyword_difficulty: null }, null), /how hard it is to rank for is unknown/);
    assert.match(reasonFor({ ...row, volume_used: 0 }, null), /Nobody appears to search this/);
    assert.match(reasonFor({ ...row, volume_used: null, keyword_difficulty: null }, null), /nothing to judge it on/);
  });

  test('names the town only when the figure is actually a town figure', () => {
    assert.match(reasonFor({ ...row, volume_scope: 'local', volume_used: 60 }, 'Austin'), /in Austin/);
    assert.ok(!/in Austin/.test(reasonFor(row, 'Austin')));
  });
});
