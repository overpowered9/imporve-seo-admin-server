import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, jaccard, selectRecentPosts, scoreRecentPosts, RECENT_POSTS_OVERLAP_THRESHOLD, RECENT_POSTS_MAX_SELECTED } from './recent-posts.js';

describe('tokenize', () => {
  test('lower-cases, strips punctuation, drops stopwords and short words, keeps accented letters', () => {
    assert.deepEqual(
      [...tokenize('Water heater repair cost in Española: what drives the price?')].sort(),
      ['cost', 'drives', 'española', 'heater', 'price', 'repair', 'water'],
    );
    assert.deepEqual([...tokenize('')], []);
    assert.deepEqual([...tokenize(undefined)], []);
    assert.deepEqual([...tokenize('vs or a an to')], []);
  });
});

describe('jaccard', () => {
  test('shared over union; 0 for two empty sets', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
    assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
    assert.equal(jaccard(new Set(), new Set()), 0);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
});

describe('selectRecentPosts', () => {
  const seed = 'water heater repair cost';
  const title = 'Water heater repair cost in Española: what drives the price';

  test('keeps posts at or above the threshold, best first, and drops the rest', () => {
    const posts = [
      { post_id: 1, title: 'Best plumbers in Española' },
      { post_id: 2, title: 'How much does water heater repair cost?', seed_keyword: 'water heater repair cost' },
      { post_id: 3, title: 'Tankless water heater installation' },
      { post_id: 4, title: 'Water heater repair or replace: a price comparison' },
    ];
    const selected = selectRecentPosts(posts, seed, title);
    // 2 shares water/heater/repair/cost (0.57), 4 shares water/heater/repair/price (0.44), 3 shares
    // only water/heater (0.22, just over the line: the Planner makes the final overlap call), and 1
    // shares only the town (0.11) and is dropped.
    assert.deepEqual(selected.map((s) => s.post.post_id), [2, 4, 3]);
    assert.ok(selected[0].score > selected[1].score && selected[1].score > selected[2].score);
    assert.ok(selected.every((s) => s.score >= RECENT_POSTS_OVERLAP_THRESHOLD));
    const scored = scoreRecentPosts(posts, seed, title);
    assert.ok(scored.find((s) => s.post.post_id === 1)!.score < RECENT_POSTS_OVERLAP_THRESHOLD);
  });

  test('caps at the top 5 and breaks ties by the caller\'s order', () => {
    const posts = Array.from({ length: 8 }, (_, i) => ({ post_id: i + 1, title: `water heater repair cost ${i}` }));
    const selected = selectRecentPosts(posts, seed, title);
    assert.equal(selected.length, RECENT_POSTS_MAX_SELECTED);
    assert.deepEqual(selected.map((s) => s.post.post_id), [1, 2, 3, 4, 5]);
  });

  test('a post whose only overlap is via its seed_keyword still counts', () => {
    const selected = selectRecentPosts([{ post_id: 9, title: 'Our winter checklist', seed_keyword: 'water heater repair cost' }], seed, title);
    assert.deepEqual(selected.map((s) => s.post.post_id), [9]);
  });

  test('threshold and max are overridable; empty input is empty output', () => {
    assert.deepEqual(selectRecentPosts([], seed, title), []);
    assert.deepEqual(selectRecentPosts(undefined, seed, title), []);
    const posts = [{ post_id: 1, title: 'Best plumbers in Española' }];
    assert.equal(selectRecentPosts(posts, seed, title, { threshold: 0.05 }).length, 1);
    assert.equal(selectRecentPosts(posts, seed, title, { threshold: 0.9 }).length, 0);
  });

  test('ignores posts past the 20th', () => {
    const posts = Array.from({ length: 25 }, (_, i) => ({ post_id: i + 1, title: i === 24 ? 'water heater repair cost' : 'unrelated gardening tips' }));
    assert.deepEqual(selectRecentPosts(posts, seed, title), []);
  });
});
