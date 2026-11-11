/**
 * A/B harness: the same keywords through Title and Planner with keyword data OFF and then ON.
 *
 * For each keyword (at most 10):
 *   1. Freeze the inputs. The SERP lookup and the research step are not built on this branch, so
 *      "fetch once and freeze" means: take `fixtures[keyword].search_data` / `.research` as given
 *      (or nothing) and hand the SAME objects to both arms. Keyword data is prefetched once so the
 *      ON arm reads from the cache and its latency is the step's, not DataForSEO's.
 *   2. Arm OFF: Title (use_keyword_data false) → Planner with that title.
 *   3. Arm ON:  Title (use_keyword_data true, env forced on) → Planner with that title.
 *      The env flag is forced for the ON arm only, so the harness compares the two behaviours even
 *      on a server where ISEO_V3_KEYWORD_DATA is still off.
 *   4. Record per step: chosen title / ranked questions / demand_notes / overlap, attempts, token
 *      usage, estimated model cost (only when prices are configured; tokens are always reported),
 *      DataForSEO cost, latency, which prompt version ran.
 *
 * Output is a JSON document and a CSV summary, written under data/ab-tests/ (not the statically
 * served uploads/ folder) and returned to the caller. Nothing is published, no user_generations
 * row is written, no credits move.
 */
import { KEYWORD_DATA_DEFAULTS } from '../../config/keyword-data.config.js';
import type { ClaudeUsage } from '../claude.service.js';
import type { KeywordDataService } from '../keyword-data/keyword-data.service.js';
import { normalizeKeyword } from '../keyword-data/keyword-data.types.js';
import type { AttemptRecord } from '../content-v3-steps/attempts.js';
import { runPlannerStep, type PlannerOverlap, type PlannerStepInput } from '../content-v3-steps/planner.step.js';
import type { StepDeps } from '../content-v3-steps/step-common.js';
import { runTitleStep, type TitleStepInput } from '../content-v3-steps/title.step.js';
import type { PostSize, RecentPost, ResearchInput, SearchDataInput } from '../content-v3-steps/types.js';

export const AB_MAX_KEYWORDS = 10;

export interface AbFixture {
  search_data?: SearchDataInput;
  research?: ResearchInput;
}

export interface AbBusiness {
  language?: string;
  niche?: string;
  reach?: string;
  proof_level?: string;
  ideal_client?: string;
  target_town?: string;
  featured_service?: string;
  business_description?: string;
  max_list_items?: number;
  minimum_size?: PostSize;
  size_options?: Partial<Record<PostSize, string>>;
  recent_posts?: RecentPost[];
}

export interface AbRunInput {
  keywords: string[];
  location_code?: number;
  language_code?: string;
  business?: AbBusiness;
  /** Keyed by keyword as sent (matched after normalisation). */
  fixtures?: Record<string, AbFixture>;
}

export interface AbTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface AbStepRecord {
  ok: boolean;
  error?: string;
  attempts: number;
  attempt_log: AttemptRecord[];
  tokens: AbTokens;
  /** null unless AB_MODEL_PRICE_INPUT_PER_MTOK / AB_MODEL_PRICE_OUTPUT_PER_MTOK are set. */
  model_cost_usd: number | null;
  latency_ms: number;
  prompt_version: 'v1' | 'v2_keyword_data' | null;
  keyword_data_used: boolean;
}

export interface AbTitleRecord extends AbStepRecord {
  title: string | null;
  form: string | null;
  items: number | null;
}

export interface AbPlannerRecord extends AbStepRecord {
  article_type: string | null;
  post_size: string | null;
  body_questions: string[];
  faq_questions: string[];
  demand_notes: string | null;
  overlap: PlannerOverlap | null;
  recent_posts_sent: number[];
}

export interface AbArm {
  keyword_data: 'off' | 'on';
  title: AbTitleRecord;
  planner: AbPlannerRecord;
}

export interface AbKeywordResult {
  keyword: string;
  prefetch: { status: string; source: string; related_count: number; cost_usd: number; ms: number; reason?: string };
  frozen: { search_data: boolean; research: boolean };
  off: AbArm;
  on: AbArm;
}

export interface AbRunResult {
  run_id: string;
  started_at: string;
  finished_at: string;
  location_code: number;
  language_code: string;
  /** Whether the live server's ISEO_V3_KEYWORD_DATA was on. The ON arm runs either way. */
  flag_env_on: boolean;
  model_prices_configured: boolean;
  keywords: AbKeywordResult[];
  totals: { dataforseo_cost_usd: number; model_cost_usd: number | null; tokens: AbTokens; latency_ms: number };
  files: { json: string; csv: string } | null;
}

export interface AbDeps {
  titleDeps: StepDeps;
  plannerDeps: StepDeps;
  keywordData: KeywordDataService;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
  /** Where to save; null skips saving. */
  outDir?: string | null;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  runId?: () => string;
}

const emptyTokens = (): AbTokens => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

function addUsage(t: AbTokens, usage: ClaudeUsage[]): AbTokens {
  for (const u of usage) {
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cache_read += u.cache_read_input_tokens ?? 0;
    t.cache_creation += u.cache_creation_input_tokens ?? 0;
  }
  return t;
}

function sumTokens(a: AbTokens, b: AbTokens): AbTokens {
  return { input: a.input + b.input, output: a.output + b.output, cache_read: a.cache_read + b.cache_read, cache_creation: a.cache_creation + b.cache_creation };
}

/** USD per million tokens, from env; null when not configured so we never invent a price. */
export function modelPrices(env: NodeJS.ProcessEnv): { input: number; output: number } | null {
  const i = Number(env.AB_MODEL_PRICE_INPUT_PER_MTOK);
  const o = Number(env.AB_MODEL_PRICE_OUTPUT_PER_MTOK);
  if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0 || (!env.AB_MODEL_PRICE_INPUT_PER_MTOK && !env.AB_MODEL_PRICE_OUTPUT_PER_MTOK)) return null;
  return { input: i, output: o };
}

function costOf(tokens: AbTokens, prices: { input: number; output: number } | null): number | null {
  if (!prices) return null;
  return Number((((tokens.input + tokens.cache_read + tokens.cache_creation) * prices.input + tokens.output * prices.output) / 1_000_000).toFixed(6));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runKeywordDataAbTest(input: AbRunInput, deps: AbDeps): Promise<AbRunResult> {
  const {
    env = process.env,
    now = () => new Date(),
    log = (line) => console.log(line),
    outDir = 'data/ab-tests',
    writeFile,
    runId = () => `${now().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
  } = deps;
  const startedAt = now();
  const id = runId();
  const loc = input.location_code ?? KEYWORD_DATA_DEFAULTS.locationCode;
  const lang = (input.language_code ?? KEYWORD_DATA_DEFAULTS.languageCode).toLowerCase();
  const prices = modelPrices(env);
  const business = input.business ?? {};
  const envOn = { ...env, ISEO_V3_KEYWORD_DATA: 'true' } as NodeJS.ProcessEnv;
  const envOff = { ...env, ISEO_V3_KEYWORD_DATA: 'false' } as NodeJS.ProcessEnv;

  const fixtureFor = (keyword: string): AbFixture => {
    const want = normalizeKeyword(keyword);
    for (const [k, v] of Object.entries(input.fixtures ?? {})) if (normalizeKeyword(k) === want) return v ?? {};
    return {};
  };

  const results: AbKeywordResult[] = [];
  const keywords = input.keywords.slice(0, AB_MAX_KEYWORDS);

  for (const keyword of keywords) {
    const fixture = fixtureFor(keyword);
    log(`[ab] keyword="${keyword}" prefetching keyword data`);
    const pf0 = Date.now();
    const pf = await deps.keywordData.getSeedWithRelated(keyword, loc, lang, { budgetMs: KEYWORD_DATA_DEFAULTS.fetchBudgetMs });
    const prefetch = { status: pf.status, source: pf.source, related_count: pf.related.length, cost_usd: pf.cost_usd, ms: Date.now() - pf0, ...(pf.reason ? { reason: pf.reason } : {}) };

    const runArm = async (arm: 'off' | 'on'): Promise<AbArm> => {
      const useKd = arm === 'on';
      const armEnv = useKd ? envOn : envOff;
      const titleInput: TitleStepInput = {
        seed_keyword: keyword,
        language: business.language,
        niche: business.niche,
        reach: business.reach,
        proof_level: business.proof_level,
        ideal_client: business.ideal_client,
        target_town: business.target_town,
        featured_service: business.featured_service,
        search_data: fixture.search_data,
        max_list_items: business.max_list_items,
        use_keyword_data: useKd,
        location_code: loc,
        language_code: lang,
      };

      const title: AbTitleRecord = { ok: false, attempts: 0, attempt_log: [], tokens: emptyTokens(), model_cost_usd: null, latency_ms: 0, prompt_version: null, keyword_data_used: false, title: null, form: null, items: null };
      const t0 = Date.now();
      let chosenTitle: string | null = null;
      try {
        const r = await runTitleStep(titleInput, { ...deps.titleDeps, env: armEnv, log });
        chosenTitle = r.output.title;
        Object.assign(title, {
          ok: true,
          attempts: r.attempts.length,
          attempt_log: r.attempts,
          tokens: addUsage(emptyTokens(), r.usage),
          prompt_version: r.prompt.version,
          keyword_data_used: r.keyword_data.used,
          title: r.output.title,
          form: r.output.form,
          items: r.output.items,
        });
      } catch (err) {
        title.error = errorMessage(err);
        log(`[ab] keyword="${keyword}" arm=${arm} title failed: ${title.error}`);
      }
      title.latency_ms = Date.now() - t0;
      title.model_cost_usd = costOf(title.tokens, prices);

      const planner: AbPlannerRecord = { ok: false, attempts: 0, attempt_log: [], tokens: emptyTokens(), model_cost_usd: null, latency_ms: 0, prompt_version: null, keyword_data_used: false, article_type: null, post_size: null, body_questions: [], faq_questions: [], demand_notes: null, overlap: null, recent_posts_sent: [] };
      if (chosenTitle) {
        const plannerInput: PlannerStepInput = {
          title: chosenTitle,
          seed_keyword: keyword,
          language: business.language,
          niche: business.niche,
          reach: business.reach,
          proof_level: business.proof_level,
          ideal_client: business.ideal_client,
          target_town: business.target_town,
          featured_service: business.featured_service,
          business_description: business.business_description,
          search_data: fixture.search_data,
          research: fixture.research,
          size_options: business.size_options,
          minimum_size: business.minimum_size,
          use_keyword_data: useKd,
          recent_posts: business.recent_posts,
          location_code: loc,
          language_code: lang,
        };
        const p0 = Date.now();
        try {
          const r = await runPlannerStep(plannerInput, { ...deps.plannerDeps, env: armEnv, log });
          Object.assign(planner, {
            ok: true,
            attempts: r.attempts.length,
            attempt_log: r.attempts,
            tokens: addUsage(emptyTokens(), r.usage),
            prompt_version: r.prompt.version,
            keyword_data_used: r.keyword_data.used,
            article_type: r.output.article_type,
            post_size: r.output.post_size,
            body_questions: r.output.body_questions,
            faq_questions: r.output.faq_questions,
            demand_notes: r.output.demand_notes,
            overlap: r.output.overlap,
            recent_posts_sent: r.recent_posts.sent.map((s) => s.post_id),
          });
        } catch (err) {
          planner.error = errorMessage(err);
          log(`[ab] keyword="${keyword}" arm=${arm} planner failed: ${planner.error}`);
        }
        planner.latency_ms = Date.now() - p0;
      } else {
        planner.error = 'skipped: no title';
      }
      planner.model_cost_usd = costOf(planner.tokens, prices);
      return { keyword_data: arm, title, planner };
    };

    const off = await runArm('off');
    const on = await runArm('on');
    results.push({ keyword, prefetch, frozen: { search_data: !!fixture.search_data, research: !!fixture.research }, off, on });
  }

  let tokens = emptyTokens();
  let dfs = 0;
  let latency = 0;
  for (const k of results) {
    dfs += k.prefetch.cost_usd;
    for (const arm of [k.off, k.on]) {
      tokens = sumTokens(tokens, sumTokens(arm.title.tokens, arm.planner.tokens));
      latency += arm.title.latency_ms + arm.planner.latency_ms;
    }
  }

  const result: AbRunResult = {
    run_id: id,
    started_at: startedAt.toISOString(),
    finished_at: now().toISOString(),
    location_code: loc,
    language_code: lang,
    flag_env_on: env.ISEO_V3_KEYWORD_DATA === 'true',
    model_prices_configured: prices !== null,
    keywords: results,
    totals: { dataforseo_cost_usd: Number(dfs.toFixed(6)), model_cost_usd: costOf(tokens, prices), tokens, latency_ms: latency },
    files: null,
  };

  if (outDir && writeFile) {
    const jsonPath = `${outDir}/${id}.json`;
    const csvPath = `${outDir}/${id}.csv`;
    try {
      await writeFile(jsonPath, JSON.stringify(result, null, 2));
      await writeFile(csvPath, abResultToCsv(result));
      result.files = { json: jsonPath, csv: csvPath };
    } catch (err) {
      log(`[ab] could not save results: ${errorMessage(err)}`);
    }
  }
  return result;
}

export const AB_CSV_COLUMNS = [
  'run_id', 'keyword', 'arm', 'prefetch_status',
  'title', 'title_form', 'title_prompt', 'title_kd_used', 'title_attempts', 'title_in_tokens', 'title_out_tokens', 'title_cost_usd', 'title_latency_ms', 'title_error',
  'article_type', 'post_size', 'body_questions', 'faq_questions', 'demand_notes', 'overlap_post_id', 'overlap_reason', 'recent_posts_sent',
  'planner_prompt', 'planner_kd_used', 'planner_attempts', 'planner_in_tokens', 'planner_out_tokens', 'planner_cost_usd', 'planner_latency_ms', 'planner_error',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join(' || ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function abResultToCsv(result: AbRunResult): string {
  const rows: string[] = [AB_CSV_COLUMNS.join(',')];
  for (const k of result.keywords) {
    for (const arm of [k.off, k.on]) {
      rows.push(
        [
          result.run_id, k.keyword, arm.keyword_data, k.prefetch.status,
          arm.title.title, arm.title.form, arm.title.prompt_version, arm.title.keyword_data_used, arm.title.attempts, arm.title.tokens.input, arm.title.tokens.output, arm.title.model_cost_usd, arm.title.latency_ms, arm.title.error,
          arm.planner.article_type, arm.planner.post_size, arm.planner.body_questions, arm.planner.faq_questions, arm.planner.demand_notes, arm.planner.overlap?.post_id ?? null, arm.planner.overlap?.reason ?? null, arm.planner.recent_posts_sent,
          arm.planner.prompt_version, arm.planner.keyword_data_used, arm.planner.attempts, arm.planner.tokens.input, arm.planner.tokens.output, arm.planner.model_cost_usd, arm.planner.latency_ms, arm.planner.error,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return rows.join('\n') + '\n';
}
