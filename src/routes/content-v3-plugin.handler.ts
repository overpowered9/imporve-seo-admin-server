/**
 * Plugin-facing Content v3 routes that are not a generation step (plugin auth: x-api-key + x-site-code).
 *
 *   GET  /api/v1/content-v3/status          { success, data: { enabled, keyword_data, disclaimer_niches } }
 *        disclaimer_niches (A3): niche/profile keys with a disclaimer text; a Regulated business
 *        whose niche is not listed stays on v2.
 *        The plugin's "Use Content v3" setting only takes effect when this says enabled: true
 *        (CONTENT_V3_ENABLED). The plugin caches the answer for a few minutes and uses v2 otherwise,
 *        so turning the env flag off is the rollback.
 *
 *   POST /api/v1/content-v3/session/clear   { session_key, left? }  →  { success, cleared }
 *        Submit and the wizard's Leave button (W10) both end the wizard session and delete what
 *        was stored for it. On Leave (`left: true`) the unsubmitted post goes too: its post history
 *        row (so it does not shape later blueprints) and the article text of its generation rows
 *        (the rows and what was billed stay). Works even when v3 is switched off, so a Leave after
 *        a rollback still cleans up.
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
  /** A3: niche and profile keys with a disclaimer text (a Regulated business needs one for v3). */
  disclaimerKeys?: () => Promise<string[]>;
  /** Leave: blanks the article text of this session's content_v3 generation rows; returns how many. */
  forgetArticles?: (userId: number, sessionKey: string) => Promise<number>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export function createContentV3PluginRouter(deps: ContentV3PluginDeps): Router {
  const { env = process.env, log = (line) => console.log(line) } = deps;
  const router = Router();

  router.get('/status', deps.auth, async (_req: AuthenticatedRequest, res: Response) => {
    // A3: unreadable disclaimer settings answer an empty list, which keeps Regulated businesses on v2.
    const disclaimerNiches = deps.disclaimerKeys ? await deps.disclaimerKeys().catch(() => [] as string[]) : [];
    res.json({
      success: true,
      data: {
        enabled: contentV3Enabled(env),
        keyword_data: keywordDataFlagOn(env) && keywordDataConfigured(env),
        disclaimer_niches: disclaimerNiches,
      },
    });
  });

  router.post('/session/clear', deps.auth, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = z.object({ session_key: sessionKeySchema, left: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', 'The wizard session could not be identified.')));
    }
    const userId = Number(req.user?.id);
    const websiteId = Number(req.website?.id);
    const key = parsed.data.session_key;
    const store = await deps.store();
    const cleared = await store.deleteSession(userId, websiteId, key);
    let left = '';
    if (parsed.data.left) {
      const posts = await store.deletePosts(userId, websiteId, key);
      const blanked = deps.forgetArticles ? await deps.forgetArticles(userId, key).catch(() => -1) : 0;
      left = ` left=1 post_rows=${posts ? 'deleted' : 'kept'} articles_blanked=${blanked}`;
    }
    log(`[content-v3] session cleared run=${key} user=${userId} website=${websiteId} ok=${cleared}${left}`);
    return res.json({ success: true, cleared });
  });

  return router;
}
