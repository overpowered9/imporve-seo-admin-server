/**
 * Live wiring for the rank tracker admin API (handler: rank-tracker.handler.ts).
 *
 * Mounted from v1.ts at /api/v1/rank-tracker. Admin-only, like the Keyword Finder: these routes
 * spend DataForSEO money and read a table only the server owns.
 */
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import { getRankTracker } from '../services/keyword-data/rank-tracker.default.js';
import { isKeywordFinderConfigured } from '../services/keyword-data/keyword-finder.default.js';
import { createRankTrackerRouter } from './rank-tracker.handler.js';

const router = createRankTrackerRouter({
  auth: requireAdmin,
  tracker: getRankTracker,
  configured: isKeywordFinderConfigured,
});

export default router;
