/**
 * Live wiring for POST /api/v1/generate/keywords/metrics (handler: keyword-metrics.handler.ts).
 *
 * Mounted from generation.routes.ts under '/keywords', so the path sits beside the existing
 * keyword endpoint (/generate/generatekeyword) and uses the same plugin auth: x-api-key +
 * x-site-code (validateApiAccess). Rate-limited per account, with its own bucket namespace so it
 * neither counts nor is counted by /generate/auxiliary.
 */
import { validateApiAccess } from '../middleware/apiAuth.middleware.js';
import { rateLimitPerUser } from '../middleware/rateLimit.middleware.js';
import { reserveCredits, refundCredits, getLiveBalance, ISEO_CREDIT_TYPE } from '../models/user.models.js';
import { KEYWORD_DATA_DEFAULTS, KEYWORD_METRICS_CREDIT_COST } from '../config/keyword-data.config.js';
import { getKeywordDataService } from '../services/keyword-data/keyword-data.default.js';
import { createKeywordMetricsRouter } from './keyword-metrics.handler.js';

export const keywordMetricsRateLimit = rateLimitPerUser({
  limit: KEYWORD_DATA_DEFAULTS.metricsRateLimitPerMinute,
  windowMs: 60_000,
  keyPrefix: 'keyword-metrics',
  message: 'Too many keyword metrics requests. Please wait a moment and try again.',
});

const router = createKeywordMetricsRouter({
  service: getKeywordDataService,
  auth: validateApiAccess,
  rateLimit: keywordMetricsRateLimit,
  creditCost: () => KEYWORD_METRICS_CREDIT_COST,
  reserveCredits: (userId, amount, reason, websiteId) => reserveCredits(userId, ISEO_CREDIT_TYPE, amount, reason, websiteId),
  refundCredits: (userId, amount, reason, websiteId) => refundCredits(userId, ISEO_CREDIT_TYPE, amount, reason, websiteId),
  liveBalance: async (userId) => (await getLiveBalance(userId)).total,
});

export default router;
