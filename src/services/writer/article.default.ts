/**
 * Live wiring for the v3 article: the Writer's seven parts and the blueprint record from the prompt
 * registry (each falls back to its in-code text, which equals the doc), the niche settings, the
 * models and timeouts from config.
 */
import { PromptManagementService, PRE_V3_LABEL } from '../prompt-management.service.js';
import { DOC_VERSION_LABEL } from '../prompt-seed.v3.js';
import { config } from '../../config/config.js';
import { contentV3Config } from '../../config/content-v3.config.js';
import { anthropicProviderCall } from '../model-call.js';
import { BLUEPRINT_DIRECTIVES_DEF, BLUEPRINT_PIECES_V1, parseBlueprintPieces } from '../blueprint/pieces.js';
import { liveNicheSettings } from '../niche-profile/niche-profile.default.js';
import { WRITER_PROMPT_DEFS, type WriterPart } from './prompt.js';
import { generateArticleV3, type ArticleV3Deps, type ArticleV3Input, type ArticleV3Result } from './article.js';

/**
 * Templates the Writer shares with the legacy v3 chain. Their stored value is the OLD text until the
 * replace step (POST /content-v3/prompts/seed?mode=replace) has run for them, which leaves a
 * "pre-v3" backup and a "content-v3 doc" version. Before that, the doc text from code is used.
 * Found 14 Nov: production held the legacy core (asks for ===META_JSON===), so every Writer attempt
 * failed until this guard.
 */
export const LEGACY_SHARED_PARTS: ReadonlySet<WriterPart> = new Set(['core', 'rules_seo', 'rules_reader_first']);
const REPLACED_LABELS = [DOC_VERSION_LABEL, PRE_V3_LABEL];

export interface WriterPartsSvc {
  getPromptWithVersion: PromptManagementService['getPromptWithVersion'];
  hasVersionLabelled: PromptManagementService['hasVersionLabelled'];
}

const warned = new Set<string>();
function warnOnce(key: string, line: string, log: (l: string) => void) {
  if (warned.has(key)) return;
  warned.add(key);
  log(line);
}

export async function liveWriterParts(svc: WriterPartsSvc = new PromptManagementService(), log: (l: string) => void = (l) => console.warn(l)): Promise<NonNullable<ArticleV3Deps['writerParts']>> {
  const entries = await Promise.all(
    (Object.keys(WRITER_PROMPT_DEFS) as WriterPart[]).map(async (part) => {
      const def = WRITER_PROMPT_DEFS[part];
      const code = [part, { text: def.fallback, source: 'fallback' as const }] as const;
      try {
        const v = await svc.getPromptWithVersion(def.templateType);
        if (!v.text || !v.text.trim()) return code;
        if (LEGACY_SHARED_PARTS.has(part) && !(await svc.hasVersionLabelled(def.templateType, REPLACED_LABELS))) {
          warnOnce(def.templateType, `[content-v3] ${def.templateType} still holds the pre-v3 text; using the doc text from code. Run POST /api/v1/content-v3/prompts/seed?mode=replace.`, log);
          return code;
        }
        if (part === 'core' && !v.text.includes('===WRITER_JSON===')) {
          warnOnce(`${def.templateType}:marker`, `[content-v3] the active ${def.templateType} has no ===WRITER_JSON=== output contract; using the doc text from code.`, log);
          return code;
        }
        return [part, { text: v.text, source: 'db' as const, dbVersion: v.version }] as const;
      } catch {
        return code; // not seeded yet, or Mongo unavailable
      }
    }),
  );
  return Object.fromEntries(entries) as NonNullable<ArticleV3Deps['writerParts']>;
}

/** Tests only. */
export function __resetWriterPartWarnings(): void {
  warned.clear();
}

export async function liveBlueprintPieces(svc = new PromptManagementService()): Promise<Readonly<Record<string, string>>> {
  try {
    const v = await svc.getPromptWithVersion(BLUEPRINT_DIRECTIVES_DEF.templateType);
    return parseBlueprintPieces(v.text) ?? BLUEPRINT_PIECES_V1;
  } catch {
    return BLUEPRINT_PIECES_V1;
  }
}

export async function liveGenerateArticle(input: ArticleV3Input, opts: { runId: string; deadlineAt?: number }): Promise<ArticleV3Result> {
  const cfg = contentV3Config();
  const svc = new PromptManagementService();
  const [writerParts, blueprintPieces, niche] = await Promise.all([liveWriterParts(svc), liveBlueprintPieces(svc), liveNicheSettings(svc)]);
  return generateArticleV3(input, {
    call: anthropicProviderCall,
    writerModel: config.anthropicWriteModel,
    metaModel: config.anthropicModel,
    writerTimeoutMs: cfg.timeoutsMs.writer,
    metaTimeoutMs: cfg.timeoutsMs.meta,
    maxAttempts: cfg.maxAttempts,
    writerParts,
    blueprintPieces,
    niche,
    targetCalibration: cfg.targetCalibration,
    deadlineAt: opts.deadlineAt,
    runId: opts.runId,
  });
}
