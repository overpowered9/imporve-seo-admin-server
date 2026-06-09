/**
 * Content Generation v2 — Claude route (additive, parallel to /generate/active).
 *
 *   POST /api/v1/content-v2/article/test   — no auth/credit. Admin-panel custom-input testing.
 *   POST /api/v1/content-v2/article        — credit-gated production endpoint.
 *
 * See docs/content-v2-plan.md.
 */

import { Router, Request, Response } from 'express';
import { generateContentV2, GenerateV2Params } from '../services/claude-content-generator.service.js';
import { validateApiAccess, validateCredits, AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { deductCredits } from '../models/user.models.js';
import sql from '../data/db.js';

const router = Router();

const VALID_WORDS = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];

function parseParams(body: any): { error?: string; params?: GenerateV2Params } {
  if (!body?.seed_keyword) return { error: 'seed_keyword is required' };
  if (!body?.niche) return { error: 'niche is required' };
  if (body.nos_of_words && !VALID_WORDS.includes(body.nos_of_words)) {
    return { error: `nos_of_words must be one of: ${VALID_WORDS.join(', ')}` };
  }
  return {
    params: {
      seed_keyword: String(body.seed_keyword),
      niche: String(body.niche),
      title: body.title ? String(body.title) : undefined,
      nos_of_words: body.nos_of_words || '1200 to 2400 words',
      content_lang: body.content_lang || 'English (US)',
      niche_data: body.niche_data && typeof body.niche_data === 'object' ? body.niche_data : undefined,
      brand_profile: body.brand_profile && typeof body.brand_profile === 'object' ? body.brand_profile : undefined,
      call_to_action: body.call_to_action ? String(body.call_to_action) : undefined,
      cta_url: body.cta_url ? String(body.cta_url) : undefined,
      humanize: body.humanize === false ? false : true,
      seed: body.seed ? String(body.seed) : undefined,
    },
  };
}

/** Testing endpoint — no auth, no credit. Returns full diagnostics for the admin panel. */
router.post('/article/test', async (req: Request, res: Response) => {
  const { error, params } = parseParams(req.body);
  if (error) return res.status(400).json({ success: false, error });

  try {
    const start = Date.now();
    console.log(`🧪 [v2] test generation: "${params!.seed_keyword}" (${params!.niche})`);
    const result = await generateContentV2(params!);
    res.json({
      success: true,
      data: {
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_description,
        faq: result.faq,
        faq_schema: result.faq_schema,
        blueprint: result.blueprint,
        intelligence: result.intelligence,
      },
      metadata: {
        method: 'claude-v2',
        timings: result.timings,
        usage: result.usage,
        totalTime: Date.now() - start,
      },
    });
  } catch (e) {
    console.error('❌ [v2] test generation error:', e);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Generation failed' });
  }
});

/** Production endpoint — auth + 1 content credit, saves the generation and deducts. */
router.post('/article', validateApiAccess, validateCredits('content', 1), async (req: AuthenticatedRequest, res: Response) => {
  const { error, params } = parseParams(req.body);
  if (error) return res.status(400).json({ success: false, error });

  try {
    const start = Date.now();
    const result = await generateContentV2(params!);
    const processingTime = Date.now() - start;

    const userId = req.user.id;
    const websiteId = req.website?.id || null;

    const generationRecord = await sql`
      INSERT INTO user_generations (user_id, website_id, type, status, parameters, result, metadata, processing_time_ms)
      VALUES (
        ${userId}, ${websiteId}, 'content_v2', 'success',
        ${JSON.stringify({
          seed_keyword: params!.seed_keyword,
          niche: params!.niche,
          nos_of_words: params!.nos_of_words,
          content_lang: params!.content_lang,
          title: params!.title,
        })},
        ${JSON.stringify({
          content: result.content,
          meta_title: result.meta_title,
          meta_description: result.meta_description,
          faq: result.faq,
          faq_schema: result.faq_schema,
        })},
        ${JSON.stringify({ method: 'claude-v2', model: process.env.ANTHROPIC_MODEL, blueprintSeed: result.blueprint.seed })},
        ${processingTime}
      )
      RETURNING id
    `;
    const generationId = generationRecord[0].id;

    await deductCredits(
      userId,
      'content',
      1,
      `Content v2: ${params!.seed_keyword.substring(0, 200)}`,
      websiteId,
      generationId
    );

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_description,
        faq: result.faq,
        faq_schema: result.faq_schema,
      },
      metadata: { method: 'claude-v2', processingTime, blueprintSeed: result.blueprint.seed },
    });
  } catch (e) {
    console.error('❌ [v2] production generation error:', e);
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Generation failed' });
  }
});

export default router;
