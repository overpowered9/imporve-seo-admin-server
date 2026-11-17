/**
 * The optional SERP check, against a fake client. No network, no credentials.
 *
 * The fixtures are the two SERPs measured live on 17 Nov 2026, because the whole design rests on
 * what those pages actually contained:
 *   "leather wallets for women"  ai_overview + 6 popular_products. A buying query.
 *   "water heater repair cost"   18 organic, no shopping, 5 Reddit/Facebook threads in the top 10.
 *
 * What is being protected:
 *  1. extractSite reads breadcrumb/website_name, because `domain` is "google.com" on every row
 *     and `url` is an obfuscated /goto? redirect. Getting this wrong silently breaks the rank
 *     tracker too, which shares this function.
 *  2. Shopping units are counted, because they are the one signal allowed to demote a keyword.
 *  3. User-generated results are counted, because they are the one signal allowed to promote one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSerpSignalService, extractSite, isUgcSite } from './serp-signal.service.js';
import type { DataForSeoSerpClient } from './dataforseo.client.js';

function serpClient(items: unknown[], cost = 0.0035): DataForSeoSerpClient {
  return {
    async serpOrganicAdvanced() {
      return { result: [{ items }], cost, latencyMs: 5, taskId: 't', attempts: 1 } as never;
    },
    async serpGoogleLocations() {
      return { result: [], cost: 0, latencyMs: 1, taskId: 't', attempts: 1 } as never;
    },
  };
}

const organic = (rank: number, breadcrumb: string | null, website_name: string | null, title = 'x') => ({
  type: 'organic',
  rank_group: rank,
  domain: 'google.com',
  url: 'https://google.com/goto?url=CAESigEBxCJF17Fb86',
  breadcrumb,
  website_name,
  title,
});

describe('extractSite', () => {
  test('reads the real host from the breadcrumb, never the google.com redirect', () => {
    assert.equal(
      extractSite({ breadcrumb: 'https://michaelandson.com › blog › how-much-does-it-...', website_name: 'Michael & Son', domain: 'google.com' }),
      'michaelandson.com',
    );
    assert.equal(extractSite({ breadcrumb: 'https://www.homedepot.com › Home Services', website_name: 'The Home Depot' }), 'homedepot.com');
  });

  test('falls back to the platform name when the breadcrumb is engagement text', () => {
    // Social results carry "80+ comments · 3 years ago" instead of a URL.
    assert.equal(extractSite({ breadcrumb: '80+ comments  ·  3 years ago', website_name: 'Reddit · r/homeowners' }), 'reddit');
    assert.equal(extractSite({ breadcrumb: '40+ reactions  ·  2 months ago', website_name: 'Facebook' }), 'facebook');
  });

  test('a bare host in website_name is kept as a host', () => {
    assert.equal(extractSite({ breadcrumb: null, website_name: 'h2oprofessionalservices.com' }), 'h2oprofessionalservices.com');
  });

  test('never reports google.com as the ranking site', () => {
    assert.equal(extractSite({ breadcrumb: null, website_name: null, domain: 'google.com' }), '');
  });
});

describe('isUgcSite', () => {
  test('knows the platforms that signal a beatable page', () => {
    for (const s of ['reddit', 'reddit.com', 'www.reddit.com', 'facebook', 'quora.com', 'youtube.com']) {
      assert.equal(isUgcSite(s), true, s);
    }
    for (const s of ['michaelandson.com', 'homedepot.com', 'angi.com']) {
      assert.equal(isUgcSite(s), false, s);
    }
  });
});

describe('check', () => {
  test('a shopping SERP is not viable for an article', async () => {
    // The "leather wallets for women" shape: product carousels plus an AI overview.
    const items = [
      { type: 'ai_overview' },
      ...Array.from({ length: 6 }, () => ({ type: 'popular_products' })),
      organic(1, 'https://bouletta.com › wallets', 'Bouletta Shop'),
      organic(2, 'https://alvea.com › leather', 'ALVEA'),
    ];
    const svc = createSerpSignalService({ client: serpClient(items), log: () => {} });
    const { signal, cost_usd } = await svc.check({ keyword: 'leather wallets for women', location_code: 2840 });

    assert.equal(signal.shopping_units, 6);
    assert.equal(signal.has_ai_overview, true);
    assert.equal(signal.article_viable, false, 'Google has decided this is a purchase');
    assert.equal(signal.organic_count, 2);
    assert.equal(cost_usd, 0.0035);
  });

  test('a forum-heavy SERP is viable and counted as beatable', async () => {
    // The "water heater repair cost" shape.
    const items = [
      { type: 'ai_overview' },
      organic(1, 'https://michaelandson.com › blog › how-much', 'Michael & Son'),
      organic(2, '80+ comments  ·  3 years ago', 'Reddit · r/homeowners'),
      organic(3, 'https://www.homedepot.com › Home Services', 'The Home Depot'),
      organic(4, 'https://www.angi.com › Plumbing', "Angie's List"),
      organic(5, '260+ comments  ·  1 year ago', 'Facebook · Handyman Business Owners'),
      organic(6, 'https://www.homeserve.com › blog', 'HomeServe USA'),
      organic(7, '40+ reactions  ·  2 months ago', 'Facebook'),
      { type: 'people_also_ask' },
      { type: 'discussions_and_forums' },
    ];
    const svc = createSerpSignalService({ client: serpClient(items), log: () => {} });
    const { signal } = await svc.check({ keyword: 'water heater repair cost', location_code: 2840 });

    assert.equal(signal.shopping_units, 0);
    assert.equal(signal.article_viable, true);
    assert.equal(signal.organic_count, 7);
    assert.equal(signal.ugc_results, 3, 'reddit + two facebook threads');
    assert.deepEqual(
      signal.top.filter((t) => t.is_ugc).map((t) => t.site),
      ['reddit', 'facebook', 'facebook'],
    );
    assert.equal(signal.top[0].site, 'michaelandson.com');
  });

  test('only the first page is judged, however deep the response', async () => {
    const items = Array.from({ length: 25 }, (_, i) => organic(i + 1, `https://site${i}.com › a`, `Site ${i}`));
    const svc = createSerpSignalService({ client: serpClient(items), log: () => {} });
    const { signal } = await svc.check({ keyword: 'x', location_code: 2840, top: 10 });
    assert.equal(signal.organic_count, 10);
    assert.equal(signal.top.length, 10);
  });

  test('an empty page is viable but offers no opening', async () => {
    const svc = createSerpSignalService({ client: serpClient([]), log: () => {} });
    const { signal } = await svc.check({ keyword: 'x', location_code: 2840 });
    assert.equal(signal.organic_count, 0);
    assert.equal(signal.ugc_results, 0);
    assert.equal(signal.article_viable, true);
  });
});
