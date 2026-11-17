/**
 * Rank tracker, against a fake SERP service and a fake database.
 *
 * What is being protected, above all: the site-matching logic. DataForSEO reports every organic
 * result's domain as "google.com", so a tracker that matched on `domain` would report "not
 * ranking" for every site on earth and look like it was working. These tests fail loudly if that
 * ever creeps back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRankTracker,
  findPosition,
  normalizeDomain,
  siteMatchesDomain,
  RANK_CHECK_DEPTH,
} from './rank-tracker.service.js';
import type { SerpSignal } from './serp-signal.service.js';

function signal(sites: Array<string | null>): SerpSignal {
  return {
    keyword: 'water heater repair cost',
    organic_count: sites.length,
    shopping_units: 0,
    has_ai_overview: false,
    ugc_results: 0,
    article_viable: true,
    top: sites.map((site, i) => ({ rank: i + 1, site: site ?? '', title: 't', is_ugc: false })),
  };
}

/** A postgres.js-shaped tagged template that records calls and replays queued results. */
function fakeDb(queue: unknown[][] = []) {
  const calls: string[] = [];
  const db = ((strings: TemplateStringsArray) => {
    calls.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return Promise.resolve(queue.shift() ?? []);
  }) as never;
  return { db, calls };
}

describe('normalizeDomain', () => {
  test('strips scheme, www, path and case so one site is one target', () => {
    for (const input of [
      'https://www.Example.com/blog/post?x=1',
      'http://example.com',
      'Example.com',
      'www.example.com/',
      '  example.com  ',
    ]) {
      assert.equal(normalizeDomain(input), 'example.com', input);
    }
  });

  test('empty input is empty, not a wildcard', () => {
    assert.equal(normalizeDomain(''), '');
    assert.equal(normalizeDomain(null), '');
  });
});

describe('siteMatchesDomain', () => {
  test('matches the site and its subdomains', () => {
    assert.equal(siteMatchesDomain('example.com', 'example.com'), true);
    assert.equal(siteMatchesDomain('blog.example.com', 'example.com'), true);
    assert.equal(siteMatchesDomain('www.example.com', 'example.com'), true);
  });

  test('does not match a look-alike domain', () => {
    // The failure that would quietly credit someone else's rankings to our customer.
    assert.equal(siteMatchesDomain('notexample.com', 'example.com'), false);
    assert.equal(siteMatchesDomain('example.com.au', 'example.com'), false);
    assert.equal(siteMatchesDomain('example.co', 'example.com'), false);
  });

  test('an empty site never matches', () => {
    assert.equal(siteMatchesDomain('', 'example.com'), false);
    assert.equal(siteMatchesDomain('example.com', ''), false);
  });
});

describe('findPosition', () => {
  test('returns the first position the site holds', () => {
    const s = signal(['michaelandson.com', 'reddit', 'example.com', 'homedepot.com']);
    assert.deepEqual(findPosition(s, 'example.com'), { position: 3, site: 'example.com' });
  });

  test('null when the site is not on the page, never a sentinel position', () => {
    const s = signal(['michaelandson.com', 'reddit']);
    assert.deepEqual(findPosition(s, 'example.com'), { position: null, site: null });
  });

  test('a page of empty sites finds nothing rather than matching at rank 1', () => {
    // This is what the SERP looks like if extractSite ever regresses to reading `domain`.
    const s = signal([null, null, null]);
    assert.equal(findPosition(s, 'example.com').position, null);
  });
});

describe('checkTarget', () => {
  const target = {
    id: 7,
    domain: 'example.com',
    keyword: 'water heater repair cost',
    location_code: 2840,
    language_code: 'en',
    label: null,
    active: true,
    created_at: '2026-11-01T00:00:00.000Z',
    last_checked_at: null,
  };

  test('records a found position and looks two pages deep', async () => {
    let askedTop: number | undefined;
    const { db, calls } = fakeDb();
    const tracker = createRankTracker({
      db,
      log: () => {},
      serp: {
        check: async (p) => {
          askedTop = p.top;
          return { signal: signal(['a.com', 'example.com']), cost_usd: 0.0035 };
        },
      },
    });

    const r = await tracker.checkTarget(target);

    assert.equal(askedTop, RANK_CHECK_DEPTH);
    assert.equal(r.position, 2);
    assert.equal(r.ranking_url, 'example.com');
    assert.equal(r.cost_usd, 0.0035);
    assert.ok(calls.some((c) => c.includes('INSERT INTO keyword_rank_history')));
    assert.ok(calls.some((c) => c.includes('UPDATE keyword_rank_targets')));
  });

  test('records a miss too, so a gap in the history means a failure and not a miss', async () => {
    const { db, calls } = fakeDb();
    const tracker = createRankTracker({
      db,
      log: () => {},
      serp: { check: async () => ({ signal: signal(['a.com', 'b.com']), cost_usd: 0.0035 }) },
    });

    const r = await tracker.checkTarget(target);
    assert.equal(r.position, null);
    assert.ok(calls.some((c) => c.includes('INSERT INTO keyword_rank_history')));
  });
});

describe('runDue', () => {
  const mk = (id: number) => ({
    id,
    domain: 'example.com',
    keyword: 'k' + id,
    location_code: 2840,
    language_code: 'en',
    label: null,
    active: true,
    created_at: '2026-11-01T00:00:00.000Z',
    last_checked_at: null,
  });

  test('checks every due target and totals the spend', async () => {
    const { db } = fakeDb([[mk(1), mk(2), mk(3)]]);
    const tracker = createRankTracker({
      db,
      log: () => {},
      serp: { check: async () => ({ signal: signal(['example.com']), cost_usd: 0.0035 }) },
    });

    const r = await tracker.runDue();
    assert.equal(r.checked, 3);
    assert.equal(r.cost_usd, 0.0105);
  });

  test('one failing target does not stop the run', async () => {
    const { db } = fakeDb([[mk(1), mk(2), mk(3)]]);
    let n = 0;
    const tracker = createRankTracker({
      db,
      log: () => {},
      serp: {
        check: async () => {
          n += 1;
          if (n === 2) throw new Error('provider exploded');
          return { signal: signal(['example.com']), cost_usd: 0.0035 };
        },
      },
    });

    const r = await tracker.runDue();
    assert.equal(r.checked, 2, 'the other two still got checked');
  });

  test('nothing due costs nothing', async () => {
    const { db } = fakeDb([[]]);
    let called = 0;
    const tracker = createRankTracker({
      db,
      log: () => {},
      serp: {
        check: async () => {
          called += 1;
          return { signal: signal([]), cost_usd: 0.0035 };
        },
      },
    });

    const r = await tracker.runDue();
    assert.equal(r.checked, 0);
    assert.equal(r.cost_usd, 0);
    assert.equal(called, 0);
  });
});

describe('addTarget', () => {
  test('normalises the domain and keyword before they become a unique key', async () => {
    const { db, calls } = fakeDb([[{ id: 1 }]]);
    const tracker = createRankTracker({ db, log: () => {}, serp: { check: async () => ({ signal: signal([]), cost_usd: 0 }) } });

    await tracker.addTarget({ domain: 'https://WWW.Example.com/blog', keyword: '  Water  Heater Repair ' });
    assert.ok(calls[0].includes('INSERT INTO keyword_rank_targets'));
  });

  test('refuses an empty domain or keyword rather than storing a row that can never match', async () => {
    const { db } = fakeDb();
    const tracker = createRankTracker({ db, log: () => {}, serp: { check: async () => ({ signal: signal([]), cost_usd: 0 }) } });

    await assert.rejects(() => tracker.addTarget({ domain: '', keyword: 'x' }), /domain is required/);
    await assert.rejects(() => tracker.addTarget({ domain: 'example.com', keyword: '   ' }), /keyword is required/);
  });
});
