/**
 * The single wizard's Content v3 steps, plugin-authenticated (x-api-key + x-site-code).
 *
 *   POST /api/v1/content-v3/wizard/title        Generate / Regenerate title (W2, W12, W15, T1–T9)
 *     search data lookup (session-cached) → PROMPT 1 · Title. Only the title goes back to the user;
 *     form, items, main_concern and page_kind are logged and kept in the session for the Planner.
 *     On Regenerate the titles already shown in this session for this keyword are sent as
 *     <previous_titles>. After 3 failed attempts the answer is 200 with title "" and failed: true,
 *     so the title box is left empty for the user to type (T6).
 *   POST /api/v1/content-v3/wizard/town-check   W6: does the keyword name another town than the
 *     chosen Target town? Free (DataForSEO's locations list costs nothing).
 *
 * Both answer 409 v3_disabled while CONTENT_V3_ENABLED is off, so a plugin that thinks v3 is on
 * (stale status cache) falls back to v2. Title generation is free (billing decision, 14 Nov) and
 * rate-limited per account. Errors are plain sentences (user-errors.ts).
 *
 * Pure handler with injected dependencies; content-v3.routes.ts does the live wiring.
 */
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { contentV3Enabled } from '../config/content-v3.config.js';
import { StepFailedError } from '../services/content-v3-steps/attempts.js';
import type { TitleStepInput, TitleStepResult } from '../services/content-v3-steps/title.step.js';
import type { ContentV3Store } from '../services/content-v3/store.js';
import { toV3UserError, v3Error, v3ErrorBody } from '../services/content-v3/user-errors.js';
import { sessionKeySchema } from './content-v3-plugin.handler.js';
import type { SearchDataRequest } from '../services/search-data/search-data.service.js';
import type { CachedSearchData } from '../services/search-data/search-data.default.js';
import type { LocationIndexProvider } from '../services/search-data/locations.js';
import { detectTownInKeyword, parseTown } from '../services/search-data/towns.js';
import { isLocalPost } from '../services/search-data/search-data.service.js';

/** The doc: <max_list_items> is what the largest size can hold, never more than 15. */
export const MAX_LIST_ITEMS = 15;
/** Titles kept per session for <previous_titles>. */
export const MAX_PREVIOUS_TITLES = 10;

const optText = (max: number) => z.string().trim().max(max).optional();

export const wizardTitleSchema = z.object({
  session_key: sessionKeySchema,
  seed_keyword: z.string({ required_error: 'seed_keyword is required' }).trim().min(1, 'Please enter a seed keyword.').max(200),
  language: optText(40),
  niche: optText(120),
  reach: z.enum(['local', 'nationwide']).optional(),
  proof_level: z.enum(['standard', 'regulated']).optional(),
  ideal_client: optText(300),
  featured_service: optText(200),
  target_town: z.string().trim().max(120).nullable().optional(),
  not_about_location: z.boolean().optional(),
  state_hint: z.string().trim().max(40).nullable().optional(),
  use_keyword_data: z.boolean().optional(),
  regenerate: z.boolean().optional(),
});

export type WizardTitleRequest = z.infer<typeof wizardTitleSchema>;

export const townCheckSchema = z.object({
  seed_keyword: z.string().trim().min(1).max(200),
  target_town: z.string().trim().max(120).nullable().optional(),
});

export interface ContentV3WizardDeps {
  auth: RequestHandler;
  rateLimit: RequestHandler;
  store: () => Promise<ContentV3Store>;
  searchData: (store: ContentV3Store, ids: { userId: number; websiteId: number; sessionKey: string | null }, req: SearchDataRequest) => Promise<CachedSearchData>;
  runTitle: (input: TitleStepInput, opts: { runId: string }) => Promise<TitleStepResult>;
  locations: LocationIndexProvider;
  countryIso?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Running per-session cost by step (OPS3); the Writer route logs the article's total. */
export function addCost(prev: unknown, step: string, usd: number | null | undefined): Record<string, number> {
  const base: Record<string, number> = prev && typeof prev === 'object' ? { ...(prev as Record<string, number>) } : {};
  base[step] = Math.round(((Number(base[step]) || 0) + (Number(usd) || 0)) * 1e6) / 1e6;
  return base;
}

export function createContentV3WizardRouter(deps: ContentV3WizardDeps): Router {
  const { env = process.env, log = (line) => console.log(line), countryIso = 'us' } = deps;
  const router = Router();

  const requireV3: RequestHandler = (_req, res, next) => {
    if (!contentV3Enabled(env)) return res.status(409).json(v3ErrorBody(v3Error('v3_disabled')));
    next();
  };

  router.post('/wizard/title', deps.auth, requireV3, deps.rateLimit, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = wizardTitleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', parsed.error.issues[0]?.message ?? 'The request was not valid.')));
    }
    const b = parsed.data;
    const userId = Number(req.user?.id);
    const websiteId = Number(req.website?.id);
    const ids = { userId, websiteId, sessionKey: b.session_key };
    const local = isLocalPost({ seed_keyword: b.seed_keyword, reach: b.reach, target_town: b.target_town, not_about_location: b.not_about_location });

    try {
      const store = await deps.store();
      const sd = await deps.searchData(store, ids, {
        seed_keyword: b.seed_keyword,
        language: b.language,
        reach: b.reach,
        target_town: b.target_town,
        not_about_location: b.not_about_location,
        state_hint: b.state_hint,
      });

      const session = (await store.getSession(userId, websiteId, b.session_key)) ?? {};
      const kw = normKey(b.seed_keyword);
      const titlesState = session.titles as { keyword?: string; list?: string[] } | undefined;
      const shown = titlesState?.keyword === kw && Array.isArray(titlesState.list) ? titlesState.list : [];
      const previous_titles = b.regenerate ? shown.slice(-MAX_PREVIOUS_TITLES) : [];

      const input: TitleStepInput = {
        seed_keyword: b.seed_keyword,
        language: b.language,
        niche: b.niche,
        reach: b.reach,
        proof_level: b.proof_level,
        ideal_client: b.ideal_client,
        // The town is only data for a local post; "Not about a specific location" and nationwide
        // posts name no place unless the keyword does (the prompt's LOCATION rules).
        target_town: local ? parseTown(b.target_town ?? '').town || undefined : undefined,
        featured_service: b.featured_service,
        search_data: sd.block ?? undefined,
        max_list_items: MAX_LIST_ITEMS,
        previous_titles,
        use_keyword_data: b.use_keyword_data,
      };

      let result: TitleStepResult;
      try {
        result = await deps.runTitle(input, { runId: b.session_key });
      } catch (err) {
        if (err instanceof StepFailedError) {
          log(`[content-v3] title failed run=${b.session_key} attempts=${err.attempts.length}`);
          await store.mergeSession(userId, websiteId, b.session_key, { cost: addCost(session.cost, 'search_data', sd.cached ? 0 : sd.meta.cost_usd) });
          return res.json({
            success: true,
            data: {
              title: '',
              failed: true,
              message: "We couldn't write a title this time. Type your own title, or try again.",
              town_check: sd.meta.town_mismatch,
            },
          });
        }
        throw err;
      }

      const o = result.output;
      const list = [...shown, o.title].slice(-MAX_PREVIOUS_TITLES);
      await store.mergeSession(userId, websiteId, b.session_key, {
        titles: { keyword: kw, list },
        title_step: { title: o.title, form: o.form, items: o.items, main_concern: o.main_concern, page_kind: o.page_kind, prompt: result.prompt.label },
        cost: addCost(addCost(session.cost, 'search_data', sd.cached ? 0 : sd.meta.cost_usd), 'title', result.cost_usd),
      });
      // W15: only the title is shown; the rest is logged for testing.
      log(
        `[content-v3] title run=${b.session_key} form=${o.form} items=${o.items ?? '-'} page_kind="${o.page_kind.slice(0, 120)}" ` +
          `main_concern="${o.main_concern.slice(0, 120)}" previous=${previous_titles.length} search_data=${sd.cached ? 'session' : 'fresh'} ` +
          `keyword_data=${result.keyword_data.used ? 'used' : 'off'} attempts=${result.attempts.length} cost_usd=${result.cost_usd ?? 'null'}`,
      );

      return res.json({
        success: true,
        data: {
          title: o.title,
          town_check: sd.meta.town_mismatch,
          search_data: {
            location: sd.block?.location ?? null,
            national_fallback: sd.block?.national_fallback ?? false,
            counts: sd.meta.counts,
          },
        },
      });
    } catch (err) {
      log(`[content-v3] wizard/title error run=${b.session_key}: ${err instanceof Error ? err.message : String(err)}`);
      const e = toV3UserError(err);
      return res.status(e.status).json(v3ErrorBody(e));
    }
  });

  router.post('/wizard/town-check', deps.auth, requireV3, deps.rateLimit, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = townCheckSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(v3ErrorBody(v3Error('invalid_request', 'The request was not valid.')));
    const { seed_keyword, target_town } = parsed.data;
    if (!target_town) return res.json({ success: true, data: { town_check: null } });
    const index = await deps.locations.get(countryIso).catch(() => null);
    const found = detectTownInKeyword(seed_keyword, index, target_town);
    const town_check = found && !found.isTarget ? { keyword_town: found.text, target_town: parseTown(target_town).town } : null;
    return res.json({ success: true, data: { town_check } });
  });

  return router;
}
