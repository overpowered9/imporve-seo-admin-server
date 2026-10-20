/**
 * Content Generation v3 — Claude route (additive; v2 is untouched).
 *
 *   POST /api/v1/content-v3/article/test   — requireAdmin, no credits. The prompt-tuning endpoint.
 *   POST /api/v1/content-v3/prompts/seed   — requireAdmin. Registers the six v3 templates.
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

const router = Router();

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
router.post('/prompts/seed', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const report = await seedV3Prompts();
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

export default router;
