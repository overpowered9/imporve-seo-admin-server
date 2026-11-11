/**
 * POST /api/v1/content-v3/keyword-data/ab-test — admin-only A/B harness (keyword data OFF vs ON).
 *
 * Body: { keywords: string[] (1..10), location_code?, language_code?, business?: {...}, fixtures?:
 * { [keyword]: { search_data?, research? } }, save?: boolean = true }
 *
 * Runs Title and Planner for every keyword with keyword data off and then on, and answers the full
 * result; with save (default) it also writes <run_id>.json and <run_id>.csv under data/ab-tests/.
 * Admin-only: it spends model and DataForSEO money and returns the prompts that ran.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { AB_MAX_KEYWORDS, type AbRunInput, type AbRunResult } from '../services/ab-harness/keyword-data-ab.js';
import { RECENT_POSTS_MAX_INPUT } from '../services/content-v3-steps/recent-posts.js';
import { validationErrorBody } from './keyword-metrics.handler.js';
import { recentPostSchema, researchSchema, searchDataSchema } from './content-v3-steps.handler.js';

const optStr = (max: number) => z.string().trim().max(max).optional();

export const abRequestSchema = z.object({
  keywords: z
    .array(z.string({ invalid_type_error: 'each keyword must be a string' }).trim().min(1, 'a keyword must not be empty').max(200), {
      required_error: 'keywords is required',
      invalid_type_error: 'keywords must be an array of strings',
    })
    .min(1, 'keywords must contain at least 1 keyword')
    .max(AB_MAX_KEYWORDS, `keywords must contain at most ${AB_MAX_KEYWORDS} keywords`),
  location_code: z.number().int().positive().optional(),
  language_code: z.string().trim().regex(/^[A-Za-z]{2}$/, 'language_code must be a two-letter code such as "en"').transform((s) => s.toLowerCase()).optional(),
  business: z
    .object({
      language: optStr(60),
      niche: optStr(200),
      reach: optStr(40),
      proof_level: optStr(40),
      ideal_client: optStr(500),
      target_town: optStr(120),
      featured_service: optStr(200),
      business_description: optStr(2000),
      max_list_items: z.number().int().min(1).max(30).optional(),
      minimum_size: z.enum(['small', 'medium', 'large']).optional(),
      size_options: z.object({ small: optStr(60), medium: optStr(60), large: optStr(60) }).partial().optional(),
      recent_posts: z.array(recentPostSchema).max(RECENT_POSTS_MAX_INPUT).optional(),
    })
    .optional(),
  fixtures: z.record(z.string(), z.object({ search_data: searchDataSchema, research: researchSchema })).optional(),
  save: z.boolean().optional(),
});

export interface AbHandlerDeps {
  auth: RequestHandler;
  run: (input: AbRunInput, options: { save?: boolean }) => Promise<AbRunResult>;
  log?: (line: string) => void;
}

export function createKeywordDataAbRouter(deps: AbHandlerDeps): Router {
  const { log = (line) => console.log(line) } = deps;
  const router = Router();

  router.post('/ab-test', deps.auth, async (req: Request, res: Response) => {
    const parsed = abRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(validationErrorBody(parsed.error));
    const { save, ...input } = parsed.data;
    const started = Date.now();
    try {
      const result = await deps.run(input, { save });
      log(`[ab] run=${result.run_id} keywords=${result.keywords.length} dataforseo_cost_usd=${result.totals.dataforseo_cost_usd} ms=${Date.now() - started}`);
      return res.json({ success: true, data: result });
    } catch (err) {
      log(`[ab] failed: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'A/B run failed' });
    }
  });

  return router;
}
