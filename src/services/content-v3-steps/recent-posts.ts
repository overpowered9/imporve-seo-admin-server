/**
 * Which of the caller's recent posts the Planner gets to see — decided in code, not by the model.
 *
 * The plugin may send up to 20 recent posts. Sending all of them would bury the two or three
 * that could actually duplicate this article, so code scores each post by word overlap with the
 * seed keyword and title and keeps the best few.
 *
 * SCORE: Jaccard similarity of the two token sets — tokens are lower-cased words with punctuation
 * stripped, stopwords and words under three letters dropped. The article side is seed keyword +
 * title; the post side is its title + its seed keyword.
 *
 * THRESHOLD 0.2, TOP 5 (proposed starting values; an open decision for the final report). At 0.2
 * "water heater repair cost in Española" still matches "how much does water heater repair cost"
 * (shared: water, heater, repair, cost) while "best plumbers in Española" does not.
 */
import type { RecentPost } from './types.js';

export const RECENT_POSTS_MAX_INPUT = 20;
export const RECENT_POSTS_MAX_SELECTED = 5;
export const RECENT_POSTS_OVERLAP_THRESHOLD = 0.2;

export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'into',
  'about', 'than', 'then', 'as', 'if', 'not', 'no', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'these', 'those', 'you', 'your', 'our', 'we', 'my', 'me', 'do', 'does', 'did', 'can',
  'could', 'should', 'would', 'will', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'vs', 'versus',
  'much', 'many', 'any', 'all', 'get', 'got', 'need', 'guide',
]);

export function tokenize(text: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/)) {
    const w = raw.trim();
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface ScoredPost {
  post: RecentPost;
  score: number;
}

export function scoreRecentPosts(posts: RecentPost[], seedKeyword: string, title: string): ScoredPost[] {
  const article = new Set([...tokenize(seedKeyword), ...tokenize(title)]);
  return posts.map((post) => ({
    post,
    score: jaccard(article, new Set([...tokenize(post.title), ...tokenize(post.seed_keyword)])),
  }));
}

/**
 * The posts to show the Planner: those scoring at or above the threshold, best first (ties keep
 * the caller's order), at most `max`.
 */
export function selectRecentPosts(
  posts: RecentPost[] | undefined,
  seedKeyword: string,
  title: string,
  options: { threshold?: number; max?: number } = {},
): ScoredPost[] {
  const { threshold = RECENT_POSTS_OVERLAP_THRESHOLD, max = RECENT_POSTS_MAX_SELECTED } = options;
  if (!posts?.length) return [];
  return scoreRecentPosts(posts.slice(0, RECENT_POSTS_MAX_INPUT), seedKeyword, title)
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s.score >= threshold && s.score > 0)
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .slice(0, max)
    .map(({ post, score }) => ({ post, score }));
}
