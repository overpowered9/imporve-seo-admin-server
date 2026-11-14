/**
 * Live wiring for the v3 keyword-data routes, mounted from content-v3.routes.ts under
 * '/keyword-data':
 *
 *   POST /api/v1/content-v3/keyword-data/prefetch   plugin auth (x-api-key + x-site-code)
 *   POST /api/v1/content-v3/keyword-data/ab-test    requireAdmin (A/B harness, spends money)
 *
 * See content-v3-keyword-data.handler.ts for the prefetch contract and why it is plugin-facing,
 * and content-v3-ab.handler.ts for the harness.
 */
import { Router } from 'express';
import { validateApiAccess } from '../middleware/apiAuth.middleware.js';
import { rateLimitPerUser } from '../middleware/rateLimit.middleware.js';
import { KEYWORD_DATA_DEFAULTS, keywordDataFlagOn } from '../config/keyword-data.config.js';
import { contentV3Enabled } from '../config/content-v3.config.js';
import { getKeywordDataService } from '../services/keyword-data/keyword-data.default.js';
import { createKeywordDataPrefetchRouter } from './content-v3-keyword-data.handler.js';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import { runLiveKeywordDataAbTest } from '../services/ab-harness/keyword-data-ab.default.js';
import { createKeywordDataAbRouter } from './content-v3-ab.handler.js';

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
    // B-5: no DataForSEO spend while v3 or Option B is off (only v3 steps use the cache).
    enabled: () => contentV3Enabled() && keywordDataFlagOn(),
  }),
);

router.use(
  '/',
  createKeywordDataAbRouter({
    auth: requireAdmin,
    run: (input, options) => runLiveKeywordDataAbTest(input, options),
  }),
);

export default router;
