/**
 * Live wiring for the Keyword Finder admin API (handler: keyword-finder.handler.ts).
 *
 *   GET  /api/v1/keyword-finder/locations   requireAdmin
 *   POST /api/v1/keyword-finder/discover    requireAdmin
 *
 * Mounted from v1.ts. Admin-only: this is the panel where the tool is proven and its thresholds
 * tuned before anything is exposed to plugin sites.
 */
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import {
  getGeoService,
  getKeywordFinderService,
  isKeywordFinderConfigured,
} from '../services/keyword-data/keyword-finder.default.js';
import { createKeywordFinderRouter } from './keyword-finder.handler.js';

const router = createKeywordFinderRouter({
  auth: requireAdmin,
  finder: getKeywordFinderService,
  geo: getGeoService,
  configured: isKeywordFinderConfigured,
});

export default router;
