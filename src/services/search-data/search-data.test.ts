import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationIndex, detectTownInKeyword, normalizePlace, parseTown, resolveTown, stripTownFromKeyword } from './towns.js';
import { staticLocationIndexProvider, createLocationIndexProvider } from './locations.js';
import { isThin, lookupSearchData, mergeScoped, parseSerp, searchDataCacheKey } from './search-data.service.js';
import { searchDataConfig, languageCodeFor } from '../../config/search-data.config.js';
import { searchDataBlock } from '../content-v3-steps/xml.js';
import type { DataForSeoSerpClient, DfsLocation, DfsSerpResult, SerpOrganicParams } from '../keyword-data/dataforseo.client.js';

const LOCATIONS: DfsLocation[] = [
  { location_code: 2840, location_name: 'United States', country_iso_code: 'US', location_type: 'Country' },
  { location_code: 21164, location_name: 'New Mexico,United States', country_iso_code: 'US', location_type: 'State' },
  { location_code: 1022563, location_name: 'Espanola,New Mexico,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 1022577, location_name: 'Santa Fe,New Mexico,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 1014221, location_name: 'Springfield,Illinois,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 1023191, location_name: 'Springfield,Missouri,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 1012873, location_name: 'Mobile,Alabama,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 9999999, location_name: 'Paris,Ile-de-France,France', country_iso_code: 'FR', location_type: 'City' },
];
const INDEX = buildLocationIndex(LOCATIONS, 'us');
const CFG = { ...searchDataConfig({}), timeoutMs: 1000 };

describe('towns', () => {
  test('normalisation is accent and case insensitive', () => {
    assert.equal(normalizePlace('  Española,  NM '), 'espanola nm');
    assert.deepEqual(parseTown('Española, NM'), { town: 'Española', state: 'New Mexico' });
    assert.deepEqual(parseTown('Española', 'New Mexico'), { town: 'Española', state: 'New Mexico' });
  });

  test('index keeps only this country and town types', () => {
    assert.equal(INDEX.byName.get('paris'), undefined);
    assert.equal(INDEX.byName.get('new mexico'), undefined);
    assert.equal(INDEX.byName.get('espanola')![0].location_code, 1022563);
  });

  test('resolve: listed, ambiguous without a state, disambiguated by state, alias, coordinate, unresolved', () => {
    assert.deepEqual(resolveTown('Española, NM', INDEX), { status: 'listed', location_code: 1022563, location_name: 'Espanola,New Mexico,United States' });
    assert.deepEqual(resolveTown('Springfield', INDEX), { status: 'unresolved', reason: 'ambiguous' });
    assert.equal((resolveTown('Springfield, MO', INDEX) as any).location_code, 1023191);
    assert.equal((resolveTown('Springfield', INDEX, { stateHint: 'IL' }) as any).location_code, 1014221);
    assert.deepEqual(resolveTown('Chimayó, NM', INDEX, { aliases: { 'Chimayo, NM': 'Espanola,New Mexico,United States' } }), {
      status: 'alias', location_code: 1022563, location_name: 'Espanola,New Mexico,United States',
    });
    assert.deepEqual(resolveTown('Chimayó', INDEX, { coordinate: '36.0019,-105.9353,20000' }), { status: 'coordinate', location_coordinate: '36.0019,-105.9353,20000' });
    assert.deepEqual(resolveTown('Chimayó', INDEX, { coordinate: 'not,a,coordinate' }), { status: 'unresolved', reason: 'not_listed' });
    assert.deepEqual(resolveTown('Española', null), { status: 'unresolved', reason: 'no_location_list' });
  });

  test('detect: target always, multi-word anywhere, one-word only after in/near or before a state', () => {
    assert.deepEqual(detectTownInKeyword('water heater repair espanola', INDEX, 'Española, NM'), { text: 'espanola', name: 'espanola', isTarget: true });
    assert.equal(detectTownInKeyword('roof repair santa fe', INDEX, 'Española')!.name, 'santa fe');
    assert.equal(detectTownInKeyword('mobile home insurance', INDEX), null);
    assert.equal(detectTownInKeyword('plumber in mobile', INDEX)!.name, 'mobile');
    assert.equal(detectTownInKeyword('plumber mobile AL', INDEX)!.name, 'mobile');
    assert.equal(detectTownInKeyword('water heater repair cost', INDEX), null);
  });

  test('strip: town with its preposition and state, accents ignored, no stray punctuation', () => {
    assert.equal(stripTownFromKeyword('water heater repair Española', 'Española, NM'), 'water heater repair');
    assert.equal(stripTownFromKeyword('water heater repair Espanola', 'Española'), 'water heater repair');
    assert.equal(stripTownFromKeyword('water heater repair in Española, NM', 'Española'), 'water heater repair');
    assert.equal(stripTownFromKeyword('Española water heater repair', 'Española'), 'water heater repair');
    assert.equal(stripTownFromKeyword('water heater repair', 'Española'), 'water heater repair');
    assert.equal(stripTownFromKeyword('Española', 'Española'), 'Española');
  });
});

function serp(opts: { titles?: Array<[string, string]>; paa?: string[]; related?: string[] }): DfsSerpResult[] {
  return [{
    items: [
      ...(opts.titles ?? []).map(([title, domain], i) => ({ type: 'organic', rank_group: i + 1, title, domain, url: `https://${domain}/x` })),
      ...(opts.paa ? [{ type: 'people_also_ask', items: opts.paa.map((q) => ({ type: 'people_also_ask_element', title: q })) }] : []),
      ...(opts.related ? [{ type: 'related_searches', items: opts.related }] : []),
      { type: 'images', items: [] },
    ],
  }];
}

function fakeClient(answers: Array<DfsSerpResult[] | Error>): DataForSeoSerpClient & { seen: SerpOrganicParams[] } {
  const seen: SerpOrganicParams[] = [];
  return {
    seen,
    async serpOrganicAdvanced(p) {
      const a = answers[seen.length] ?? answers[answers.length - 1];
      seen.push(p);
      if (a instanceof Error) throw a;
      return { result: a, cost: 0.00215, latencyMs: 5, taskId: 't', attempts: 1 };
    },
    async serpGoogleLocations() {
      return { result: LOCATIONS, cost: 0, latencyMs: 5, taskId: 't', attempts: 1 };
    },
  };
}

const RICH = serp({
  titles: [['Water heater repair in Espanola', 'www.localplumber.com'], ['Hot water heater service', 'nmplumbing.com']],
  paa: ['How much is water heater repair?', 'Is it worth repairing a water heater?', 'How long do water heaters last?'],
  related: ['water heater repair near me', 'tankless water heater repair', 'water heater replacement cost'],
});
const THIN = serp({ titles: [['Espanola plumbing', 'espanolaplumbing.com']], paa: ['How much is water heater repair?'], related: ['water heater repair near me'] });
const NATIONAL = serp({
  titles: [['Water heater repair cost guide', 'homeguide.com'], ['Espanola plumbing', 'espanolaplumbing.com']],
  paa: ['How much is water heater repair?', 'Can I fix a water heater myself?', 'Why is my water heater not heating?'],
  related: ['Water heater repair near me', 'water heater repair cost', 'gas water heater repair'],
});

describe('parse, thin, merge', () => {
  test('parseSerp reads organic title/domain, PAA element titles and related strings', () => {
    const p = parseSerp(RICH);
    assert.deepEqual(p.titles[0], { text: 'Water heater repair in Espanola', domain: 'localplumber.com', url: 'https://www.localplumber.com/x' });
    assert.equal(p.questions.length, 3);
    assert.deepEqual(p.related, ['water heater repair near me', 'tankless water heater repair', 'water heater replacement cost']);
    assert.deepEqual(parseSerp([{ items: null }]), { titles: [], questions: [], related: [] });
  });

  test('thin = fewer than the threshold PAA OR related', () => {
    assert.equal(isThin({ questions: ['a', 'b', 'c'], related: ['a', 'b', 'c'] }, 3), false);
    assert.equal(isThin({ questions: ['a', 'b'], related: ['a', 'b', 'c'] }, 3), true);
    assert.equal(isThin({ questions: ['a', 'b', 'c'], related: [] }, 3), true);
  });

  test('merge: local first, case/punctuation duplicates removed, capped', () => {
    const m = mergeScoped(['A b?', 'c'], ['a B', 'd', 'e'], 3);
    assert.deepEqual(m, [{ text: 'A b?', scope: 'local' }, { text: 'c', scope: 'local' }, { text: 'd', scope: 'national' }]);
  });
});

describe('lookupSearchData', () => {
  test('nationwide: one country call, national items, no fallback flag', async () => {
    const client = fakeClient([RICH]);
    const r = await lookupSearchData({ seed_keyword: 'water heater repair', reach: 'nationwide', target_town: 'Española' }, { client, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(client.seen.length, 1);
    assert.equal(client.seen[0].location_code, 2840);
    assert.equal(client.seen[0].depth, 10);
    assert.equal(client.seen[0].people_also_ask_click_depth, 1);
    assert.equal(client.seen[0].language_code, 'en');
    assert.equal(r.meta.mode, 'national');
    assert.equal(r.block!.national_fallback, false);
    assert.equal(r.block!.location, 'United States');
    assert.ok(r.block!.people_also_ask!.every((i) => i.scope === 'national'));
    assert.deepEqual(r.meta.local_domains, [], 'national domains never feed the competitor filter');
  });

  test('"Not about a specific location": one country call, like nationwide', async () => {
    const client = fakeClient([RICH]);
    const r = await lookupSearchData({ seed_keyword: 'water heater repair', reach: 'local', target_town: '', not_about_location: true }, { client, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(client.seen.length, 1);
    assert.equal(client.seen[0].location_code, 2840);
    assert.equal(r.meta.mode, 'national');
  });

  test('local, rich: one call at the town, local items, local domains kept', async () => {
    const client = fakeClient([RICH]);
    const r = await lookupSearchData({ seed_keyword: 'water heater repair Española', reach: 'local', target_town: 'Española, NM' }, { client, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(client.seen.length, 1);
    assert.equal(client.seen[0].location_code, 1022563);
    assert.equal(r.meta.mode, 'local');
    assert.equal(r.block!.location, 'Española, NM');
    assert.equal(r.block!.national_fallback, false);
    assert.deepEqual(r.meta.local_domains, ['localplumber.com', 'nmplumbing.com']);
    assert.equal(r.meta.town_mismatch, null);
  });

  test('local, thin: second call at the country with the town removed; merged local-first and capped', async () => {
    const logs: string[] = [];
    const client = fakeClient([THIN, NATIONAL]);
    const r = await lookupSearchData({ seed_keyword: 'water heater repair Española', reach: 'local', target_town: 'Española, NM' }, { client, locations: staticLocationIndexProvider(INDEX), config: CFG, log: (l) => logs.push(l) });
    assert.equal(client.seen.length, 2);
    assert.equal(client.seen[1].location_code, 2840);
    assert.equal(client.seen[1].keyword, 'water heater repair');
    assert.equal(r.block!.national_fallback, true);
    assert.deepEqual(r.block!.people_also_ask!.map((i) => i.scope), ['local', 'national', 'national']);
    assert.equal(r.block!.people_also_ask![0].text, 'How much is water heater repair?');
    assert.deepEqual(r.block!.related_searches!.map((i) => i.text), ['water heater repair near me', 'water heater repair cost', 'gas water heater repair']);
    assert.deepEqual(r.block!.ranking_titles!.map((i) => [i.text, i.scope]), [['Espanola plumbing', 'local'], ['Water heater repair cost guide', 'national']]);
    assert.deepEqual(r.meta.local_domains, ['espanolaplumbing.com'], 'national domains stay out even when they repeat a local one');
    assert.equal(r.meta.cost_usd, 0.0043);
    assert.match(logs[0], /^\[search-data\] seed="water heater repair Española" mode=local location="Española, NM" national_fallback=yes local=t1\/q1\/r1 national=t2\/q3\/r3 merged=t2\/q3\/r3 town=listed cost_usd=0\.0043 ms=\d+$/);
    const xml = searchDataBlock(r.block!);
    assert.match(xml, /^<search_data location="Española, NM" national_fallback="yes">/);
    assert.match(xml, /<people_also_ask count="3">/);
  });

  test('caps: 10 titles, 8 questions, 8 related', async () => {
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p} ${i}`);
    const big = serp({ titles: many('t', 15).map((t) => [t, `${t.replace(' ', '')}.com`] as [string, string]), paa: many('q', 12), related: many('r', 12) });
    const r = await lookupSearchData({ seed_keyword: 'x', reach: 'nationwide' }, { client: fakeClient([big]), locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.deepEqual(r.meta.counts, { titles: 10, questions: 8, related: 8 });
  });

  test('a failed local call still runs the country call; everything failing gives a null block', async () => {
    const err = Object.assign(new Error('boom'), { kind: 'server' });
    const r1 = await lookupSearchData({ seed_keyword: 'roof repair', reach: 'local', target_town: 'Española, NM' }, { client: fakeClient([err, NATIONAL]), locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(r1.meta.calls[0].ok, false);
    assert.equal(r1.meta.calls[0].error, 'server');
    assert.equal(r1.block!.national_fallback, true);
    const r2 = await lookupSearchData({ seed_keyword: 'roof repair', reach: 'nationwide' }, { client: fakeClient([err]), locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(r2.block, null);
    const r3 = await lookupSearchData({ seed_keyword: 'roof repair', reach: 'nationwide' }, { client: null, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(r3.block, null);
    assert.equal(r3.meta.calls[0].error, 'not_configured');
  });

  test('a task-level failure is retried once; a transport failure is not', async () => {
    const taskErr = Object.assign(new Error('task status 40101'), { kind: 'auth', level: 'task' });
    const c1 = fakeClient([taskErr, RICH]);
    const r1 = await lookupSearchData({ seed_keyword: 'roof repair', reach: 'local', target_town: 'Española, NM' }, { client: c1, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(c1.seen.length, 2);
    assert.equal(r1.meta.calls.length, 1);
    assert.equal(r1.meta.calls[0].ok, true);
    const netErr = Object.assign(new Error('reset'), { kind: 'network', level: 'transport' });
    const c2 = fakeClient([netErr, RICH]);
    const r2 = await lookupSearchData({ seed_keyword: 'roof repair', reach: 'local', target_town: 'Española, NM' }, { client: c2, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(r2.meta.calls[0].ok, false);
    assert.equal(r2.meta.calls[1].scope, 'national');
  });

  test('an unlisted town: one country call with the keyword as typed, items national', async () => {
    const client = fakeClient([RICH]);
    const r = await lookupSearchData({ seed_keyword: 'roof repair Chimayó', reach: 'local', target_town: 'Chimayó, NM' }, { client, locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.equal(r.meta.mode, 'local_unresolved');
    assert.equal(client.seen.length, 1);
    assert.equal(client.seen[0].keyword, 'roof repair Chimayó');
    assert.equal(client.seen[0].location_code, 2840);
    assert.ok(r.block!.ranking_titles!.every((i) => i.scope === 'national'));
    assert.deepEqual(r.meta.local_domains, []);
  });

  test('W6: the keyword names a different town than the chosen one', async () => {
    const r = await lookupSearchData({ seed_keyword: 'roof repair santa fe', reach: 'local', target_town: 'Española, NM' }, { client: fakeClient([RICH]), locations: staticLocationIndexProvider(INDEX), config: CFG, log: () => {} });
    assert.deepEqual(r.meta.town_mismatch, { keyword_town: 'santa fe', target_town: 'Española' });
  });

  test('language and cache key', () => {
    assert.equal(languageCodeFor('Spanish'), 'es');
    assert.equal(languageCodeFor(''), 'en');
    assert.equal(languageCodeFor('Klingon'), 'en');
    assert.equal(languageCodeFor('US English'), 'en');
    assert.equal(languageCodeFor('UK English'), 'en');
    assert.equal(languageCodeFor('German'), 'de');
    assert.equal(searchDataCacheKey({ seed_keyword: ' Water  Heater ', reach: 'local', target_town: 'Española' }), 'water heater|town:española|en');
    assert.equal(searchDataCacheKey({ seed_keyword: 'water heater', reach: 'nationwide', target_town: 'Española' }), 'water heater|country|en');
  });
});

describe('location index provider', () => {
  test('fetches once, shares in-flight requests, and returns null on failure', async () => {
    let n = 0;
    const client = { ...fakeClient([RICH]), async serpGoogleLocations() { n++; return { result: LOCATIONS, cost: 0, latencyMs: 1, taskId: 't', attempts: 1 }; } };
    const p = createLocationIndexProvider({ client, log: () => {} });
    const [a, b] = await Promise.all([p.get('us'), p.get('US')]);
    assert.equal(n, 1);
    assert.equal(a, b);
    const failing = createLocationIndexProvider({ client: { ...client, async serpGoogleLocations() { throw new Error('down'); } }, log: () => {} });
    assert.equal(await failing.get('us'), null);
  });
});
