/**
 * POST /api/v1/content-v3/keyword-data/prefetch — warm the keyword cache for one seed.
 *
 * Contract:
 *   Request   { keyword: string, location_code?: number, language_code?: string }
 *   Response  { success: true, status: "ready" | "unavailable", seed: <item> | null, related_count: number }
 *
 * The plugin calls this as soon as a keyword is typed, so that by the time Title and Planner run
 * (with use_keyword_data: true) the seed and its related keywords are already cached and add no
 * wait. It is therefore plugin-authenticated (decided 2026-11-11) — the one route on the v3 router
 * that is not admin-only — and rate-limited per account.
 *
 * It never fails the caller for a provider problem: a timeout, a provider error or missing
 * credentials all answer 200 with status "unavailable" (and a `reason`), exactly the condition the
 * Title/Planner steps fall back on. The fetch runs under the same 8 s budget those steps use; a
 * late answer still fills the cache (see keyword-data.service.ts).
 *
 * Pure handler; content-v3-keyword-data.routes.ts does the live wiring.
 */
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { KEYWORD_DATA_DEFAULTS } from '../config/keyword-data.config.js';
import type { KeywordDataService } from '../services/keyword-data/keyword-data.service.js';
import { languageCodeSchema, locationCodeSchema, validationErrorBody } from './keyword-metrics.handler.js';

export const prefetchRequestSchema = z.object({
  keyword: z
    .string({ required_error: 'keyword is required', invalid_type_error: 'keyword must be a string' })
    .trim()
    .min(1, 'keyword must not be empty')
    .max(200, 'keyword must be at most 200 characters'),
  location_code: locationCodeSchema,
  language_code: languageCodeSchema,
});

export interface KeywordDataPrefetchDeps {
  service: () => KeywordDataService;
  auth: RequestHandler;
  rateLimit: RequestHandler;
  budgetMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export function createKeywordDataPrefetchRouter(deps: KeywordDataPrefetchDeps): Router {
  const { log = (line) => console.log(line), now = () => Date.now(), budgetMs = KEYWORD_DATA_DEFAULTS.fetchBudgetMs } = deps;
  const router = Router();

  router.post('/prefetch', deps.auth, deps.rateLimit, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = prefetchRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(validationErrorBody(parsed.error));

    const { keyword, location_code, language_code } = parsed.data;
    const userId = req.user?.id ?? '-';
    const started = now();
    try {
      const r = await deps.service().getSeedWithRelated(keyword, location_code, language_code, { budgetMs });
      log(
        `[keyword-data] prefetch user=${userId} seed="${keyword}" status=${r.status} source=${r.source} ` +
          `related=${r.related.length} cost_usd=${r.cost_usd}${r.reason ? ` reason=${r.reason}` : ''} ms=${now() - started}`,
      );
      return res.json({
        success: true,
        status: r.status,
        seed: r.seed,
        related_count: r.related.length,
        ...(r.reason ? { reason: r.reason } : {}),
      });
    } catch (err) {
      log(`[keyword-data] prefetch user=${userId} seed="${keyword}" threw: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ success: false, error: 'Keyword data prefetch failed' });
    }
  });

  return router;
}
