/**
 * Content v3 · PROMPT 3 · Planner step.
 *
 * Runs on "Approve title" with the low-cost model. Code builds the data tags, the model answers
 * JSON, and code checks it per the doc: valid JSON, post_size not below <minimum_size>, FAQ
 * questions 1–5 when there is evidence (0–5 without, conflict C2) and none repeating a body
 * question, at most 2 owner questions; up to 3 attempts.
 *
 * Option B adds, only when keyword data is in effect AND available (V2 prompt):
 *   <keyword_data>   30 related keywords, in the USER message
 *   <recent_posts>   the caller's recent posts that code selected by word overlap with the seed
 *                    keyword and title (recent-posts.ts: Jaccard ≥ 0.2, top 5) — never the model
 *   demand_notes     one sentence or null, validated in code
 *   overlap          null, or { post_id, reason } where post_id is one of the posts actually sent
 * With V1 both fields are forced to null, so the response shape is stable either way.
 *
 * The research step the doc describes (Perplexity) is not built on this branch; `research` is an
 * optional input until it is.
 */
import { parseJsonLoose } from '../claude.service.js';
import { KEYWORD_DATA_DEFAULTS } from '../../config/keyword-data.config.js';
import { promptVersionLabel, runModelCall } from '../model-call.js';
import { V3_STEP_PROMPT_DEFS } from './prompts.js';
import { selectRecentPosts, type ScoredPost } from './recent-posts.js';
import { normalizeQuestion, resolveStepKeywordData, str, strList, type StepDeps, type StepResultBase } from './step-common.js';
import { DEFAULT_SIZE_OPTIONS, POST_SIZES, type PostSize, type RecentPost, type ResearchInput, type SearchDataInput } from './types.js';
import { joinBlocks, recentPostsBlock, researchBlock, searchDataBlock, tag } from './xml.js';

export interface PlannerStepInput {
  title: string;
  seed_keyword: string;
  language?: string;
  niche?: string;
  reach?: string;
  proof_level?: string;
  ideal_client?: string;
  target_town?: string;
  featured_service?: string;
  business_description?: string;
  search_data?: SearchDataInput;
  research?: ResearchInput;
  size_options?: Partial<Record<PostSize, string>>;
  minimum_size?: PostSize;
  use_keyword_data?: boolean;
  recent_posts?: RecentPost[];
  location_code?: number;
  language_code?: string;
}

export const ARTICLE_TYPES_V3 = ['cost', 'decision', 'question', 'topic'] as const;
export type ArticleTypeV3 = (typeof ARTICLE_TYPES_V3)[number];
export const READINESS = ['researching', 'comparing', 'ready to hire'] as const;
export type Readiness = (typeof READINESS)[number];

export interface SearcherProfile {
  situation: string;
  main_concern: string;
  desired_outcome: string;
  readiness: Readiness | '';
  their_words: string[];
  reassurance: string;
}

export interface PlannerOverlap {
  post_id: number;
  reason: string;
}

export interface PlannerStepOutput {
  article_type: ArticleTypeV3;
  type_reason: string;
  post_size: PostSize;
  size_reason: string;
  body_questions: string[];
  faq_questions: string[];
  searcher_profile: SearcherProfile;
  ideal_client_gap: string;
  owner_questions: string[];
  regulated_topic: boolean | null;
  regulated_reason: string;
  demand_notes: string | null;
  overlap: PlannerOverlap | null;
}

export interface PlannerStepResult extends StepResultBase {
  output: PlannerStepOutput;
  recent_posts: {
    received: number;
    /** What the model saw, with the overlap score each one earned. Empty with V1. */
    sent: Array<{ post_id: number; score: number }>;
  };
}

// Headroom for thinking, not for a longer answer. claudeText({ thinking: false }) omits the
// `thinking` field, and on models that think by default (Claude Sonnet 5, Opus 5.x, Sonnet/Haiku
// 5.5) that means adaptive thinking is ON and its tokens count against max_tokens. Measured on
// claude-sonnet-5 (2026-11-13): the Planner's JSON is ~250-450 tokens but calls used 1,119-1,843
// output tokens, and with a 2,000 cap some attempts came back empty or cut mid-JSON. Billing is
// per token used, so a higher cap costs nothing extra when it is not needed.
export const PLANNER_MAX_TOKENS = 8000;
export const BODY_QUESTIONS_MAX = 9;
export const FAQ_QUESTIONS_MAX = 5;
export const OWNER_QUESTIONS_MAX = 2;
export const THEIR_WORDS_MAX = 8;
export const DEMAND_NOTES_MAX_CHARS = 240;
export const OVERLAP_REASON_MAX_CHARS = 300;

const sizeRank = (s: PostSize) => POST_SIZES.indexOf(s);

export function buildPlannerUserMessage(
  input: PlannerStepInput,
  keywordDataBlock: string | null,
  recentPosts: RecentPost[],
): string {
  const sizes = { ...DEFAULT_SIZE_OPTIONS, ...(input.size_options ?? {}) };
  const data = joinBlocks([
    tag('title', input.title),
    tag('seed_keyword', input.seed_keyword),
    tag('language', input.language),
    tag('niche', input.niche),
    tag('reach', input.reach),
    tag('proof_level', input.proof_level),
    tag('ideal_client', input.ideal_client),
    tag('target_town', input.target_town),
    tag('featured_service', input.featured_service),
    tag('business_description', input.business_description),
    searchDataBlock(input.search_data),
    researchBlock(input.research),
    tag('size_options', POST_SIZES.map((s) => `${s}: ${sizes[s]}`).join(' | ')),
    tag('minimum_size', input.minimum_size ?? 'small'),
    keywordDataBlock,
    recentPostsBlock(recentPosts),
  ]);
  return `${data}\n\nPlan the article.`;
}

/** Coerce the model's JSON into the output shape. Throws on a non-object so it counts as unreadable. */
export function normalizePlannerOutput(raw: unknown): PlannerStepOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('output is not a JSON object');
  const o = raw as Record<string, unknown>;
  const sp = (o.searcher_profile && typeof o.searcher_profile === 'object' ? o.searcher_profile : {}) as Record<string, unknown>;
  const readiness = str(sp.readiness).toLowerCase();

  let overlap: PlannerOverlap | null;
  if (o.overlap === null || o.overlap === undefined) overlap = null;
  else if (typeof o.overlap === 'object' && !Array.isArray(o.overlap)) {
    const ov = o.overlap as Record<string, unknown>;
    const id = typeof ov.post_id === 'number' ? ov.post_id : typeof ov.post_id === 'string' && /^\d+$/.test(ov.post_id) ? parseInt(ov.post_id, 10) : NaN;
    overlap = { post_id: id, reason: str(ov.reason) };
  } else overlap = { post_id: NaN, reason: '' };

  const regulated = o.regulated_topic;
  return {
    article_type: str(o.article_type).toLowerCase() as ArticleTypeV3,
    type_reason: str(o.type_reason),
    post_size: str(o.post_size).toLowerCase() as PostSize,
    size_reason: str(o.size_reason),
    body_questions: strList(o.body_questions),
    faq_questions: strList(o.faq_questions),
    searcher_profile: {
      situation: str(sp.situation),
      main_concern: str(sp.main_concern),
      desired_outcome: str(sp.desired_outcome),
      readiness: (READINESS as readonly string[]).includes(readiness) ? (readiness as Readiness) : '',
      their_words: strList(sp.their_words, THEIR_WORDS_MAX),
      reassurance: str(sp.reassurance),
    },
    ideal_client_gap: str(o.ideal_client_gap),
    owner_questions: strList(o.owner_questions),
    regulated_topic: typeof regulated === 'boolean' ? regulated : null,
    regulated_reason: str(o.regulated_reason),
    demand_notes: str(o.demand_notes) || null,
    overlap,
  };
}

export interface PlannerValidationContext {
  minimumSize: PostSize;
  /** V2 in use: demand_notes and overlap are validated. V1: they are ignored and nulled. */
  keywordDataInEffect: boolean;
  /** post_ids of the recent posts actually sent; overlap must name one of them. */
  sentPostIds: ReadonlySet<number>;
  /**
   * Conflict C2 (approved 14 Nov): the doc asks for "1 to 5 FAQ questions" but also lets the
   * Planner "return fewer" when evidence is thin. So at least 1 FAQ question is required only when
   * there IS evidence (search data questions/related searches, or research); with none, 0 is valid.
   */
  evidencePresent?: boolean;
}

/** True when the Planner had questions to draw on: People Also Ask, related searches or research. */
export function plannerEvidencePresent(input: Pick<PlannerStepInput, 'search_data' | 'research'>): boolean {
  const sd = input.search_data;
  const r = input.research;
  return (
    (sd?.people_also_ask?.length ?? 0) > 0 ||
    (sd?.related_searches?.length ?? 0) > 0 ||
    (r?.facts?.length ?? 0) > 0 ||
    (r?.follow_up_questions?.length ?? 0) > 0
  );
}

export function validatePlannerOutput(o: PlannerStepOutput, ctx: PlannerValidationContext): string | null {
  if (!(ARTICLE_TYPES_V3 as readonly string[]).includes(o.article_type)) return `invalid_article_type: ${o.article_type || '(missing)'}`;
  if (!(POST_SIZES as readonly string[]).includes(o.post_size)) return `invalid_post_size: ${o.post_size || '(missing)'}`;
  if (sizeRank(o.post_size) < sizeRank(ctx.minimumSize)) return `post_size_below_minimum: ${o.post_size} < ${ctx.minimumSize}`;
  if (o.body_questions.length > BODY_QUESTIONS_MAX) return `too_many_body_questions: ${o.body_questions.length}`;
  if (o.faq_questions.length > FAQ_QUESTIONS_MAX) return `too_many_faq_questions: ${o.faq_questions.length}`;
  if (ctx.evidencePresent && o.faq_questions.length < 1) return 'too_few_faq_questions: 0 with search data or research present';
  const body = new Set(o.body_questions.map(normalizeQuestion));
  const dup = o.faq_questions.find((q) => body.has(normalizeQuestion(q)));
  if (dup) return `faq_repeats_body_question: ${dup.slice(0, 80)}`;
  if (o.owner_questions.length > OWNER_QUESTIONS_MAX) return `too_many_owner_questions: ${o.owner_questions.length}`;

  if (ctx.keywordDataInEffect) {
    if (o.demand_notes !== null) {
      if (o.demand_notes.length > DEMAND_NOTES_MAX_CHARS) return `invalid_demand_notes: ${o.demand_notes.length} chars`;
      if (/\n/.test(o.demand_notes)) return 'invalid_demand_notes: multiple lines';
    }
    if (o.overlap !== null) {
      if (!Number.isInteger(o.overlap.post_id)) return 'invalid_overlap: post_id is not an integer';
      if (!ctx.sentPostIds.has(o.overlap.post_id)) return `invalid_overlap: post_id ${o.overlap.post_id} was not in recent_posts`;
      if (!o.overlap.reason) return 'invalid_overlap: reason is empty';
      if (o.overlap.reason.length > OVERLAP_REASON_MAX_CHARS) return `invalid_overlap: reason ${o.overlap.reason.length} chars`;
    }
  }
  return null;
}

export async function runPlannerStep(input: PlannerStepInput, deps: StepDeps): Promise<PlannerStepResult> {
  const { log = (line) => console.log(line), now = () => Date.now() } = deps;
  const startedAt = now();
  const minimumSize: PostSize = input.minimum_size ?? 'small';

  const kd = await resolveStepKeywordData('planner', input, KEYWORD_DATA_DEFAULTS.plannerRelatedLimit, deps);
  const v2 = kd.data !== null;

  // recent_posts travel with the V2 prompt only: with V1 there is no overlap rule to apply them to,
  // and a fallback must look exactly like a flag-off request.
  const selected: ScoredPost[] = v2 ? selectRecentPosts(input.recent_posts, input.seed_keyword, input.title) : [];
  const sentPosts = selected.map((s) => s.post);
  const sentPostIds = new Set(sentPosts.map((p) => p.post_id));

  const def = v2 ? V3_STEP_PROMPT_DEFS.plannerKeywordData : V3_STEP_PROMPT_DEFS.planner;
  const prompt = await deps.resolvePrompt(def);
  const user = buildPlannerUserMessage(input, kd.data ? kd.data.block : null, sentPosts);

  const modelName = deps.modelName ?? 'unknown-model';
  const label = promptVersionLabel({ templateType: prompt.templateType, source: prompt.source, dbVersion: prompt.dbVersion, text: prompt.text });
  const modelStarted = now();
  const r = await runModelCall<PlannerStepOutput>({
    step: 'planner',
    model: modelName,
    promptVersion: label,
    system: prompt.text,
    user,
    maxTokens: PLANNER_MAX_TOKENS,
    timeoutMs: deps.timeoutMs ?? 90_000,
    maxAttempts: deps.maxAttempts,
    call: (o) => deps.model(o),
    parse: (text) => normalizePlannerOutput(parseJsonLoose(text)),
    validate: (o) => validatePlannerOutput(o, { minimumSize, keywordDataInEffect: v2, sentPostIds, evidencePresent: plannerEvidencePresent(input) }),
    runId: deps.runId,
    log,
    now,
    env: deps.env,
  });

  const output = v2 ? r.value : { ...r.value, demand_notes: null, overlap: null };

  return {
    output,
    attempts: r.attempts,
    usage: r.usage,
    cost_usd: r.cost_usd,
    model: modelName,
    keyword_data: kd.info,
    recent_posts: { received: input.recent_posts?.length ?? 0, sent: selected.map((s) => ({ post_id: s.post.post_id, score: Number(s.score.toFixed(3)) })) },
    prompt: { templateType: prompt.templateType, source: prompt.source, version: v2 ? 'v2_keyword_data' : 'v1', label },
    timings: { total_ms: now() - startedAt, keyword_data_ms: kd.info.ms, model_ms: now() - modelStarted },
    messages: { system: prompt.text, user },
  };
}
