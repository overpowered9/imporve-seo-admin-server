/**
 * POST /api/v1/content-v3/search-data — requireAdmin. Runs the search data lookup on its own and
 * returns the merged block, the exact <search_data> XML the Title and Planner receive, and the
 * per-call meta (locations, counts, cost). For the tester panel and the 10-keyword run; it spends
 * DataForSEO money (about $0.002 per call), hence admin-only. The wizard runs the lookup inside the
 * Title route instead.
 */
import { Router, type RequestHandler, type Response, type Request } from 'express';
import { z } from 'zod';
import { searchDataBlock } from '../services/content-v3-steps/xml.js';
import type { SearchDataRequest, SearchDataResult } from '../services/search-data/search-data.service.js';
import { toV3UserError, v3ErrorBody } from '../services/content-v3/user-errors.js';

export const searchDataRequestSchema = z.object({
  seed_keyword: z.string().trim().min(1, 'seed_keyword is required').max(200),
  language: z.string().trim().max(40).optional(),
  reach: z.enum(['local', 'nationwide']).optional(),
  target_town: z.string().trim().max(120).nullable().optional(),
  not_about_location: z.boolean().optional(),
  state_hint: z.string().trim().max(40).nullable().optional(),
  town_coordinate: z.string().trim().max(60).nullable().optional(),
});

export function createSearchDataRouter(deps: {
  auth: RequestHandler;
  lookup: (req: SearchDataRequest) => Promise<SearchDataResult>;
  log?: (line: string) => void;
}): Router {
  const { log = (line) => console.error(line) } = deps;
  const router = Router();
  router.post('/search-data', deps.auth, async (req: Request, res: Response) => {
    const parsed = searchDataRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'invalid_request', message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    try {
      const r = await deps.lookup(parsed.data);
      return res.json({ success: true, data: { block: r.block, xml: r.block ? searchDataBlock(r.block) : '', meta: r.meta } });
    } catch (err) {
      log(`[search-data] admin route failed: ${err instanceof Error ? err.message : String(err)}`);
      const e = toV3UserError(err);
      return res.status(e.status).json(v3ErrorBody(e));
    }
  });
  return router;
}
