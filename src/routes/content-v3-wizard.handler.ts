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
 *   POST /api/v1/content-v3/wizard/approve      Approve title (W3): title check (code) → search
 *     data (session-cached; it runs here for a typed title, W2) → Research (PROMPT 2) → Planner
 *     (PROMPT 3; the fallback plan after 3 failures, P4) → regulated suggestion (G2). Answers only
 *     what step 2 shows (P5): article type, size with size_reason and minimum, owner questions,
 *     the regulated line. Everything else stays in the session for the Writer.
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
import type { PlannerStepInput, PlannerStepOutput, PlannerStepResult } from '../services/content-v3-steps/planner.step.js';
import type { ResearchRequest } from '../services/research/research.service.js';
import { toResearchInput } from '../services/research/research.service.js';
import type { SessionResearch } from '../services/research/research.default.js';
import { checkApprovedTitle, fallbackPlan, minimumSizeFor } from '../services/content-v3/planner-fallback.js';
import { numberedFromTitle } from '../services/blueprint/blueprint.js';
import { regulatedSuggestion, DEFAULT_REGULATED_TOPICS, type RegulatedTopicsList } from '../services/content-v3/regulated-topics.js';
import { DEFAULT_SIZE_OPTIONS } from '../services/content-v3-steps/types.js';
import { DEFAULT_NICHE_SETTINGS, nicheList, resolveNiche, type NicheSettings } from '../services/niche-profile/niche-profile.js';
import { runContext } from '../services/run-context.js';

/** The doc: <max_list_items> is what the largest size can hold, never more than 15. */
export const MAX_LIST_ITEMS = 15;
const MAX_LIST_ITEMS_CAP = 15;
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
  /** Bulk sends the most items the CHOSEN size holds, so a title never needs a larger size. */
  max_list_items: z.number().int().min(1).max(MAX_LIST_ITEMS_CAP).optional(),
});

export type WizardTitleRequest = z.infer<typeof wizardTitleSchema>;

export const townCheckSchema = z.object({
  seed_keyword: z.string().trim().min(1).max(200),
  target_town: z.string().trim().max(120).nullable().optional(),
});

export const approveSchema = z.object({
  session_key: sessionKeySchema,
  title: z.string({ required_error: 'Please write or generate a title first.' }).max(300),
  seed_keyword: z.string().trim().min(1, 'Please enter a seed keyword.').max(200),
  language: optText(40),
  niche: optText(120),
  /** "Other …" niches: the profile the user picked in Business details. */
  niche_profile: optText(40),
  reach: z.enum(['local', 'nationwide']).optional(),
  proof_level: z.enum(['standard', 'regulated']).optional(),
  ideal_client: optText(300),
  featured_service: optText(200),
  business_description: optText(1000),
  target_town: z.string().trim().max(120).nullable().optional(),
  not_about_location: z.boolean().optional(),
  state_hint: z.string().trim().max(40).nullable().optional(),
  use_keyword_data: z.boolean().optional(),
  recent_posts: z
    .array(z.object({ post_id: z.number().int().positive(), title: z.string().max(300), seed_keyword: z.string().max(200).optional() }))
    .max(50)
    .optional(),
  /** Bulk: the project this article belongs to, stored with its post history row (B5). */
  bulk_batch: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
});

type Ids = { userId: number; websiteId: number; sessionKey: string | null };

export interface ContentV3WizardDeps {
  auth: RequestHandler;
  rateLimit: RequestHandler;
  store: () => Promise<ContentV3Store>;
  searchData: (store: ContentV3Store, ids: Ids, req: SearchDataRequest) => Promise<CachedSearchData>;
  runTitle: (input: TitleStepInput, opts: { runId: string; deadlineAt?: number }) => Promise<TitleStepResult>;
  research?: (store: ContentV3Store, ids: Ids, req: ResearchRequest, opts?: { deadlineAt?: number }) => Promise<SessionResearch>;
  runPlanner?: (input: PlannerStepInput, opts: { runId: string; deadlineAt?: number }) => Promise<PlannerStepResult>;
  /** The editable regulated topics list (registry template), default when unset or invalid. */
  regulatedList?: () => Promise<RegulatedTopicsList>;
  /** The niche settings (registry JSON); for the niche's watch terms in the regulated check. */
  nicheSettings?: () => Promise<NicheSettings>;
  locations: LocationIndexProvider;
  countryIso?: string;
  /** B-5: the daily allowance guard per free step (none = no allowance check). */
  freeStepGuard?: (step: 'title' | 'town_check' | 'approve') => RequestHandler;
  /** M1: false while the v3 tables (migrations 023 and 024) are missing; the steps then answer v3 off. */
  ready?: () => Promise<boolean>;
  /** B-3: request budgets below the plugin's waits (240 s title, 420 s approve). */
  titleDeadlineMs?: number;
  approveDeadlineMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => number;
}

export const DEFAULT_TITLE_DEADLINE_MS = 200_000;
export const DEFAULT_APPROVE_DEADLINE_MS = 360_000;
/** Research stops this long before the approve deadline (at most half of it), leaving it to the Planner. */
export const PLANNER_RESERVE_MS = 150_000;

const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Running per-session cost by step (OPS3); the Writer route logs the article's total. */
export function addCost(prev: unknown, step: string, usd: number | null | undefined): Record<string, number> {
  const base: Record<string, number> = prev && typeof prev === 'object' ? { ...(prev as Record<string, number>) } : {};
  base[step] = Math.round(((Number(base[step]) || 0) + (Number(usd) || 0)) * 1e6) / 1e6;
  return base;
}

export function createContentV3WizardRouter(deps: ContentV3WizardDeps): Router {
  const { env = process.env, log = (line) => console.log(line), countryIso = 'us', now = () => Date.now() } = deps;
  const titleMs = deps.titleDeadlineMs ?? DEFAULT_TITLE_DEADLINE_MS;
  const approveMs = deps.approveDeadlineMs ?? DEFAULT_APPROVE_DEADLINE_MS;
  const router = Router();

  const requireV3: RequestHandler = async (_req, res, next) => {
    if (!contentV3Enabled(env)) return res.status(409).json(v3ErrorBody(v3Error('v3_disabled')));
    if (deps.ready && !(await deps.ready().catch(() => false))) return res.status(409).json(v3ErrorBody(v3Error('v3_disabled')));
    next();
  };
  // D: every log line of a wizard request (search data, DataForSEO, keyword data) carries run=<key>.
  router.use(runContext);
  const pass: RequestHandler = (_req, _res, next) => next();
  const allowance = (step: 'title' | 'town_check' | 'approve') => (deps.freeStepGuard ? deps.freeStepGuard(step) : pass);

  router.post('/wizard/title', deps.auth, requireV3, deps.rateLimit, allowance('title'), async (req: AuthenticatedRequest, res: Response) => {
    const parsed = wizardTitleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', parsed.error.issues[0]?.message ?? 'The request was not valid.')));
    }
    const b = parsed.data;
    const userId = Number(req.user?.id);
    const websiteId = Number(req.website?.id);
    const ids = { userId, websiteId, sessionKey: b.session_key };
    const local = isLocalPost({ seed_keyword: b.seed_keyword, reach: b.reach, target_town: b.target_town, not_about_location: b.not_about_location });
    // B-3: answer before the plugin stops waiting; past it the title is reported as not written.
    const deadlineAt = now() + titleMs;

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

      const titleNiche = deps.nicheSettings ? resolveNiche(b.niche, await deps.nicheSettings().catch(() => DEFAULT_NICHE_SETTINGS)) : resolveNiche(b.niche);
      const input: TitleStepInput = {
        seed_keyword: b.seed_keyword,
        language: b.language,
        niche: titleNiche?.label ?? b.niche,
        reach: b.reach,
        proof_level: b.proof_level,
        ideal_client: b.ideal_client,
        // The town is only data for a local post; "Not about a specific location" and nationwide
        // posts name no place unless the keyword does (the prompt's LOCATION rules).
        target_town: local ? parseTown(b.target_town ?? '').town || undefined : undefined,
        featured_service: b.featured_service,
        search_data: sd.block ?? undefined,
        max_list_items: b.max_list_items ?? MAX_LIST_ITEMS,
        previous_titles,
        use_keyword_data: b.use_keyword_data,
      };

      let result: TitleStepResult;
      try {
        result = await deps.runTitle(input, { runId: b.session_key, deadlineAt });
      } catch (err) {
        if (err instanceof StepFailedError) {
          log(`[content-v3] title failed run=${b.session_key} attempts=${err.attempts.length} cost_usd=${err.cost_usd ?? 'null'}`);
          await store.mergeSession(userId, websiteId, b.session_key, {
            cost: addCost(addCost(session.cost, 'search_data', sd.cached ? 0 : sd.meta.cost_usd), 'title', err.cost_usd),
          });
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
          `keyword_data=${result.keyword_data.used ? 'used' : 'off'} attempts=${result.attempts.length} cost_usd=${result.cost_usd ?? 'null'} ms=${now() - (deadlineAt - titleMs)}`,
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

  router.post('/wizard/approve', deps.auth, requireV3, deps.rateLimit, allowance('approve'), async (req: AuthenticatedRequest, res: Response) => {
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', parsed.error.issues[0]?.message ?? 'The request was not valid.')));
    }
    if (!deps.research || !deps.runPlanner) return res.status(503).json(v3ErrorBody(v3Error('not_configured')));
    const b = parsed.data;
    const check = checkApprovedTitle(b.title, b.seed_keyword);
    if (!check.ok) return res.status(400).json(v3ErrorBody(v3Error('invalid_request', check.error)));

    // W5: a local business chooses the post's town or "Not about a specific location" before the
    // plan is made (the wizard asks first; this holds for any caller).
    const nationwide = String(b.reach ?? '').toLowerCase().startsWith('nation');
    if (!nationwide && String(b.reach ?? '').trim() && !b.not_about_location && !String(b.target_town ?? '').trim()) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', 'Choose the town this post is about, or "Not about a specific location".')));
    }
    const userId = Number(req.user?.id);
    const websiteId = Number(req.website?.id);
    const ids = { userId, websiteId, sessionKey: b.session_key };
    const local = isLocalPost({ seed_keyword: b.seed_keyword, reach: b.reach, target_town: b.target_town, not_about_location: b.not_about_location });
    const town = local ? parseTown(b.target_town ?? '').town || undefined : undefined;
    // B-3: answer before the plugin stops waiting. Research gives up early enough to leave the
    // Planner its share; a Planner out of time falls back to the default plan (P4).
    const deadlineAt = now() + approveMs;
    const researchDeadlineAt = deadlineAt - Math.min(PLANNER_RESERVE_MS, Math.floor(approveMs / 2));

    try {
      const store = await deps.store();
      const session = (await store.getSession(userId, websiteId, b.session_key)) ?? {};
      let cost = session.cost;

      // W2: a typed title had no lookup yet; a generated one finds it in the session.
      const sd = await deps.searchData(store, ids, {
        seed_keyword: b.seed_keyword,
        language: b.language,
        reach: b.reach,
        target_town: b.target_town,
        not_about_location: b.not_about_location,
        state_hint: b.state_hint,
      });
      cost = addCost(cost, 'search_data', sd.cached ? 0 : sd.meta.cost_usd);

      const research = await deps.research(store, ids, {
        title: check.title,
        seed_keyword: b.seed_keyword,
        language: b.language,
        niche: b.niche,
        featured_service: b.featured_service,
        reach: b.reach,
        target_town: town,
        people_also_ask: sd.block?.people_also_ask ?? [],
        local_domains: sd.meta.local_domains,
        state_hint: b.state_hint,
      }, { deadlineAt: researchDeadlineAt });
      cost = addCost(cost, 'research', research.cached ? 0 : research.cost_usd);
      const researchInput = research.research ? toResearchInput(research.research) : undefined;

      // <minimum_size>: from the title's own item count (B6, the same rule as the blueprint): the
      // Title step's form/items when this is the generated title, else a number before a known
      // item kind in a typed title ("7 signs …"; "24 hour plumber" is not a list).
      const ts = session.title_step as { title?: string; form?: string; items?: number | null } | undefined;
      const fromStep = ts?.title === check.title;
      const nb = numberedFromTitle(check.title, fromStep ? ts?.form ?? null : null, fromStep ? ts?.items ?? null : null);
      const minimum_size = minimumSizeFor(nb ? 'numbered' : undefined, nb?.items ?? null);

      const plannerNiche = deps.nicheSettings ? resolveNiche(b.niche, await deps.nicheSettings().catch(() => DEFAULT_NICHE_SETTINGS)) : resolveNiche(b.niche);
      const plannerInput: PlannerStepInput = {
        title: check.title,
        seed_keyword: b.seed_keyword,
        language: b.language,
        niche: plannerNiche?.label ?? b.niche,
        reach: b.reach,
        proof_level: b.proof_level,
        ideal_client: b.ideal_client,
        target_town: town,
        featured_service: b.featured_service,
        business_description: b.business_description,
        search_data: sd.block ?? undefined,
        research: researchInput,
        size_options: DEFAULT_SIZE_OPTIONS,
        minimum_size,
        use_keyword_data: b.use_keyword_data,
        recent_posts: b.recent_posts,
      };

      let plan: PlannerStepOutput;
      let fallback = false;
      let plannerPrompt = '';
      try {
        const r = await deps.runPlanner(plannerInput, { runId: b.session_key, deadlineAt });
        plan = r.output;
        plannerPrompt = r.prompt.label;
        cost = addCost(cost, 'planner', r.cost_usd);
      } catch (err) {
        if (!(err instanceof StepFailedError)) throw err;
        // P4: the article can still be generated. R7: the failed attempts' spend still counts.
        cost = addCost(cost, 'planner', err.cost_usd);
        fallback = true;
        plan = fallbackPlan({ seedKeyword: b.seed_keyword, title: check.title, minimumSize: minimum_size, searchData: sd.block });
        log(`[content-v3] planner fallback run=${b.session_key} attempts=${err.attempts.length} type=${plan.article_type} size=${plan.post_size}`);
      }

      const list = deps.regulatedList ? await deps.regulatedList().catch(() => DEFAULT_REGULATED_TOPICS) : DEFAULT_REGULATED_TOPICS;
      const nicheSettings = deps.nicheSettings ? await deps.nicheSettings().catch(() => DEFAULT_NICHE_SETTINGS) : DEFAULT_NICHE_SETTINGS;
      const nicheRow = resolveNiche(b.niche, nicheSettings);
      const regulated = regulatedSuggestion({
        businessProofLevel: b.proof_level,
        title: check.title,
        seedKeyword: b.seed_keyword,
        plannerRegulated: plan.regulated_topic,
        plannerReason: plan.regulated_reason,
        list,
        watchlist: nicheRow?.watch_terms ?? [],
      });

      await store.mergeSession(userId, websiteId, b.session_key, {
        approved: {
          title: check.title,
          seed_keyword: b.seed_keyword,
          language: b.language ?? null,
          niche: b.niche ?? null,
          niche_key: nicheRow?.key ?? null,
          niche_profile: b.niche_profile ?? null,
          reach: b.reach ?? null,
          target_town: town ?? null,
          not_about_location: !!b.not_about_location,
          proof_level: b.proof_level ?? null,
          featured_service: b.featured_service ?? null,
          business_description: b.business_description ?? null,
          ideal_client: b.ideal_client ?? null,
        },
        plan,
        plan_meta: { fallback, minimum_size, prompt: plannerPrompt, research_status: research.status },
        ...(b.bulk_batch ? { bulk_batch: b.bulk_batch } : {}),
        regulated,
        cost,
      });

      log(
        `[content-v3] approve run=${b.session_key} niche=${nicheRow?.key ?? 'unknown'} proof=${b.proof_level ?? '-'} type=${plan.article_type} size=${plan.post_size} min=${minimum_size} ` +
          `body=${plan.body_questions.length} faq=${plan.faq_questions.length} owner=${plan.owner_questions.length} ` +
          `regulated=${regulated.suggested ? regulated.by : 'no'} research=${research.status}${research.cached ? '(session)' : ''} fallback=${fallback ? 'yes' : 'no'} ` +
          `research_ms=${research.ms} ms=${now() - (deadlineAt - approveMs)}`,
      );

      return res.json({
        success: true,
        data: {
          title: check.title,
          title_notes: check.notes,
          plan: {
            article_type: plan.article_type,
            post_size: plan.post_size,
            size_reason: plan.size_reason,
            minimum_size,
            owner_questions: plan.owner_questions,
          },
          regulated: { suggested: regulated.suggested, by: regulated.by, phrase: regulated.phrase, reason: regulated.reason },
          research: {
            status: research.status,
            facts: research.research?.facts.length ?? 0,
            local_conditions: research.research?.local_conditions.length ?? 0,
          },
          fallback,
          town_check: sd.meta.town_mismatch,
        },
      });
    } catch (err) {
      log(`[content-v3] wizard/approve error run=${b.session_key}: ${err instanceof Error ? err.message : String(err)}`);
      const e = toV3UserError(err);
      return res.status(e.status).json(v3ErrorBody(e));
    }
  });

  /** The niche list for the plugin's Business details picker (N1: the server's settings are the source). */
  router.get('/niches', deps.auth, requireV3, async (_req: AuthenticatedRequest, res: Response) => {
    const settings = deps.nicheSettings ? await deps.nicheSettings().catch(() => DEFAULT_NICHE_SETTINGS) : DEFAULT_NICHE_SETTINGS;
    res.json({ success: true, data: { niches: nicheList(settings), profiles: settings.profiles.map((p) => ({ key: p.key, name: p.name })) } });
  });

  router.post('/wizard/town-check', deps.auth, requireV3, deps.rateLimit, allowance('town_check'), async (req: AuthenticatedRequest, res: Response) => {
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
