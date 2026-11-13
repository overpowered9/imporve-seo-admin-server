/**
 * Live wiring for Research: the DB-tunable instructions (template content_v3_research, in-code
 * text as fallback, same rule as the step prompts) and the wizard-session storage (R8): a result is
 * kept for Regenerate Content and Change Image, keyed by title + keyword + town + language, so the
 * same article never pays Perplexity twice. A failed or skipped run is not stored.
 */
import { PromptManagementService } from '../prompt-management.service.js';
import type { ContentV3Store } from '../content-v3/store.js';
import { RESEARCH_PROMPT_DEF } from './prompt.js';
import { runResearch, type ResearchRequest, type ResearchResult, type ResearchDeps } from './research.service.js';

export async function liveResearchInstructions(svc: PromptManagementService = new PromptManagementService()): Promise<{ text: string; source: 'db' | 'fallback'; dbVersion?: number | null }> {
  try {
    const active = await svc.getPromptWithVersion(RESEARCH_PROMPT_DEF.templateType);
    if (active.text && active.text.trim()) return { text: active.text, source: 'db', dbVersion: active.version };
  } catch {
    // No template yet (not seeded) or Mongo unavailable: the in-code text, which equals the doc.
  }
  return { text: RESEARCH_PROMPT_DEF.fallback, source: 'fallback' };
}

export function researchCacheKey(req: ResearchRequest): string {
  const n = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [n(req.title), n(req.seed_keyword), n(req.reach), n(req.target_town), n(req.language)].join('|');
}

export interface SessionResearch extends ResearchResult {
  cached: boolean;
}

export async function sessionResearch(
  store: ContentV3Store,
  ids: { userId: number; websiteId: number; sessionKey: string | null },
  req: ResearchRequest,
  deps: ResearchDeps = {},
): Promise<SessionResearch> {
  const key = researchCacheKey(req);
  if (ids.sessionKey) {
    const session = await store.getSession(ids.userId, ids.websiteId, ids.sessionKey);
    const hit = session?.research as { key?: string; result?: ResearchResult } | undefined;
    if (hit?.key === key && hit.result?.research) {
      console.log(`[research] session hit run=${ids.sessionKey}`);
      return { ...hit.result, cached: true };
    }
  }
  const result = await runResearch(req, { resolveInstructions: () => liveResearchInstructions(), runId: ids.sessionKey ?? undefined, ...deps });
  if (ids.sessionKey && result.status === 'ok' && result.research) {
    await store.mergeSession(ids.userId, ids.websiteId, ids.sessionKey, { research: { key, result } });
  }
  return { ...result, cached: false };
}
