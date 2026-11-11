/**
 * POST /api/v1/content-v3/title and POST /api/v1/content-v3/planner — the Content v3 Title and
 * Planner steps as routes. Admin-only like the rest of v3 (decided 2026-11-11), no credits.
 *
 * Request bodies follow the design doc's data contract for each prompt, plus the keyword data
 * contract's optional fields:
 *   use_keyword_data?: boolean            (default false; a string "true" is rejected)
 *   recent_posts?: [{ post_id, title, seed_keyword? }]   (max 20; Planner only)
 *   location_code?, language_code?        (defaults 2840 / en, applied by the keyword data service)
 *
 * zod strips unknown keys, so a client cannot smuggle keyword numbers (or anything else) into the
 * prompt: the only keyword data a step ever sees comes from the server.
 *
 * Response: { success: true, data: <step output>, metadata: { attempts, usage, timings,
 * keyword_data, prompt, recent_posts?, messages } }. The Planner's data always carries
 * demand_notes and overlap (null with V1). `messages` holds the exact prompts sent — acceptable
 * here because the route is admin-only; a future plugin-facing route must drop it.
 *
 * Pure handler; content-v3-steps.routes.ts does the live wiring.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { StepFailedError } from '../services/content-v3-steps/attempts.js';
import type { PlannerStepInput, PlannerStepResult } from '../services/content-v3-steps/planner.step.js';
import type { TitleStepInput, TitleStepResult } from '../services/content-v3-steps/title.step.js';
import { RECENT_POSTS_MAX_INPUT } from '../services/content-v3-steps/recent-posts.js';
import { validationErrorBody } from './keyword-metrics.handler.js';

const optStr = (max: number) => z.string().trim().max(max).optional();

export const scopedItemSchema = z
  .union([
    z.string().trim().min(1).max(300),
    z.object({ text: z.string().trim().min(1).max(300), scope: z.enum(['local', 'national']).optional() }),
  ])
  .transform((v) => (typeof v === 'string' ? { text: v, scope: 'local' as const } : { text: v.text, scope: v.scope ?? ('local' as const) }));

export const searchDataSchema = z
  .object({
    location: optStr(200),
    national_fallback: z.boolean().optional(),
    ranking_titles: z.array(scopedItemSchema).max(20).optional(),
    people_also_ask: z.array(scopedItemSchema).max(20).optional(),
    related_searches: z.array(scopedItemSchema).max(20).optional(),
  })
  .optional();

const sourceIds = z.array(z.number().int()).max(20).optional();

export const researchSchema = z
  .object({
    facts: z
      .array(
        z.object({
          claim: z.string().trim().min(1).max(500),
          scope: z.enum(['local', 'state', 'national', 'general']).optional(),
          source_ids: sourceIds,
          conflict: z.boolean().optional(),
        }),
      )
      .max(30)
      .optional(),
    follow_up_questions: z.array(z.object({ question: z.string().trim().min(1).max(300), source_ids: sourceIds })).max(20).optional(),
    local_conditions: z.array(z.object({ claim: z.string().trim().min(1).max(500), source_ids: sourceIds })).max(10).optional(),
    notes: optStr(1000),
  })
  .optional();

const keywordDataFields = {
  use_keyword_data: z.boolean({ invalid_type_error: 'use_keyword_data must be a boolean' }).optional(),
  location_code: z.number().int().positive().optional(),
  language_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'language_code must be a two-letter code such as "en"')
    .transform((s) => s.toLowerCase())
    .optional(),
};

const businessFields = {
  language: optStr(60),
  niche: optStr(200),
  reach: optStr(40),
  proof_level: optStr(40),
  ideal_client: optStr(500),
  target_town: optStr(120),
  featured_service: optStr(200),
};

export const titleRequestSchema = z.object({
  seed_keyword: z.string({ required_error: 'seed_keyword is required' }).trim().min(1, 'seed_keyword is required').max(200),
  ...businessFields,
  search_data: searchDataSchema,
  max_list_items: z.number().int().min(1).max(30).optional(),
  previous_titles: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  ...keywordDataFields,
});

export const recentPostSchema = z.object({
  post_id: z.number({ invalid_type_error: 'recent_posts[].post_id must be a number' }).int().positive(),
  title: z.string().trim().min(1).max(300),
  seed_keyword: optStr(200),
});

export const plannerRequestSchema = z.object({
  title: z.string({ required_error: 'title is required' }).trim().min(1, 'title is required').max(200),
  seed_keyword: z.string({ required_error: 'seed_keyword is required' }).trim().min(1, 'seed_keyword is required').max(200),
  ...businessFields,
  business_description: optStr(2000),
  search_data: searchDataSchema,
  research: researchSchema,
  size_options: z.object({ small: optStr(60), medium: optStr(60), large: optStr(60) }).partial().optional(),
  minimum_size: z.enum(['small', 'medium', 'large']).optional(),
  recent_posts: z.array(recentPostSchema).max(RECENT_POSTS_MAX_INPUT, `recent_posts must contain at most ${RECENT_POSTS_MAX_INPUT} posts`).optional(),
  ...keywordDataFields,
});

export type TitleRequest = z.infer<typeof titleRequestSchema>;
export type PlannerRequest = z.infer<typeof plannerRequestSchema>;

export interface ContentV3StepsDeps {
  auth: RequestHandler;
  runTitle: (input: TitleStepInput) => Promise<TitleStepResult>;
  runPlanner: (input: PlannerStepInput) => Promise<PlannerStepResult>;
  log?: (line: string) => void;
}

function stepFailure(res: Response, step: string, err: unknown, log: (line: string) => void) {
  if (err instanceof StepFailedError) {
    log(`[v3-step] ${step} gave up: ${err.message}`);
    return res.status(502).json({ success: false, error: err.message, code: 'STEP_FAILED', attempts: err.attempts });
  }
  log(`[v3-step] ${step} error: ${err instanceof Error ? err.message : String(err)}`);
  return res.status(500).json({ success: false, error: err instanceof Error ? err.message : `${step} failed` });
}

export function createContentV3StepsRouter(deps: ContentV3StepsDeps): Router {
  const { log = (line) => console.log(line) } = deps;
  const router = Router();

  router.post('/title', deps.auth, async (req: Request, res: Response) => {
    const parsed = titleRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(validationErrorBody(parsed.error));
    try {
      const r = await deps.runTitle(parsed.data);
      log(
        `[v3-step] title seed="${parsed.data.seed_keyword}" attempts=${r.attempts.length} prompt=${r.prompt.version}/${r.prompt.source} ` +
          `keyword_data=${r.keyword_data.used ? 'used' : r.keyword_data.effective ? 'fallback' : 'off'} ms=${r.timings.total_ms}`,
      );
      return res.json({
        success: true,
        data: r.output,
        metadata: { attempts: r.attempts, usage: r.usage, timings: r.timings, keyword_data: r.keyword_data, prompt: r.prompt, messages: r.messages },
      });
    } catch (err) {
      return stepFailure(res, 'title', err, log);
    }
  });

  router.post('/planner', deps.auth, async (req: Request, res: Response) => {
    const parsed = plannerRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(validationErrorBody(parsed.error));
    try {
      const r = await deps.runPlanner(parsed.data);
      log(
        `[v3-step] planner seed="${parsed.data.seed_keyword}" attempts=${r.attempts.length} prompt=${r.prompt.version}/${r.prompt.source} ` +
          `keyword_data=${r.keyword_data.used ? 'used' : r.keyword_data.effective ? 'fallback' : 'off'} recent_posts=${r.recent_posts.sent.length}/${r.recent_posts.received} ms=${r.timings.total_ms}`,
      );
      return res.json({
        success: true,
        data: r.output,
        metadata: {
          attempts: r.attempts,
          usage: r.usage,
          timings: r.timings,
          keyword_data: r.keyword_data,
          prompt: r.prompt,
          recent_posts: r.recent_posts,
          messages: r.messages,
        },
      });
    } catch (err) {
      return stepFailure(res, 'planner', err, log);
    }
  });

  return router;
}
