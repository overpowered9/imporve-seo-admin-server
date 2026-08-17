/**
 * Content Generation v2 — Claude route (additive, parallel to /generate/active).
 *
 *   POST /api/v1/content-v2/article/test   — no auth/credit. Admin-panel custom-input testing.
 *   POST /api/v1/content-v2/article        — credit-gated production endpoint.
 *   POST /api/v1/content-v2/image/test     — no auth/credit. OpenAI image testing (synchronous).
 *   POST /api/v1/content-v2/image          — credit-gated OpenAI image endpoint.
 *
 * The image endpoints use OpenAI (openai-image.service) and are fully isolated from the existing Flux
 * path (/generate/generateimage) the plugin still uses — nothing here touches that flow.
 *
 * See docs/content-v2-plan.md.
 */

import { Router, Request, Response } from 'express';
import { generateContentV2, GenerateV2Params } from '../services/claude-content-generator.service.js';
import {
  generateOpenAiImage,
  uploadImageToSupabase,
  ImageGenError,
  GenerateImageParams,
  ImageSize,
  ImageQuality,
  ImageStyle,
} from '../services/openai-image.service.js';
import { validateApiAccess, validateCredits, AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import { deductCredits } from '../models/user.models.js';
import sql from '../data/db.js';

const router = Router();

const VALID_WORDS = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];
const VALID_SIZES: ImageSize[] = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const VALID_QUALITIES: ImageQuality[] = ['low', 'medium', 'high', 'auto'];

function parseImageParams(body: any): { error?: string; params?: GenerateImageParams } {
  const hasSource = body?.prompt || body?.title || body?.niche;
  if (!hasSource) return { error: 'Provide at least one of: prompt, title, or niche' };
  if (body.size && !VALID_SIZES.includes(body.size)) {
    return { error: `size must be one of: ${VALID_SIZES.join(', ')}` };
  }
  if (body.quality && !VALID_QUALITIES.includes(body.quality)) {
    return { error: `quality must be one of: ${VALID_QUALITIES.join(', ')}` };
  }
  return {
    params: {
      prompt: body.prompt ? String(body.prompt) : undefined,
      niche: body.niche ? String(body.niche) : undefined,
      title: body.title ? String(body.title) : undefined,
      city: body.city ? String(body.city) : undefined,
      state: body.state ? String(body.state) : undefined,
      size: body.size as ImageSize | undefined,
      quality: body.quality as ImageQuality | undefined,
      style: (body.style === 'illustration' ? 'illustration' : 'documentary') as ImageStyle,
    },
  };
}

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

/**
 * Testing endpoint — admin-only, no credit. Returns full diagnostics for the admin panel.
 *
 * SECURITY: this was previously open to the internet with no auth and no credit check, while every
 * call spends real Anthropic money. It is now behind requireAdmin. It still charges no credits,
 * which is the point of a test route — the protection is that only admins can reach it.
 */
router.post('/article/test', requireAdmin, async (req: Request, res: Response) => {
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

// ---------------- IMAGE (OpenAI, synchronous) ----------------

/**
 * Image testing endpoint — admin-only, no credit. Returns a data URI for the admin panel.
 * Same reasoning as /article/test above: previously unauthenticated while spending real OpenAI money.
 */
router.post('/image/test', requireAdmin, async (req: Request, res: Response) => {
  const { error, params } = parseImageParams(req.body);
  if (error) return res.status(400).json({ success: false, error });

  try {
    const start = Date.now();
    console.log(`🖼️  [v2] test image: niche="${params!.niche || '-'}" title="${(params!.title || '').slice(0, 60)}"`);
    const img = await generateOpenAiImage(params!);
    res.json({
      success: true,
      data: {
        data_uri: img.dataUri,
        prompt_used: img.promptUsed,
        size: img.size,
        model: img.model,
        format: img.format,
      },
      metadata: { method: 'openai-image', totalTime: Date.now() - start, usage: img.usage },
    });
  } catch (e) {
    const status = e instanceof ImageGenError ? e.status : 500;
    const code = e instanceof ImageGenError ? e.code : 'unknown';
    console.error(`❌ [v2] test image error (${code}):`, e instanceof Error ? e.message : e);
    res.status(status).json({ success: false, error: e instanceof Error ? e.message : 'Image generation failed', code });
  }
});

/** Production image endpoint — auth + 1 image credit. Hosts to Supabase if configured, deducts on success. */
router.post('/image', validateApiAccess, validateCredits('images', 1), async (req: AuthenticatedRequest, res: Response) => {
  const { error, params } = parseImageParams(req.body);
  if (error) return res.status(400).json({ success: false, error });

  try {
    const start = Date.now();
    const img = await generateOpenAiImage(params!);
    const hostedUrl = await uploadImageToSupabase(img.b64); // best-effort; null if not configured
    const processingTime = Date.now() - start;

    const userId = req.user.id;
    const websiteId = req.website?.id || null;

    const generationRecord = await sql`
      INSERT INTO user_generations (user_id, website_id, type, status, parameters, result, metadata, processing_time_ms)
      VALUES (
        ${userId}, ${websiteId}, 'image_v2', 'success',
        ${JSON.stringify({ niche: params!.niche, title: params!.title, size: img.size, quality: params!.quality || 'medium', style: params!.style })},
        ${JSON.stringify({ image_url: hostedUrl, prompt_used: img.promptUsed })},
        ${JSON.stringify({ method: 'openai-image', model: img.model, hosted: !!hostedUrl })},
        ${processingTime}
      )
      RETURNING id
    `;
    const generationId = generationRecord[0].id;

    await deductCredits(
      userId,
      'images',
      1,
      `Image v2: ${(params!.title || params!.niche || 'image').substring(0, 200)}`,
      websiteId,
      generationId
    );

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        image_url: hostedUrl,          // null if hosting not configured — fall back to data_uri
        data_uri: img.dataUri,
        prompt_used: img.promptUsed,
        size: img.size,
        model: img.model,
      },
      metadata: { method: 'openai-image', processingTime, hosted: !!hostedUrl },
    });
  } catch (e) {
    const status = e instanceof ImageGenError ? e.status : 500;
    const code = e instanceof ImageGenError ? e.code : 'unknown';
    console.error(`❌ [v2] production image error (${code}):`, e instanceof Error ? e.message : e);
    res.status(status).json({ success: false, error: e instanceof Error ? e.message : 'Image generation failed', code });
  }
});

export default router;
