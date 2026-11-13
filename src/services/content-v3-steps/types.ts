/**
 * Shared input shapes for the Content v3 Title and Planner steps.
 *
 * `search_data` and `research` are the outputs of two steps this branch does not build (the
 * DataForSEO SERP lookup and the Perplexity research query, see docs/content-v3-prompt-drafts.md).
 * Until they exist, callers may pass them in; when they are missing, the prompts' own rules apply
 * ("If <search_data> is missing, work from <seed_keyword>…"). Keyword numbers are NOT accepted
 * here — they only ever come from the server (keyword-data service).
 */

export type Scope = 'local' | 'national';

export interface ScopedItem {
  text: string;
  scope: Scope;
}

export interface SearchDataInput {
  /** The location the lookup ran for, e.g. "Española, NM" or "United States". */
  location?: string;
  /** Whether a nationwide call was added because the local one was thin. */
  national_fallback?: boolean;
  ranking_titles?: ScopedItem[];
  people_also_ask?: ScopedItem[];
  related_searches?: ScopedItem[];
}

export interface ResearchFact {
  claim: string;
  scope?: 'local' | 'state' | 'national' | 'general';
  source_ids?: number[];
  conflict?: boolean;
  /** The source token ("S3") research.service.ts assigned; when absent, facts are numbered by position. */
  token?: string;
}

export interface ResearchQuestion {
  question: string;
  source_ids?: number[];
}

export interface ResearchCondition {
  claim: string;
  source_ids?: number[];
  /** Local conditions continue the fact numbering ("S16"…), so the Writer can cite them (rules_local_seo). */
  token?: string;
}

export interface ResearchInput {
  facts?: ResearchFact[];
  follow_up_questions?: ResearchQuestion[];
  local_conditions?: ResearchCondition[];
  notes?: string;
}

export interface RecentPost {
  post_id: number;
  title: string;
  seed_keyword?: string;
}

export type PostSize = 'small' | 'medium' | 'large';
export const POST_SIZES: readonly PostSize[] = Object.freeze(['small', 'medium', 'large']);

/** The size table the Planner chooses from. Mirrors VALID_WORDS in content-v3.routes.ts. */
export const DEFAULT_SIZE_OPTIONS: Readonly<Record<PostSize, string>> = Object.freeze({
  small: '600 to 1200 words',
  medium: '1200 to 2400 words',
  large: '2400 to 3600 words',
});
