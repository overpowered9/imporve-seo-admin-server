/**
 * Content Generation v3 — Claude route (additive; v2 is untouched).
 *
 *   POST /api/v1/content-v3/article/test   — requireAdmin, no credits. The prompt-tuning endpoint.
 *   POST /api/v1/content-v3/prompts/seed   — requireAdmin. Registers the v3 templates (writer chain + steps).
 *   POST /api/v1/content-v3/title          — requireAdmin, no credits. PROMPT 1 (Title step).
 *   POST /api/v1/content-v3/planner        — requireAdmin, no credits. PROMPT 3 (Planner step).
 *                                            Both in content-v3-steps.handler.ts; keyword data
 *                                            (Option B) applies when ISEO_V3_KEYWORD_DATA=true and
 *                                            the request sends use_keyword_data: true.
 *   POST /api/v1/content-v3/prompts/seed?mode=replace — requireAdmin. Also makes every doc-sourced
 *                                            prompt the active version, backing the old value up as
 *                                            "pre-v3" first (OPS2, WR3).
 *   POST /api/v1/content-v3/prompts/backup-pre-v3 — requireAdmin. Only the backup, nothing activated.
 *   GET  /api/v1/content-v3/prompts/check  — requireAdmin. Active DB text vs the doc text, per prompt.
 *   POST /api/v1/content-v3/search-data    — requireAdmin. The search data lookup alone (S1–S12).
 *   POST /api/v1/content-v3/research       — requireAdmin. Research alone (R1–R10), optionally
 *                                            after a search data lookup.
 *   POST /api/v1/content-v3/wizard/title   — validateApiAccess (plugin). Search data → Title (W2, W12, W15).
 *   POST /api/v1/content-v3/wizard/town-check — validateApiAccess (plugin). W6 town line.
 *   GET  /api/v1/content-v3/status         — validateApiAccess (plugin). Is CONTENT_V3_ENABLED on?
 *   POST /api/v1/content-v3/session/clear  — validateApiAccess (plugin). The wizard's Leave (W10).
 *   POST /api/v1/content-v3/keyword-data/prefetch — validateApiAccess (plugin). Warms the keyword
 *                                            data cache; see content-v3-keyword-data.handler.ts.
 *                                            The one plugin-facing route on this router (decided
 *                                            2026-11-11): it only reads a cache and costs no credits.
 *
 * There is deliberately no credit-gated endpoint yet. Nothing writes a `user_generations` row with
 * a `content_v3` type, so the live table's constraint on that column (which no tracked migration
 * creates, and which is therefore unverified) stays untested until a paid endpoint actually needs
 * it. The plugin continues to call /api/v1/content-v2/article throughout.
 */

import { Router, Request, Response } from 'express';
import {
  generateContentV3,
  GenerateV3Params,
  ArticleType,
  ARTICLE_TYPES,
} from '../services/claude-content-generator-v3.service.js';
import { parseBusinessProfile } from '../services/business-profile.v3.js';
import {
  ACCENTS,
  CLOSE_MOVES,
  FAQ_PLACEMENTS,
  OPENING_MOVES,
  type BlueprintOverrides,
} from '../services/content-blueprint.js';
import { seedV3Prompts } from '../services/prompt-seed.v3.js';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import { sanitizeCustomInstruction } from '../services/generation-history.js';
import keywordDataRoutes from './content-v3-keyword-data.routes.js';
import stepsRoutes from './content-v3-steps.routes.js';
import { createContentV3PluginRouter } from './content-v3-plugin.handler.js';
import { validateApiAccessWithoutStamp } from '../middleware/apiAuth.middleware.js';
import { getContentV3Store } from '../services/content-v3/store.default.js';
import { checkV3Prompts, v3DocPromptDefs } from '../services/prompt-seed.v3.js';
import { PromptManagementService } from '../services/prompt-management.service.js';
import { createSearchDataRouter } from './content-v3-search-data.handler.js';
import { lookupSearchData } from '../services/search-data/search-data.service.js';
import { liveSearchDataDeps, sessionSearchData } from '../services/search-data/search-data.default.js';
import { createContentV3WizardRouter } from './content-v3-wizard.handler.js';
import { validateApiAccess } from '../middleware/apiAuth.middleware.js';
import { rateLimitPerUser } from '../middleware/rateLimit.middleware.js';
import { runTitleStep } from '../services/content-v3-steps/title.step.js';
import { liveTitleDeps } from '../services/content-v3-steps/steps.default.js';
import { searchDataConfig } from '../config/search-data.config.js';
import { z } from 'zod';
import { runResearch, toResearchInput } from '../services/research/research.service.js';
import { liveResearchInstructions } from '../services/research/research.default.js';
import { researchBlock } from '../services/content-v3-steps/xml.js';

const researchRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  seed_keyword: z.string().trim().min(1).max(200),
  language: z.string().trim().max(40).optional(),
  niche: z.string().trim().max(120).optional(),
  featured_service: z.string().trim().max(200).optional(),
  reach: z.enum(['local', 'nationwide']).optional(),
  target_town: z.string().trim().max(120).optional(),
  state_hint: z.string().trim().max(40).optional(),
  people_also_ask: z.array(z.object({ text: z.string().max(300), scope: z.enum(['local', 'national']) })).max(20).optional(),
  local_domains: z.array(z.string().max(200)).max(40).optional(),
  /** Run the search data lookup first and feed its questions and local domains in. */
  run_search_data: z.boolean().optional(),
});

const router = Router();

// Research alone (admin: tester panel, 10-keyword run). Spends Perplexity money when configured.
router.post('/research', requireAdmin, async (req: Request, res: Response) => {
  const parsed = researchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', message: parsed.error.issues.map((i) => i.message).join('; ') });
  }
  const b = parsed.data;
  let paa = b.people_also_ask;
  let localDomains = b.local_domains;
  if (b.run_search_data) {
    const sd = await lookupSearchData({ seed_keyword: b.seed_keyword, language: b.language, reach: b.reach, target_town: b.target_town }, liveSearchDataDeps());
    paa = sd.block?.people_also_ask ?? [];
    localDomains = sd.meta.local_domains;
  }
  const r = await runResearch(
    { ...b, people_also_ask: paa, local_domains: localDomains },
    { resolveInstructions: () => liveResearchInstructions() },
  );
  return res.json({ success: true, data: { ...r, xml: r.research ? researchBlock(toResearchInput(r.research)) : '' } });
});

// The single wizard's v3 steps (plugin auth). Free, rate-limited per account; 409 while
// CONTENT_V3_ENABLED is off so the plugin falls back to v2.
router.use(
  '/',
  createContentV3WizardRouter({
    auth: validateApiAccess,
    rateLimit: rateLimitPerUser({ limit: 30, windowMs: 60_000, keyPrefix: 'content-v3-wizard', message: 'Too many requests in a short time. Please wait a minute and try again.' }),
    store: getContentV3Store,
    searchData: (store, ids, req) => sessionSearchData(store, ids, req),
    runTitle: (input, { runId }) => runTitleStep(input, { ...liveTitleDeps(), runId }),
    get locations() {
      return liveSearchDataDeps().locations;
    },
    countryIso: searchDataConfig().countryIso,
  }),
);

// Search data lookup on its own (admin: tester panel, 10-keyword run). Spends DataForSEO money.
router.use('/', createSearchDataRouter({ auth: requireAdmin, lookup: (req) => lookupSearchData(req, liveSearchDataDeps()) }));

// Plugin-facing status and session housekeeping (content-v3-plugin.handler.ts). The status check
// does not stamp the website's last connection: it is a capability probe, not a generation.
router.use('/', createContentV3PluginRouter({ auth: validateApiAccessWithoutStamp, store: getContentV3Store }));

// Keyword data (Option A/B plumbing). Auth is applied INSIDE the sub-router: prefetch is
// plugin-authenticated, everything else on it is requireAdmin.
router.use('/keyword-data', keywordDataRoutes);

// The Title and Planner steps (admin-only, like /article/test). Mounted at the root so the paths
// are /content-v3/title and /content-v3/planner; auth is applied inside the sub-router.
router.use('/', stepsRoutes);

const VALID_WORDS = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];

function parseBlueprintOverrides(raw: any): { error?: string; overrides?: BlueprintOverrides } {
  if (!raw || typeof raw !== 'object') return {};
  const ov: BlueprintOverrides = {};

  const oneOf = <T extends string>(value: unknown, allowed: T[], field: string): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      return `blueprint_overrides.${field} must be one of: ${allowed.join(', ')}`;
    }
    return undefined;
  };

  for (const [field, allowed] of [
    ['openingMove', OPENING_MOVES],
    ['accent', ACCENTS],
    ['faqPlacement', FAQ_PLACEMENTS],
    ['closeMove', CLOSE_MOVES],
  ] as const) {
    const err = oneOf(raw[field], allowed as unknown as string[], field);
    if (err) return { error: err };
    if (raw[field]) (ov as Record<string, unknown>)[field] = raw[field];
  }

  if (typeof raw.includeToc === 'boolean') ov.includeToc = raw.includeToc;

  if (raw.sectionCount !== undefined && raw.sectionCount !== null && raw.sectionCount !== '') {
    const n = Number(raw.sectionCount);
    if (!Number.isFinite(n) || n < 1 || n > 12) {
      return { error: 'blueprint_overrides.sectionCount must be a number between 1 and 12' };
    }
    ov.sectionCount = Math.round(n);
  }

  if (typeof raw.pov === 'string' && raw.pov.trim()) ov.pov = raw.pov.trim();

  return { overrides: Object.keys(ov).length ? ov : undefined };
}

interface ParseResult {
  error?: string;
  params?: GenerateV3Params;
  warnings?: string[];
}

function strOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function parseParamsV3(body: any): ParseResult {
  if (!body?.seed_keyword) return { error: 'seed_keyword is required' };
  if (!body?.niche) return { error: 'niche is required' };
  if (body.nos_of_words && !VALID_WORDS.includes(body.nos_of_words)) {
    return { error: `nos_of_words must be one of: ${VALID_WORDS.join(', ')}` };
  }

  const warnings: string[] = [];

  let articleType: ArticleType | undefined;
  if (body.article_type) {
    if (!ARTICLE_TYPES.includes(body.article_type)) {
      return { error: `article_type must be one of: ${ARTICLE_TYPES.join(', ')}` };
    }
    articleType = body.article_type;
  }

  // `brand_profile` is v2's shape. Accepting it as a deprecated alias means a copy-pasted v2 body
  // still produces a populated business block instead of a silent "(none provided)".
  const parsed = parseBusinessProfile(body.business_profile, body.brand_profile);
  warnings.push(...parsed.warnings);

  const bp = parseBlueprintOverrides(body.blueprint_overrides);
  if (bp.error) return { error: bp.error };

  const schemaArticleType =
    body.schema_article_type === 'Article' ? 'Article' : ('BlogPosting' as const);

  let servicesSelected: string[] | undefined;
  if (Array.isArray(body.services_selected)) {
    const names = body.services_selected
      .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean);
    if (names.length) servicesSelected = names;
  }

  return {
    warnings,
    params: {
      seed_keyword: String(body.seed_keyword),
      niche: String(body.niche),
      title: strOrUndefined(body.title),
      nos_of_words: body.nos_of_words || '1200 to 2400 words',
      content_lang: body.content_lang || 'English (US)',
      niche_data:
        body.niche_data && typeof body.niche_data === 'object' ? body.niche_data : undefined,
      business_profile: parsed.profile,
      article_type: articleType,
      services_selected: servicesSelected,
      call_to_action: strOrUndefined(body.call_to_action),
      cta_url: strOrUndefined(body.cta_url),
      humanize: body.humanize === false ? false : true,
      seed: strOrUndefined(body.seed),
      blueprint_overrides: bp.overrides,
      custom_instruction: sanitizeCustomInstruction(body.custom_instruction) ?? undefined,
      site_url: strOrUndefined(body.site_url),
      post_url: strOrUndefined(body.post_url),
      featured_image_url: strOrUndefined(body.featured_image_url),
      date_published: strOrUndefined(body.date_published),
      date_modified: strOrUndefined(body.date_modified),
      schema_article_type: schemaArticleType,
      // `diagnostics` is NOT read from the body — see the handler below.
    },
  };
}

/**
 * Prompt-tuning endpoint. Admin only, no credits, full diagnostics.
 *
 * Diagnostics are switched on here as a literal, and parseParamsV3 never reads the flag from the
 * request. That matters because the bundle contains the fully rendered system prompt: on a
 * credit-gated endpoint, which is reached with a site API key stored in plaintext in every
 * customer's WordPress options table, returning it would publish the prompt library to anyone
 * holding or sniffing one site's credentials.
 */
router.post('/article/test', requireAdmin, async (req: Request, res: Response) => {
  const { error, params, warnings } = parseParamsV3(req.body);
  if (error) return res.status(400).json({ success: false, error });

  try {
    const start = Date.now();
    console.log(`🧪 [v3] test generation: "${params!.seed_keyword}" (${params!.niche})`);
    const result = await generateContentV3({ ...params!, diagnostics: true });

    if (result.diagnostics && warnings?.length) {
      result.diagnostics.profile_warnings = warnings;
    }

    res.json({
      success: true,
      data: {
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_description,
        faq: result.faq,
        faq_schema: result.faq_schema,
        schema: result.schema,
        blueprint: result.blueprint,
        intelligence: result.intelligence,
        diagnostics: result.diagnostics,
      },
      metadata: {
        method: 'claude-v3',
        timings: result.timings,
        usage: result.usage,
        totalTime: Date.now() - start,
      },
    });
  } catch (e) {
    console.error('❌ [v3] test generation error:', e);
    res
      .status(500)
      .json({ success: false, error: e instanceof Error ? e.message : 'Generation failed' });
  }
});

/**
 * Register the six v3 prompt templates and seed a first active version for any that lack one.
 *
 * Idempotent and skip-only: a template with an active version is untouched, so this can never
 * clobber a prompt tuned in the panel. Safe to call from a button.
 */
router.post('/prompts/seed', requireAdmin, async (req: Request, res: Response) => {
  try {
    const mode = req.query?.mode === 'replace' || req.body?.mode === 'replace' ? 'replace' : 'skip';
    const report = await seedV3Prompts(undefined, { mode });
    const seeded = report.filter((r) => r.version === 'seeded').length;
    res.json({
      success: true,
      data: { report, seeded, total: report.length },
    });
  } catch (e) {
    console.error('❌ [v3] prompt seeding error:', e);
    res
      .status(500)
      .json({ success: false, error: e instanceof Error ? e.message : 'Seeding failed' });
  }
});

/** Back up the active value of every content_v3_* template as "pre-v3" (once). Activates nothing. */
router.post('/prompts/backup-pre-v3', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const legacy = ['content_v3_intelligence', 'content_v3_system', 'content_v3_humanize', 'content_v3_blueprint_directives', 'content_v3_seo_rules', 'content_v3_business_context'];
    const types = [...new Set([...legacy, ...v3DocPromptDefs().map((d) => d.templateType)])];
    const report = await new PromptManagementService().backupPreV3(types, 'admin-backup');
    res.json({ success: true, data: { report } });
  } catch (e) {
    console.error('❌ [v3] pre-v3 backup error:', e);
    res.status(500).json({ success: false, error: 'Backup failed' });
  }
});

/** Production gate item 2: active DB text vs the doc text, per doc-sourced prompt. Read-only. */
router.get('/prompts/check', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const report = await checkV3Prompts();
    res.json({ success: true, data: { report, all_equal: report.every((r) => r.status === 'equal') } });
  } catch (e) {
    console.error('❌ [v3] prompt check error:', e);
    res.status(500).json({ success: false, error: 'Check failed' });
  }
});

export default router;
