/**
 * Content v3 · PROMPT 1 · Title step.
 *
 * Runs on "Generate title" with the writing model. Code builds the data tags from the request
 * (docs/content-v3-prompt-drafts.md, "Data, built by code"), the model answers JSON, and code
 * checks it: a title over 70 characters, unreadable JSON or a failed call is a failed attempt, up
 * to 3 attempts (the doc's rule, attempts.ts).
 *
 * Option B: when keyword data is in effect AND available, the V2 system prompt is used and the
 * <keyword_data> block (10 related keywords) is appended to the USER message after the other data
 * tags. Otherwise this is exactly the V1 step — see step-common.ts.
 *
 * The search-data lookup the doc describes (DataForSEO SERP) is not built on this branch;
 * `search_data` is an optional input until it is.
 */
import { parseJsonLoose } from '../claude.service.js';
import { KEYWORD_DATA_DEFAULTS } from '../../config/keyword-data.config.js';
import { promptVersionLabel, runModelCall } from '../model-call.js';
import { V3_STEP_PROMPT_DEFS } from './prompts.js';
import { resolveStepKeywordData, str, type StepDeps, type StepResultBase } from './step-common.js';
import type { SearchDataInput } from './types.js';
import { inline, joinBlocks, listTag, searchDataBlock, tag } from './xml.js';

export interface TitleStepInput {
  seed_keyword: string;
  language?: string;
  niche?: string;
  reach?: string;
  proof_level?: string;
  ideal_client?: string;
  target_town?: string;
  featured_service?: string;
  search_data?: SearchDataInput;
  max_list_items?: number;
  previous_titles?: string[];
  use_keyword_data?: boolean;
  location_code?: number;
  language_code?: string;
}

export const TITLE_FORMS = ['question', 'statement', 'numbered'] as const;
export type TitleForm = (typeof TITLE_FORMS)[number];

export interface TitleStepOutput {
  title: string;
  form: TitleForm;
  items: number | null;
  main_concern: string;
  page_kind: string;
}

export interface TitleStepResult extends StepResultBase {
  output: TitleStepOutput;
}

/** The doc: over 70 characters counts as a failed attempt; models cannot count characters reliably. */
export const TITLE_MAX_CHARS = 70;
// Headroom for thinking on models that think by default (see PLANNER_MAX_TOKENS in
// planner.step.ts). The title JSON itself is under 150 tokens; 600 left no room if the writing
// model in production is one of those models.
export const TITLE_MAX_TOKENS = 2000;

export function buildTitleUserMessage(input: TitleStepInput, keywordDataBlock: string | null): string {
  const data = joinBlocks([
    tag('seed_keyword', input.seed_keyword),
    tag('language', input.language),
    tag('niche', input.niche),
    tag('reach', input.reach),
    tag('proof_level', input.proof_level),
    tag('ideal_client', input.ideal_client),
    tag('target_town', input.target_town),
    tag('featured_service', input.featured_service),
    searchDataBlock(input.search_data),
    tag('max_list_items', input.max_list_items),
    listTag('previous_titles', (input.previous_titles ?? []).map((t) => `<title>${inline(t)}</title>`)),
    keywordDataBlock,
  ]);
  return `${data}\n\nWrite the title.`;
}

/** Coerce the model's JSON into the output shape. Throws on a non-object so it counts as unreadable. */
export function normalizeTitleOutput(raw: unknown): TitleStepOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('output is not a JSON object');
  const o = raw as Record<string, unknown>;
  const itemsRaw = o.items;
  const items =
    typeof itemsRaw === 'number' && Number.isFinite(itemsRaw)
      ? Math.round(itemsRaw)
      : typeof itemsRaw === 'string' && /^\d+$/.test(itemsRaw.trim())
        ? parseInt(itemsRaw, 10)
        : null;
  return {
    title: str(o.title).replace(/\s+/g, ' '),
    form: str(o.form).toLowerCase() as TitleForm,
    items,
    main_concern: str(o.main_concern),
    page_kind: str(o.page_kind),
  };
}

export function validateTitleOutput(o: TitleStepOutput, input: Pick<TitleStepInput, 'max_list_items'>): string | null {
  if (!o.title) return 'empty_title';
  if (o.title.length > TITLE_MAX_CHARS) return `title_too_long: ${o.title.length} chars`;
  if (!(TITLE_FORMS as readonly string[]).includes(o.form)) return `invalid_form: ${o.form || '(missing)'}`;
  if (o.items !== null && (!Number.isInteger(o.items) || o.items < 1)) return 'invalid_items';
  if (o.form === 'numbered' && o.items === null) return 'numbered_without_items';
  if (o.form === 'numbered' && typeof input.max_list_items === 'number' && o.items !== null && o.items > input.max_list_items) {
    return `items_exceed_max_list_items: ${o.items} > ${input.max_list_items}`;
  }
  return null;
}

export async function runTitleStep(input: TitleStepInput, deps: StepDeps): Promise<TitleStepResult> {
  const { log = (line) => console.log(line), now = () => Date.now() } = deps;
  const startedAt = now();

  const kd = await resolveStepKeywordData('title', input, KEYWORD_DATA_DEFAULTS.titleRelatedLimit, deps);
  const def = kd.data ? V3_STEP_PROMPT_DEFS.titleKeywordData : V3_STEP_PROMPT_DEFS.title;
  const prompt = await deps.resolvePrompt(def);
  const user = buildTitleUserMessage(input, kd.data ? kd.data.block : null);

  const modelName = deps.modelName ?? 'unknown-model';
  const label = promptVersionLabel({ templateType: prompt.templateType, source: prompt.source, dbVersion: prompt.dbVersion, text: prompt.text });
  const modelStarted = now();
  const r = await runModelCall<TitleStepOutput>({
    step: 'title',
    model: modelName,
    promptVersion: label,
    system: prompt.text,
    user,
    maxTokens: TITLE_MAX_TOKENS,
    timeoutMs: deps.timeoutMs ?? 60_000,
    maxAttempts: deps.maxAttempts,
    call: (o) => deps.model(o),
    parse: (text) => normalizeTitleOutput(parseJsonLoose(text)),
    validate: (o) => validateTitleOutput(o, input),
    runId: deps.runId,
    log,
    now,
    env: deps.env,
  });

  return {
    output: r.value,
    attempts: r.attempts,
    usage: r.usage,
    cost_usd: r.cost_usd,
    model: modelName,
    keyword_data: kd.info,
    prompt: { templateType: prompt.templateType, source: prompt.source, version: kd.data ? 'v2_keyword_data' : 'v1', label },
    timings: { total_ms: now() - startedAt, keyword_data_ms: kd.info.ms, model_ms: now() - modelStarted },
    messages: { system: prompt.text, user },
  };
}
