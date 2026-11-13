/**
 * Live dependencies for the Title and Planner steps: Claude through claude.service.ts (system
 * block cached, thinking off), DB-tunable prompts through PromptManagementService with the in-code
 * constant as fallback (same semantics as getV3Prompt in the Writer chain), and the shared keyword
 * data service.
 */
import { anthropicProviderCall } from '../model-call.js';
import { config } from '../../config/config.js';
import { contentV3Config } from '../../config/content-v3.config.js';
import { PromptManagementService } from '../prompt-management.service.js';
import { getKeywordDataService } from '../keyword-data/keyword-data.default.js';
import type { StepPromptResolver } from './prompts.js';
import type { ModelCall, StepDeps } from './step-common.js';

export function liveStepPromptResolver(svc: PromptManagementService = new PromptManagementService()): StepPromptResolver {
  return async (def) => {
    const base = { templateType: def.templateType, displayName: def.displayName };
    try {
      const active = await svc.getPromptWithVersion(def.templateType);
      if (active.text && active.text.trim()) return { ...base, text: active.text, source: 'db', dbVersion: active.version };
      return { ...base, text: def.fallback, source: 'fallback' };
    } catch (e) {
      console.warn(`ℹ️ v3 step prompt ${def.templateType}: using in-code fallback (${(e as Error).message})`);
      return { ...base, text: def.fallback, source: 'fallback' };
    }
  };
}

// Previously claudeText({ ..., thinking: false }); anthropicProviderCall sends the same request
// (cached system block, no thinking parameter) and adds the abort signal and timeout.
export const liveModelCall: ModelCall = ({ system, user, model, maxTokens, signal, timeoutMs }) =>
  anthropicProviderCall({
    system,
    user,
    model: model ?? config.anthropicModel,
    maxTokens: maxTokens ?? 2000,
    signal: signal ?? new AbortController().signal,
    timeoutMs: timeoutMs ?? 60_000,
  });

let resolver: StepPromptResolver | null = null;
function sharedResolver(): StepPromptResolver {
  if (!resolver) resolver = liveStepPromptResolver();
  return resolver;
}

/** Title runs on the writing model (the doc: "on the writing model"). */
export function liveTitleDeps(): StepDeps {
  const v3 = contentV3Config();
  return { model: liveModelCall, resolvePrompt: sharedResolver(), keywordData: getKeywordDataService(), modelName: config.anthropicWriteModel, maxAttempts: v3.maxAttempts, timeoutMs: v3.timeoutsMs.title };
}

/** Planner runs on the low-cost model (the doc: "on the low-cost model"). */
export function livePlannerDeps(): StepDeps {
  const v3 = contentV3Config();
  return { model: liveModelCall, resolvePrompt: sharedResolver(), keywordData: getKeywordDataService(), modelName: config.anthropicModel, maxAttempts: v3.maxAttempts, timeoutMs: v3.timeoutsMs.planner };
}
