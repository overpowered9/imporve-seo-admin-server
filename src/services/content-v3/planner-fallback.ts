/**
 * What code decides around the Planner: the minimum size, the fallback plan after 3 failed
 * attempts (P4), and the "title check" on Approve (W3).
 *
 * MINIMUM SIZE (P2, W8). docs/content-v3-prompt-drafts.md gives the word targets (aim 900 / 1,800
 * / 3,000, fixed parts about 380 / 450 / 540, blueprint step 3) and the per-item minimums for
 * numbered titles (60 / 40 / 35 words, blueprint "numbered piece"). The smallest size whose body
 * words hold the title's items at the strictest per-item minimum (60) is the minimum; anything
 * else is Small. "doc C" (the size table) is missing, so this is the working rule, noted in the
 * progress doc.
 *
 * FALLBACK PLAN (P4): "article type falls back to the keyword guess, post size to the minimum or
 * Small, no owner questions, no searcher profile. The article can still be generated." Body
 * questions stay empty (the Writer works from the title); FAQ candidates come from the search
 * data's People Also Ask questions, local first, so the FAQ is still made of real questions.
 */
import type { PlannerStepOutput, ArticleTypeV3 } from '../content-v3-steps/planner.step.js';
import { POST_SIZES, type PostSize, type SearchDataInput } from '../content-v3-steps/types.js';

export const SIZE_TARGETS: Readonly<Record<PostSize, { aim: number; fixed: number }>> = Object.freeze({
  small: { aim: 900, fixed: 380 },
  medium: { aim: 1800, fixed: 450 },
  large: { aim: 3000, fixed: 540 },
});

export const STRICTEST_WORDS_PER_ITEM = 60;

export function minimumSizeFor(titleForm: string | null | undefined, items: number | null | undefined): PostSize {
  if (titleForm !== 'numbered' || !items || items < 1) return 'small';
  for (const size of POST_SIZES) {
    const t = SIZE_TARGETS[size];
    if (t.aim - t.fixed >= items * STRICTEST_WORDS_PER_ITEM) return size;
  }
  return 'large';
}

/** The keyword's own article type, for the fallback: cost words, a choice, a question, else a topic. */
export function guessArticleType(seedKeyword: string, title = ''): ArticleTypeV3 {
  const s = ` ${`${seedKeyword} ${title}`.toLowerCase()} `;
  if (/\b(cost|costs|price|prices|pricing|how much|fee|fees|rates|quote|estimate)\b/.test(s)) return 'cost';
  if (/\b(vs|versus|or|compare|comparison|worth it|worth|should i|which|best)\b/.test(s)) return 'decision';
  if (/^\s*(how|what|why|when|where|who|can|do|does|is|are|should|will)\b/.test(seedKeyword.toLowerCase()) || /\?\s*$/.test(seedKeyword)) return 'question';
  return 'topic';
}

export function fallbackPlan(opts: { seedKeyword: string; title: string; minimumSize: PostSize; searchData?: SearchDataInput | null }): PlannerStepOutput {
  const paa = (opts.searchData?.people_also_ask ?? []).map((q) => q.text).filter(Boolean).slice(0, 5);
  return {
    article_type: guessArticleType(opts.seedKeyword, opts.title),
    type_reason: '',
    post_size: opts.minimumSize,
    size_reason: '',
    body_questions: [],
    faq_questions: paa,
    searcher_profile: { situation: '', main_concern: '', desired_outcome: '', readiness: '', their_words: [], reassurance: '' },
    ideal_client_gap: '',
    owner_questions: [],
    regulated_topic: null,
    regulated_reason: '',
    demand_notes: null,
    overlap: null,
  };
}

export interface TitleCheck {
  ok: boolean;
  title: string;
  /** Blocking problem, in plain words. */
  error?: string;
  /** Non-blocking notes shown under the title. */
  notes: string[];
}

/**
 * Title check on Approve (W3). The rules belong to the missing "Single wizard: input fields" doc;
 * until it arrives, the working rules are: not empty, no markup, at most 150 characters (blocking);
 * over 70 characters, or none of the keyword's words present (notes only).
 */
export function checkApprovedTitle(rawTitle: string, seedKeyword: string): TitleCheck {
  const title = String(rawTitle ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!title) return { ok: false, title, error: 'Please write or generate a title first.', notes: [] };
  if (title.length > 150) return { ok: false, title, error: 'This title is too long. Please keep it under 150 characters.', notes: [] };
  const notes: string[] = [];
  if (title.length > 70) notes.push('Titles over 70 characters are often cut off in search results.');
  const words = seedKeyword.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  const t = title.toLowerCase();
  if (words.length && !words.some((w) => t.includes(w))) notes.push('The title does not use any words from your keyword.');
  return { ok: true, title, notes };
}
