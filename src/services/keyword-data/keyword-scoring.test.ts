/**
 * Scoring and traffic lights.
 *
 * What is being protected:
 *  1. Unknown is never dressed up as a judgement — the failure the real pull exposed.
 *  2. A local figure is judged against a local bar, not a national one.
 *  3. The paid SERP check can only promote, never demote.
 *  4. Difficulty comes from Labs; nothing ad-auction-shaped can reach the score.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORING_DEFAULTS,
  TRAFFIC_LIGHT_LABELS,
  evaluateGates,
  intentWeight,
  opportunityScore,
  trafficLight,
} from './keyword-scoring.js';

const base = { volume_scope: 'national' as const };

describe('intentWeight', () => {
  test('commercial investigation is valuable, navigational is not', () => {
    // The spec had commercial at 0.6, below informational. "best leather wallets for men" is a
    // buyer comparing options; that is the most valuable article a small shop can rank.
    assert.ok(intentWeight('commercial') > intentWeight('informational'));
    assert.ok(intentWeight('transactional') >= intentWeight('commercial'));
    assert.ok(intentWeight('navigational') < intentWeight('informational'));
  });

  test('an unknown intent sits between informational and navigational', () => {
    assert.ok(intentWeight(null) < intentWeight('informational'));
    assert.ok(intentWeight(null) > intentWeight('navigational'));
  });
});

describe('opportunityScore', () => {
  test('is null when either input is unknown, rather than a score built on a guess', () => {
    assert.equal(opportunityScore({ search_volume: null, keyword_difficulty: 10, intent: 'commercial' }), null);
    assert.equal(opportunityScore({ search_volume: 500, keyword_difficulty: null, intent: 'commercial' }), null);
    assert.equal(opportunityScore({ search_volume: null, keyword_difficulty: null, intent: null }), null);
  });

  test('rises with volume and falls with difficulty', () => {
    const easyBig = opportunityScore({ search_volume: 5000, keyword_difficulty: 5, intent: 'commercial' })!;
    const easySmall = opportunityScore({ search_volume: 50, keyword_difficulty: 5, intent: 'commercial' })!;
    const hardBig = opportunityScore({ search_volume: 5000, keyword_difficulty: 80, intent: 'commercial' })!;
    assert.ok(easyBig > easySmall);
    assert.ok(easyBig > hardBig);
  });

  test('a huge head term does not drown out every realistic target', () => {
    // log compression: 100k searches is worth about 5x a 10-search term, not 10,000x.
    const head = opportunityScore({ search_volume: 100_000, keyword_difficulty: 20, intent: 'commercial' })!;
    const tail = opportunityScore({ search_volume: 300, keyword_difficulty: 20, intent: 'commercial' })!;
    assert.ok(head / tail < 3);
  });

  test('stays within 0-100 at the extremes', () => {
    const max = opportunityScore({ search_volume: 10_000_000, keyword_difficulty: 0, intent: 'transactional' })!;
    const min = opportunityScore({ search_volume: 0, keyword_difficulty: 100, intent: 'navigational' })!;
    assert.ok(max <= 100 && max >= 0);
    assert.equal(min, 0);
  });

  test('clamps an out-of-range difficulty instead of producing a negative score', () => {
    const s = opportunityScore({ search_volume: 1000, keyword_difficulty: 140, intent: 'commercial' })!;
    assert.ok(s >= 0);
  });
});

describe('trafficLight', () => {
  test('no data is unknown, never red', () => {
    // The whole reason this tier exists: 14 of 30 rows on the real pull had nothing at all.
    assert.equal(trafficLight({ search_volume: null, keyword_difficulty: null, intent: null, ...base }), 'unknown');
    assert.equal(TRAFFIC_LIGHT_LABELS.unknown, 'No data');
  });

  test('easy, popular and useful is green', () => {
    assert.equal(
      trafficLight({ search_volume: 1200, keyword_difficulty: 12, intent: 'commercial', ...base }),
      'green',
    );
  });

  test('genuinely hard is red whatever the volume', () => {
    assert.equal(
      trafficLight({ search_volume: 90_000, keyword_difficulty: 85, intent: 'commercial', ...base }),
      'red',
    );
  });

  test('zero demand is red even when it is trivially easy', () => {
    assert.equal(trafficLight({ search_volume: 0, keyword_difficulty: 1, intent: 'commercial', ...base }), 'red');
  });

  test('navigational is red: someone hunting a brand that is not yours', () => {
    assert.equal(
      trafficLight({ search_volume: 5000, keyword_difficulty: 5, intent: 'navigational', ...base }),
      'red',
    );
  });

  test('half-known is yellow, not green — we are guessing on the other half', () => {
    assert.equal(trafficLight({ search_volume: null, keyword_difficulty: 10, intent: 'commercial', ...base }), 'yellow');
    assert.equal(trafficLight({ search_volume: 4000, keyword_difficulty: null, intent: 'commercial', ...base }), 'yellow');
  });

  test('a local figure is judged against the local bar', () => {
    const row = { search_volume: 40, keyword_difficulty: 10, intent: 'commercial' as const };
    // 40/mo is real demand for a town and nothing nationally.
    assert.equal(trafficLight({ ...row, volume_scope: 'local' }), 'green');
    assert.equal(trafficLight({ ...row, volume_scope: 'national' }), 'yellow');
  });

  test('the SERP check promotes on user-generated results holding the top ten', () => {
    // Measured live: "water heater repair cost" had five Reddit/Facebook threads in the top ten.
    // Google could not find enough good pages, which is exactly when an article can win.
    const thin = { search_volume: 800, keyword_difficulty: 42, intent: 'commercial' as const, ...base };
    assert.equal(trafficLight(thin), 'yellow');
    assert.equal(trafficLight({ ...thin, serp: { article_viable: true, ugc_results: 5 } }), 'green');
  });

  test('one lone forum result is noise, not an opening', () => {
    const thin = { search_volume: 800, keyword_difficulty: 42, intent: 'commercial' as const, ...base };
    assert.equal(trafficLight({ ...thin, serp: { article_viable: true, ugc_results: 1 } }), 'yellow');
  });

  test('finding no user-generated results never demotes', () => {
    const good = { search_volume: 1200, keyword_difficulty: 12, intent: 'commercial' as const, ...base };
    assert.equal(
      trafficLight({ ...good, serp: { article_viable: true, ugc_results: 0 } }),
      'green',
      'absence of evidence on a ten-result sample must not punish the user who paid',
    );
  });

  test('shopping units demote to red whatever the difficulty says', () => {
    // "leather wallets for women": 14,800 searches, difficulty reported 0, and six product
    // carousels on page one. Google has decided this is a purchase; no article outranks that.
    const looksEasy = { search_volume: 14800, keyword_difficulty: 5, intent: 'transactional' as const, ...base };
    assert.equal(trafficLight(looksEasy), 'green', 'without the check it reads as an easy win');
    assert.equal(trafficLight({ ...looksEasy, serp: { article_viable: false, ugc_results: 0 } }), 'red');

    // And it settles the case the difficulty-0 rule leaves open.
    const unmeasured = { search_volume: 14800, keyword_difficulty: null, intent: 'transactional' as const, ...base };
    assert.equal(trafficLight(unmeasured), 'yellow');
    assert.equal(trafficLight({ ...unmeasured, serp: { article_viable: false, ugc_results: 0 } }), 'red');
  });
});

describe('evaluateGates', () => {
  test('an unknown input yields a null gate, not a false one', () => {
    const g = evaluateGates({ search_volume: null, keyword_difficulty: null, intent: null, ...base });
    assert.deepEqual(g, {
      difficulty_ok: null,
      volume_ok: null,
      intent_ok: null,
      serp_weakness: null,
      serp_article_viable: null,
    });
  });

  test('gates read the thresholds they are given', () => {
    const g = evaluateGates({ search_volume: 150, keyword_difficulty: 25, intent: 'informational', ...base });
    assert.deepEqual(g, {
      difficulty_ok: true,
      volume_ok: true,
      intent_ok: true,
      serp_weakness: null,
      serp_article_viable: null,
    });
  });

  test('the SERP gates reflect what the check saw', () => {
    const g = evaluateGates({
      search_volume: 150,
      keyword_difficulty: 25,
      intent: 'informational',
      ...base,
      serp: { article_viable: false, ugc_results: 3 },
    });
    assert.equal(g.serp_weakness, true);
    assert.equal(g.serp_article_viable, false);
  });
});

describe('the scoring module never sees ad-auction data', () => {
  test('its public surface has no competition or cpc input', () => {
    // Difficulty is Labs-only by construction: there is nowhere to put an ad-auction number.
    const inputKeys = Object.keys({ search_volume: 0, keyword_difficulty: 0, intent: null, volume_scope: 'national' });
    assert.ok(!inputKeys.some((k) => /competition|cpc|bid/i.test(k)));
    assert.ok(!Object.keys(SCORING_DEFAULTS).some((k) => /competition|cpc|bid/i.test(k)));
  });
});
