/**
 * The admin tester's full chain (POST /content-v3/article/test, no credits): search data → Title
 * (only when no title is given) → Research → Planner → regulated check → Writer, with the tester's
 * blueprint pins (X1–X7). Nothing is stored and no history is used, so pins and seeds repeat.
 * Returns the rendered prompts for the panel's Prompts tab.
 */
import type { SearchDataRequest, SearchDataResult } from '../search-data/search-data.service.js';
import type { TitleStepInput, TitleStepResult } from '../content-v3-steps/title.step.js';
import type { ResearchRequest, ResearchResult } from '../research/research.service.js';
import type { PlannerStepInput, PlannerStepResult } from '../content-v3-steps/planner.step.js';
import { toResearchInput } from '../research/research.service.js';
import { fallbackPlan, minimumSizeFor } from '../content-v3/planner-fallback.js';
import { regulatedSuggestion } from '../content-v3/regulated-topics.js';
import { DEFAULT_SIZE_OPTIONS, type PostSize } from '../content-v3-steps/types.js';
import { StepFailedError } from '../content-v3-steps/attempts.js';
import { mulberry32, type BlueprintPins } from '../blueprint/blueprint.js';
import type { ArticleV3Input, ArticleV3Result } from './article.js';
import type { PointOfView } from './user-message.js';

export interface TestChainParams {
  seed_keyword: string;
  niche: string;
  title?: string;
  post_size: PostSize;
  language?: string;
  reach: 'local' | 'nationwide';
  target_town?: string;
  business_name?: string;
  business_description?: string;
  stand_out?: string;
  ideal_client?: string;
  featured_service?: string;
  business_pricing?: string;
  proof_level?: 'standard' | 'regulated';
  tone?: string;
  point_of_view?: PointOfView;
  cta?: { text?: string; url?: string; phone?: string };
  anything_else?: string;
  pins?: BlueprintPins;
  seed?: number;
}

export interface TestChainDeps {
  searchData: (req: SearchDataRequest) => Promise<SearchDataResult>;
  title: (input: TitleStepInput) => Promise<TitleStepResult>;
  research: (req: ResearchRequest) => Promise<ResearchResult>;
  planner: (input: PlannerStepInput) => Promise<PlannerStepResult>;
  generate: (input: ArticleV3Input) => Promise<ArticleV3Result>;
  now?: () => number;
}

export async function runTestChain(p: TestChainParams, deps: TestChainDeps) {
  const now = deps.now ?? (() => Date.now());
  const timings: Record<string, number> = {};
  const t = () => now();
  const town = p.reach === 'local' ? p.target_town : undefined;

  let s = t();
  const sd = await deps.searchData({ seed_keyword: p.seed_keyword, language: p.language, reach: p.reach, target_town: town, not_about_location: p.reach === 'local' && !town });
  timings.search_data = t() - s;

  let title = (p.title ?? '').trim();
  let titleStep: TitleStepResult | null = null;
  if (!title) {
    s = t();
    titleStep = await deps.title({ seed_keyword: p.seed_keyword, language: p.language, niche: p.niche, reach: p.reach, proof_level: p.proof_level, ideal_client: p.ideal_client, target_town: town, featured_service: p.featured_service, search_data: sd.block ?? undefined, max_list_items: 15, previous_titles: [] });
    title = titleStep.output.title;
    timings.title = t() - s;
  }

  s = t();
  const research = await deps.research({ title, seed_keyword: p.seed_keyword, language: p.language, niche: p.niche, featured_service: p.featured_service, reach: p.reach, target_town: town, people_also_ask: sd.block?.people_also_ask ?? [], local_domains: sd.meta.local_domains });
  timings.research = t() - s;

  const lead = /^\s*(\d{1,2})\s+\S/.exec(title);
  const form = titleStep ? titleStep.output.form : lead ? 'numbered' : undefined;
  const items = titleStep ? titleStep.output.items : lead ? Number(lead[1]) : null;
  const minimum_size = minimumSizeFor(form, items);

  s = t();
  let planner: PlannerStepResult | null = null;
  let plan;
  try {
    planner = await deps.planner({
      title,
      seed_keyword: p.seed_keyword,
      language: p.language,
      niche: p.niche,
      reach: p.reach,
      proof_level: p.proof_level,
      ideal_client: p.ideal_client,
      target_town: town,
      featured_service: p.featured_service,
      business_description: p.business_description,
      search_data: sd.block ?? undefined,
      research: research.research ? toResearchInput(research.research) : undefined,
      size_options: DEFAULT_SIZE_OPTIONS,
      minimum_size,
    });
    plan = planner.output;
  } catch (err) {
    if (!(err instanceof StepFailedError)) throw err;
    plan = fallbackPlan({ seedKeyword: p.seed_keyword, title, minimumSize: minimum_size, searchData: sd.block });
  }
  timings.planner = t() - s;

  const regulated = regulatedSuggestion({ businessProofLevel: p.proof_level, title, seedKeyword: p.seed_keyword, plannerRegulated: plan.regulated_topic, plannerReason: plan.regulated_reason });

  s = t();
  const article = await deps.generate({
    title,
    seed_keyword: p.seed_keyword,
    language: p.language,
    niche: p.niche,
    reach: p.reach,
    target_town: town,
    featured_service: p.featured_service,
    business_description: p.business_description,
    ideal_client: p.ideal_client,
    business_name: p.business_name,
    stand_out: p.stand_out,
    business_pricing: p.business_pricing,
    business_proof_level: p.proof_level ?? 'standard',
    regulated_suggested: regulated.suggested && regulated.by !== 'business',
    regulated_choice: null,
    plan,
    title_form: form ?? null,
    title_items: items ?? null,
    research: research.research,
    post_size: p.post_size,
    point_of_view: p.point_of_view,
    tone: p.tone,
    cta: p.cta,
    anything_else: p.anything_else,
    pins: p.pins,
    history: [],
    rng: p.seed !== undefined ? mulberry32(p.seed) : undefined,
  });
  timings.writer_and_meta = t() - s;

  return {
    title,
    search_data: { block: sd.block, meta: sd.meta },
    research: { status: research.status, facts: research.research?.facts.length ?? 0, local_conditions: research.research?.local_conditions.length ?? 0, cost_usd: research.cost_usd },
    plan,
    plan_fallback: !planner,
    regulated,
    article,
    timings,
    prompts: {
      ...(titleStep ? { 'Title — user message': titleStep.messages.user } : {}),
      ...(planner ? { 'Planner — user message': planner.messages.user } : {}),
      'Writer — system prompt (cached)': article.messages.system,
      'Writer — user message': article.messages.user,
    },
  };
}
