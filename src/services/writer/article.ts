/**
 * Content v3 article — from the approved plan to the finished, checked article (phase 8).
 *
 *   1 final proof level (G6): business Regulated → Regulated unless the user turned it off for this
 *     post; Standard business → Regulated only when the check suggested it and the user kept it.
 *   2 <niche_profile> (N4) and <blueprint> (B1–B12), with <recent_headings> from the site's history.
 *   3 the Writer (WR1–WR4): cached system prompt (core + six rules blocks), per-article user message.
 *   4 post-processing (WR5–WR8, WR10): sanitize → source links → validate → TOC → disclaimer.
 *   5 U2: when the validator finds errors, the Writer runs once more with the same inputs; the better
 *     of the two is kept. Still failing → needs_review (U3, decided by the caller).
 *   6 U4 meta on the final article; the FAQ read from the HTML for the schema.
 * U1: the old humanizer is skipped on this path (it breaks tokens, the em-dash rule and the sections).
 */
import { runModelCall, promptVersionLabel, type ProviderCall } from '../model-call.js';
import { buildBlueprint, priceAvailable, recentHeadingsBlock, type BlueprintPins, type BlueprintPicks, type HistoryPost } from '../blueprint/blueprint.js';
import { BLUEPRINT_PIECES_V1 } from '../blueprint/pieces.js';
import { buildNicheProfile, DEFAULT_NICHE_SETTINGS, type NicheSettings } from '../niche-profile/niche-profile.js';
import { disclaimerFor } from '../niche-profile/niche-profile.default.js';
import type { PlannerStepOutput } from '../content-v3-steps/planner.step.js';
import type { PostSize } from '../content-v3-steps/types.js';
import type { MappedResearch } from '../research/research.service.js';
import { buildWriterSystem, WRITER_PROMPT_DEFS, type WriterPart } from './prompt.js';
import { buildWriterUserMessage, type PointOfView } from './user-message.js';
import {
  addTableOfContents,
  extractFaq,
  faqSchema,
  headingsOf,
  insertDisclaimer,
  linkSourceTokens,
  parseWriterOutput,
  sanitizeArticle,
  type FaqPair,
  type WriterOutput,
} from './postprocess.js';
import { validateArticle, type ValidatorReport } from './validator.js';
import { generateMetaV3 } from './meta.js';

export type ArticleType = 'cost' | 'decision' | 'question' | 'topic';

export interface ArticleV3Input {
  title: string;
  seed_keyword: string;
  language?: string;
  /** Niche key or label (resolveNiche maps both). */
  niche?: string;
  niche_profile?: string | null;
  reach: 'local' | 'nationwide';
  target_town?: string;
  featured_service?: string;
  business_description?: string;
  ideal_client?: string;
  business_name?: string;
  stand_out?: string;
  business_pricing?: string;
  business_proof_level: 'standard' | 'regulated';
  /** The post-level check suggested Regulated (topics list or Planner). */
  regulated_suggested: boolean;
  /** Step 2's Keep (true) / Turn off (false); null when no line was shown. */
  regulated_choice: boolean | null;
  plan: PlannerStepOutput;
  title_form?: string | null;
  title_items?: number | null;
  research: MappedResearch | null;
  article_type?: ArticleType;
  post_size: PostSize;
  point_of_view?: PointOfView;
  tone?: string;
  cta?: { text?: string; url?: string; phone?: string };
  post_answers?: Array<{ question: string; answer: string }>;
  anything_else?: string;
  pins?: BlueprintPins;
  /** The site's last 20 v3 posts (newest first) plus this bulk batch's earlier ones. */
  history: Array<HistoryPost & { headings?: string[] }>;
  rng?: () => number;
}

export interface ArticleV3Deps {
  call: ProviderCall;
  writerModel: string;
  metaModel: string;
  writerTimeoutMs: number;
  metaTimeoutMs: number;
  maxAttempts?: number;
  writerParts?: Partial<Record<WriterPart, { text: string; source: 'db' | 'fallback'; dbVersion?: number | null }>>;
  niche?: { settings: NicheSettings; standardPiece?: string; regulatedPiece?: string; disclaimers?: Record<string, string> };
  blueprintPieces?: Readonly<Record<string, string>>;
  runId?: string;
  log?: (line: string) => void;
  now?: () => number;
}

export interface ArticleV3Result {
  content: string;
  meta_title: string;
  meta_description: string;
  faq: FaqPair[];
  faq_schema: Record<string, unknown> | null;
  validator: ValidatorReport;
  needs_review: boolean;
  repaired: boolean;
  proof_level: 'standard' | 'regulated';
  article_type: ArticleType;
  picks: BlueprintPicks;
  fingerprint: string;
  headings: string[];
  linked_sources: Array<{ token: string; url: string }>;
  writer_json: WriterOutput['json'];
  writer_attempts: number;
  cost: { writer: number | null; meta: number | null };
  usage: { writer: unknown[]; meta: unknown[] };
  prompt_version: string;
  model: string;
  messages: { system: string; user: string; blueprint: string; niche_profile: string };
  timings: { writer_ms: number; meta_ms: number; total_ms: number };
}

/** WRITER max_tokens by size: room for the article plus adaptive thinking (billed only when used). */
export const WRITER_MAX_TOKENS: Record<PostSize, number> = { small: 10_000, medium: 16_000, large: 24_000 };

export function finalProofLevel(business: 'standard' | 'regulated', suggested: boolean, choice: boolean | null): 'standard' | 'regulated' {
  if (business === 'regulated') return choice === false ? 'standard' : 'regulated';
  return suggested && choice !== false ? 'regulated' : 'standard';
}

/** One label for the whole system prompt: the parts' sources and one hash of the exact text sent. */
/**
 * content_v3_writer@code#<hash>, or @db<n>of7#<hash> when n of the 7 parts came from the registry.
 * The hash covers the exact system text sent, so equal hashes mean byte-identical prompts.
 */
export function writerPromptLabel(system: string, parts: ArticleV3Deps['writerParts']): string {
  const db = Object.values(parts ?? {}).filter((p) => p?.source === 'db').length;
  const base = promptVersionLabel({ templateType: 'content_v3_writer', source: 'fallback', text: system });
  return db ? base.replace('@code', `@db${db}of7`) : base;
}

export async function generateArticleV3(input: ArticleV3Input, deps: ArticleV3Deps): Promise<ArticleV3Result> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => Date.now());
  const started = now();

  const proof_level = finalProofLevel(input.business_proof_level, input.regulated_suggested, input.regulated_choice);
  const article_type: ArticleType = input.pins?.article_type ?? input.article_type ?? (input.plan.article_type as ArticleType) ?? 'topic';
  const settings = deps.niche?.settings ?? DEFAULT_NICHE_SETTINGS;
  const niche = buildNicheProfile({
    niche: input.niche,
    profileOverride: input.niche_profile,
    reach: input.reach,
    proofLevel: proof_level,
    articleType: article_type,
    title: input.title,
    settings,
    standardPiece: deps.niche?.standardPiece,
    regulatedPiece: deps.niche?.regulatedPiece,
  });

  const pieces = deps.blueprintPieces ?? BLUEPRINT_PIECES_V1;
  const bp = buildBlueprint(
    {
      articleType: article_type,
      postSize: input.post_size,
      suggestedSize: input.plan.post_size,
      title: input.title,
      titleForm: input.title_form,
      titleItems: input.title_items,
      reach: input.reach,
      readiness: input.plan.searcher_profile?.readiness,
      bodyQuestions: input.plan.body_questions,
      faqQuestions: input.plan.faq_questions,
      firmest: niche.firmest,
      priceAvailable: priceAvailable([...(input.research?.facts.map((f) => f.claim) ?? []), input.business_pricing]),
      businessSupplied: !!(input.business_description || input.stand_out || input.featured_service),
      pins: input.pins,
      history: input.history,
      rng: input.rng,
      pieces,
    },
    log,
  );
  const recentHeadings = recentHeadingsBlock(input.history, article_type);
  const recentList = input.history.filter((h) => (h.article_type ?? '') === article_type).flatMap((h) => h.headings ?? []);

  const partsText = Object.fromEntries(Object.entries(deps.writerParts ?? {}).map(([k, v]) => [k, v?.text])) as Partial<Record<WriterPart, string>>;
  const system = buildWriterSystem(partsText);
  const user = buildWriterUserMessage({
    nicheProfile: niche.block,
    blueprint: bp.block,
    recentHeadings,
    title: input.title,
    seed_keyword: input.seed_keyword,
    language: input.language,
    post_size: input.post_size,
    business_name: input.business_name,
    niche: niche.context.nicheLabel,
    reach: input.reach,
    target_town: input.reach === 'local' ? input.target_town : undefined,
    featured_service: input.featured_service,
    business_description: input.business_description,
    stand_out: input.stand_out,
    ideal_client: input.ideal_client,
    tone: input.tone,
    point_of_view: input.point_of_view,
    cta: input.cta,
    post_answers: input.post_answers,
    anything_else: input.anything_else,
    searcher_profile: input.plan.searcher_profile,
    research: input.research,
  });
  const promptVersion = writerPromptLabel(system, deps.writerParts);
  const sources = input.research?.sources ?? {};

  let writerCost: number | null = 0;
  const writerUsage: unknown[] = [];
  let writerAttempts = 0;
  let writerMs = 0;

  const writeOnce = async () => {
    const t0 = now();
    const r = await runModelCall<WriterOutput>({
      step: 'writer',
      model: deps.writerModel,
      promptVersion,
      system,
      user,
      maxTokens: WRITER_MAX_TOKENS[input.post_size],
      timeoutMs: deps.writerTimeoutMs,
      maxAttempts: deps.maxAttempts,
      call: deps.call,
      parse: parseWriterOutput,
      runId: deps.runId,
      log,
      now,
    });
    writerMs += now() - t0;
    writerAttempts += r.attempts.length;
    writerUsage.push(...r.usage);
    writerCost = writerCost === null || r.cost_usd === null ? null : Math.round((writerCost + r.cost_usd) * 1e6) / 1e6;
    const clean = sanitizeArticle(r.value.html);
    const linked = linkSourceTokens(clean.html, sources);
    const report = validateArticle({
      html: linked.html,
      picks: bp.picks,
      postSize: input.post_size,
      seedKeyword: input.seed_keyword,
      targetTown: input.target_town,
      regulated: proof_level === 'regulated',
      linkedSources: linked.report.linked.length,
      unknownTokens: linked.report.unknown,
      itemsDelivered: r.value.json.items_delivered,
      claimsToCheck: r.value.json.claims_to_check,
      recentHeadings: recentList,
      faqQuestions: input.plan.faq_questions,
    });
    if (linked.report.unknown.length) log(`[content-v3] writer run=${deps.runId ?? '-'} unknown source tokens removed: ${linked.report.unknown.join(',')}`);
    return { html: linked.html, json: r.value.json, report, linked: linked.report.linked };
  };

  let best = await writeOnce();
  let repaired = false;
  if (!best.report.passed) {
    log(`[content-v3] validator run=${deps.runId ?? '-'} errors=${best.report.errors} codes=${best.report.issues.filter((x) => x.severity === 'error').map((x) => x.code).join(',')} — writing once more (U2)`);
    try {
      const second = await writeOnce();
      repaired = true;
      if (second.report.errors <= best.report.errors) best = second;
    } catch (err) {
      log(`[content-v3] repair run failed run=${deps.runId ?? '-'}: ${err instanceof Error ? err.message : String(err)} — keeping the first article`);
    }
  }

  let html = addTableOfContents(best.html, { include: bp.picks.toc });
  if (proof_level === 'regulated') {
    html = insertDisclaimer(html, disclaimerFor(deps.niche?.disclaimers ?? {}, niche.context.niche?.key, niche.context.profile.key));
  }

  const tm = now();
  const meta = await generateMetaV3(input.seed_keyword, html, { call: deps.call, model: deps.metaModel, timeoutMs: deps.metaTimeoutMs, runId: deps.runId, log });
  const metaMs = now() - tm;
  const faq = extractFaq(html);

  log(
    `[content-v3] article run=${deps.runId ?? '-'} type=${article_type} size=${input.post_size} proof=${proof_level} words=${best.report.word_count} ` +
      `validator=${best.report.passed ? 'pass' : `fail(${best.report.errors})`} repaired=${repaired ? 'yes' : 'no'} links=${best.linked.length} ` +
      `fingerprint=${bp.fingerprint} redraws=${bp.redraws}`,
  );

  return {
    content: html,
    meta_title: meta.meta_title,
    meta_description: meta.meta_description,
    faq,
    faq_schema: faqSchema(faq),
    validator: best.report,
    needs_review: !best.report.passed,
    repaired,
    proof_level,
    article_type,
    picks: bp.picks,
    fingerprint: bp.fingerprint,
    headings: headingsOf(html),
    linked_sources: best.linked,
    writer_json: best.json,
    writer_attempts: writerAttempts,
    cost: { writer: writerCost, meta: meta.cost_usd },
    usage: { writer: writerUsage, meta: meta.usage },
    prompt_version: promptVersion,
    model: deps.writerModel,
    messages: { system, user, blueprint: bp.block, niche_profile: niche.block },
    timings: { writer_ms: writerMs, meta_ms: metaMs, total_ms: now() - started },
  };
}

export { WRITER_PROMPT_DEFS };
