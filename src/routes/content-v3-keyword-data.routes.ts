/**
 * Live wiring for the v3 keyword-data routes, mounted from content-v3.routes.ts under
 * '/keyword-data':
 *
 *   POST /api/v1/content-v3/keyword-data/prefetch   plugin auth (x-api-key + x-site-code)
 *
 * See content-v3-keyword-data.handler.ts for the contract and why prefetch is plugin-facing.
 */
import { Router } from 'express';
import { validateApiAccess } from '../middleware/apiAuth.middleware.js';
import { rateLimitPerUser } from '../middleware/rateLimit.middleware.js';
import { KEYWORD_DATA_DEFAULTS } from '../config/keyword-data.config.js';
import { getKeywordDataService } from '../services/keyword-data/keyword-data.default.js';
import { createKeywordDataPrefetchRouter } from './content-v3-keyword-data.handler.js';

export const keywordDataPrefetchRateLimit = rateLimitPerUser({
  limit: KEYWORD_DATA_DEFAULTS.prefetchRateLimitPerMinute,
  windowMs: 60_000,
  keyPrefix: 'keyword-data-prefetch',
  message: 'Too many keyword data requests. Please wait a moment and try again.',
});

const router = Router();

router.use(
  '/',
  createKeywordDataPrefetchRouter({
    service: getKeywordDataService,
    auth: validateApiAccess,
    rateLimit: keywordDataPrefetchRateLimit,
  }),
);

export default router;
