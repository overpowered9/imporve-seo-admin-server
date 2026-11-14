/**
 * What the Title and Planner steps share: dependencies, the keyword-data decision, and the result
 * bookkeeping. The steps themselves are title.step.ts and planner.step.ts.
 *
 * THE KEYWORD DATA DECISION, in one place (resolveStepKeywordData):
 *   requested  the request sent use_keyword_data: true
 *   effective  requested AND ISEO_V3_KEYWORD_DATA === "true"   (keywordDataEffective)
 *   used       effective AND the server cache / DataForSEO produced a block within the budget
 * Only `used` changes anything: the V2 prompt is selected and the block goes into the USER
 * message. Not effective, or effective but unavailable (timeout, provider error, not configured,
 * no data), both run the step exactly as without the flag — V1 prompt, no block — and the
 * fallback is logged as `[keyword-data] fallback step=<step> …`.
 */
import type { ClaudeUsage } from '../claude.service.js';
import { KEYWORD_DATA_DEFAULTS, keywordDataEffective } from '../../config/keyword-data.config.js';
import type { KeywordDataService, PromptKeywordData } from '../keyword-data/keyword-data.service.js';
import { normalizeKeyword } from '../keyword-data/keyword-data.types.js';
import type { AttemptRecord } from './attempts.js';
import type { StepPromptResolver } from './prompts.js';
import { runTag } from '../run-context.js';

export interface ModelCallOptions {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** Set by model-call.ts: aborted when the attempt's timeout fires. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One model call. The live one is model-call.ts's anthropicProviderCall (system block cached,
 * thinking omitted, the same request claudeText sends with thinking: false); tests script it.
 */
export type ModelCall = (opts: ModelCallOptions) => Promise<{ text: string; usage: ClaudeUsage; stop_reason?: string | null }>;

export interface StepDeps {
  model: ModelCall;
  resolvePrompt: StepPromptResolver;
  /** null when keyword data is not wired at all; the live wiring always passes the service. */
  keywordData: KeywordDataService | null;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => number;
  maxAttempts?: number;
  modelName?: string;
  /** Per-attempt timeout (config/content-v3.config.ts). Default 60 s. */
  timeoutMs?: number;
  /** Correlates the [model-call] lines of one wizard session (the plugin's target_key). */
  runId?: string;
  /** B-3: epoch ms by which the request must answer; no attempt starts or waits past it. */
  deadlineAt?: number;
}

export interface StepKeywordDataInfo {
  requested: boolean;
  effective: boolean;
  used: boolean;
  source?: string;
  related_count?: number;
  /** Why effective-but-unused: not_configured | unavailable. The specific provider reason is in the log. */
  reason?: string;
  ms: number;
}

export interface StepPromptInfo {
  templateType: string;
  source: 'db' | 'fallback';
  version: 'v1' | 'v2_keyword_data';
  /** promptVersionLabel(): template, DB version (or "code") and a hash of the exact text sent. */
  label: string;
}

export interface StepTimings {
  total_ms: number;
  keyword_data_ms: number;
  model_ms: number;
}

export interface StepResultBase {
  attempts: AttemptRecord[];
  /** Every attempt's usage, so cost is never under-reported. */
  usage: ClaudeUsage[];
  /** USD over every attempt (model-pricing.ts); null when the model has no known price. */
  cost_usd: number | null;
  model: string;
  keyword_data: StepKeywordDataInfo;
  prompt: StepPromptInfo;
  timings: StepTimings;
  /** The exact messages sent. Returned by the admin-only routes for tuning; never to the plugin. */
  messages: { system: string; user: string };
}

export async function resolveStepKeywordData(
  step: 'title' | 'planner',
  input: { seed_keyword: string; use_keyword_data?: boolean; location_code?: number; language_code?: string },
  relatedLimit: number,
  deps: StepDeps,
): Promise<{ info: StepKeywordDataInfo; data: PromptKeywordData | null }> {
  const { env = process.env, log = (line) => console.log(line), now = () => Date.now() } = deps;
  const requested = input.use_keyword_data === true;
  const effective = keywordDataEffective(input.use_keyword_data, env);
  const info: StepKeywordDataInfo = { requested, effective, used: false, ms: 0 };
  if (!effective) return { info, data: null };

  const started = now();
  let data: PromptKeywordData | null = null;
  if (!deps.keywordData) {
    info.reason = 'not_configured';
    log(`[keyword-data] fallback${runTag()} step=${step} seed="${normalizeKeyword(input.seed_keyword)}" reason=not_configured`);
  } else {
    // tryGetForPrompt never throws and logs the specific reason for a null itself.
    data = await deps.keywordData.tryGetForPrompt(
      input.seed_keyword,
      input.location_code,
      input.language_code,
      relatedLimit,
      KEYWORD_DATA_DEFAULTS.fetchBudgetMs,
    );
    if (!data) info.reason = 'unavailable';
  }
  info.ms = now() - started;
  if (data) {
    info.used = true;
    info.source = data.source;
    info.related_count = data.related.length;
  }
  return { info, data };
}

/** A trimmed string, or '' for anything that is not a string. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Non-empty trimmed strings only, in order. */
export function strList(v: unknown, max?: number): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  return typeof max === 'number' ? out.slice(0, max) : out;
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
