/**
 * Live dependencies for the Title and Planner steps: Claude through claude.service.ts (system
 * block cached, thinking off), DB-tunable prompts through PromptManagementService with the in-code
 * constant as fallback (same semantics as getV3Prompt in the Writer chain), and the shared keyword
 * data service.
 */
import { claudeText } from '../claude.service.js';
import { config } from '../../config/config.js';
import { PromptManagementService } from '../prompt-management.service.js';
import { getKeywordDataService } from '../keyword-data/keyword-data.default.js';
import type { StepPromptResolver } from './prompts.js';
import type { ModelCall, StepDeps } from './step-common.js';

export function liveStepPromptResolver(svc: PromptManagementService = new PromptManagementService()): StepPromptResolver {
  return async (def) => {
    const base = { templateType: def.templateType, displayName: def.displayName };
    try {
      const text = await svc.getPrompt(def.templateType);
      if (text && text.trim()) return { ...base, text, source: 'db' };
      return { ...base, text: def.fallback, source: 'fallback' };
    } catch (e) {
      console.warn(`ℹ️ v3 step prompt ${def.templateType}: using in-code fallback (${(e as Error).message})`);
      return { ...base, text: def.fallback, source: 'fallback' };
    }
  };
}

export const liveModelCall: ModelCall = ({ system, user, model, maxTokens }) =>
  claudeText({ system, user, model, maxTokens, thinking: false });

let resolver: StepPromptResolver | null = null;
function sharedResolver(): StepPromptResolver {
  if (!resolver) resolver = liveStepPromptResolver();
  return resolver;
}

/** Title runs on the writing model (the doc: "on the writing model"). */
export function liveTitleDeps(): StepDeps {
  return { model: liveModelCall, resolvePrompt: sharedResolver(), keywordData: getKeywordDataService(), modelName: config.anthropicWriteModel };
}

/** Planner runs on the low-cost model (the doc: "on the low-cost model"). */
export function livePlannerDeps(): StepDeps {
  return { model: liveModelCall, resolvePrompt: sharedResolver(), keywordData: getKeywordDataService(), modelName: config.anthropicModel };
}
