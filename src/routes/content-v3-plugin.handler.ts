/**
 * Plugin-facing Content v3 routes that are not a generation step (plugin auth: x-api-key + x-site-code).
 *
 *   GET  /api/v1/content-v3/status          { success, data: { enabled, keyword_data } }
 *        The plugin's "Use Content v3" setting only takes effect when this says enabled: true
 *        (CONTENT_V3_ENABLED). The plugin caches the answer for a few minutes and uses v2 otherwise,
 *        so turning the env flag off is the rollback.
 *
 *   POST /api/v1/content-v3/session/clear   { session_key }  →  { success, cleared }
 *        The wizard's Leave button (W10): deletes everything stored for that wizard session. Works
 *        even when v3 is switched off, so a Leave after a rollback still cleans up.
 *
 * Pure handler; content-v3.routes.ts does the live wiring.
 */
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { contentV3Enabled } from '../config/content-v3.config.js';
import { keywordDataFlagOn, keywordDataConfigured } from '../config/keyword-data.config.js';
import { SESSION_KEY_RE, type ContentV3Store } from '../services/content-v3/store.js';
import { v3Error, v3ErrorBody } from '../services/content-v3/user-errors.js';

export const sessionKeySchema = z
  .string({ required_error: 'session_key is required', invalid_type_error: 'session_key must be a string' })
  .trim()
  .regex(SESSION_KEY_RE, 'session_key is not valid');

export interface ContentV3PluginDeps {
  auth: RequestHandler;
  store: () => Promise<ContentV3Store>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export function createContentV3PluginRouter(deps: ContentV3PluginDeps): Router {
  const { env = process.env, log = (line) => console.log(line) } = deps;
  const router = Router();

  router.get('/status', deps.auth, (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: {
        enabled: contentV3Enabled(env),
        keyword_data: keywordDataFlagOn(env) && keywordDataConfigured(env),
      },
    });
  });

  router.post('/session/clear', deps.auth, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = z.object({ session_key: sessionKeySchema }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', 'The wizard session could not be identified.')));
    }
    const userId = Number(req.user?.id);
    const websiteId = Number(req.website?.id);
    const store = await deps.store();
    const cleared = await store.deleteSession(userId, websiteId, parsed.data.session_key);
    log(`[content-v3] session cleared user=${userId} website=${websiteId} ok=${cleared}`);
    return res.json({ success: true, cleared });
  });

  return router;
}
