/**
 * Content Generation v3 — Claude route (additive; v2 is untouched).
 *
 *   POST /api/v1/content-v3/article/test   — requireAdmin, no credits. The prompt-tuning endpoint.
 *   POST /api/v1/content-v3/prompts/seed   — requireAdmin. Registers the v3 templates (writer chain + steps).
 *   POST /api/v1/content-v3/title          — requireAdmin, no credits. PROMPT 1 (Title step).
 *   POST /api/v1/content-v3/planner        — requireAdmin, no credits. PROMPT 3 (Planner step).
 *                                            Both in content-v3-steps.handler.ts; keyword data
 *                                            (Option B) applies when ISEO_V3_KEYWORD_DATA=true and
 *                                            the request sends use_keyword_data: true.
 *   POST /api/v1/content-v3/prompts/seed?mode=replace — requireAdmin. Also makes every doc-sourced
 *                                            prompt the active version, backing the old value up as
 *                                            "pre-v3" first (OPS2, WR3).
 *   POST /api/v1/content-v3/prompts/backup-pre-v3 — requireAdmin. Only the backup, nothing activated.
 *   GET  /api/v1/content-v3/prompts/check  — requireAdmin. Active DB text vs the doc text, per prompt.
 *   POST /api/v1/content-v3/search-data    — requireAdmin. The search data lookup alone (S1–S12).
 *   POST /api/v1/content-v3/blueprint/preview — requireAdmin. The <blueprint> for given inputs and
 *                                            pins, no model call (X1–X7).
 *   POST /api/v1/content-v3/research       — requireAdmin. Research alone (R1–R10), optionally
 *                                            after a search data lookup.
 *   POST /api/v1/content-v3/wizard/title   — validateApiAccess (plugin). Search data → Title (W2, W12, W15).
 *   POST /api/v1/content-v3/wizard/town-check — validateApiAccess (plugin). W6 town line.
 *   GET  /api/v1/content-v3/niches         — validateApiAccess (plugin). The niche list (N1 settings);
 *                                            409 while CONTENT_V3_ENABLED is off.
 *   POST /api/v1/content-v3/article        — validateApiAccess (plugin), PAID like v2: the Writer
 *                                            draft 2 article from the session's plan (phase 8).
 *   POST /api/v1/content-v3/wizard/approve — validateApiAccess (plugin). Title check → Research →
 *                                            Planner (W3, P1–P6, G2).
 *   GET  /api/v1/content-v3/status         — validateApiAccess (plugin). Is CONTENT_V3_ENABLED on?
 *   GET  /api/v1/content-v3/admin/trail?run= — requireAdmin. One run's ledger, generation and post
 *                                            rows (no article text); see content-v3-trail.handler.ts.
 *   POST /api/v1/content-v3/session/clear  — validateApiAccess (plugin). The wizard's Leave (W10).
 *   POST /api/v1/content-v3/keyword-data/prefetch — validateApiAccess (plugin). Warms the keyword
 *                                            data cache (no credits); does nothing unless
 *                                            CONTENT_V3_ENABLED and ISEO_V3_KEYWORD_DATA are on.
 *
 * Billing: /article is the one paid route (v2's price per size, reserve then refund, charged once
 * per request_id through the content_v3_runs ledger). It writes `user_generations` rows of type
 * `content_v3` (verified on production 14 Nov). The free wizard steps have a daily allowance per
 * account tied to the articles delivered that day (services/content-v3/quota.ts).
 */

import { Router, Request, Response } from 'express';
import {
  GenerateV3Params,
  ArticleType,
  ARTICLE_TYPES,
} from '../services/claude-content-generator-v3.service.js';
import { parseBusinessProfile } from '../services/business-profile.v3.js';
import {
  ACCENTS,
  CLOSE_MOVES,
  FAQ_PLACEMENTS,
  OPENING_MOVES,
  type BlueprintOverrides,
} from '../services/content-blueprint.js';
import { seedV3Prompts } from '../services/prompt-seed.v3.js';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import { sanitizeCustomInstruction } from '../services/generation-history.js';
import keywordDataRoutes from './content-v3-keyword-data.routes.js';
import stepsRoutes from './content-v3-steps.routes.js';
import { createContentV3PluginRouter } from './content-v3-plugin.handler.js';
import { validateApiAccessWithoutStamp } from '../middleware/apiAuth.middleware.js';
import { getContentV3Store, getContentV3Runs, getContentV3Quota, startRunsHousekeeping } from '../services/content-v3/store.default.js';
import { freeStepGuard, freeStepLimits } from '../services/content-v3/quota.js';
import type { RunsStore } from '../services/content-v3/runs.js';
import { contentV3Config, contentV3Enabled } from '../config/content-v3.config.js';
import { checkV3Prompts, v3DocPromptDefs } from '../services/prompt-seed.v3.js';
import { PromptManagementService } from '../services/prompt-management.service.js';
import { createSearchDataRouter } from './content-v3-search-data.handler.js';
import { lookupSearchData } from '../services/search-data/search-data.service.js';
import { liveSearchDataDeps, sessionSearchData } from '../services/search-data/search-data.default.js';
import { createContentV3WizardRouter } from './content-v3-wizard.handler.js';
import { validateApiAccess } from '../middleware/apiAuth.middleware.js';
import { rateLimitPerUser } from '../middleware/rateLimit.middleware.js';
import { runTitleStep } from '../services/content-v3-steps/title.step.js';
import { liveTitleDeps } from '../services/content-v3-steps/steps.default.js';
import { searchDataConfig } from '../config/search-data.config.js';
import { z } from 'zod';
import { runResearch, toResearchInput } from '../services/research/research.service.js';
import { liveResearchInstructions, sessionResearch } from '../services/research/research.default.js';
import { runPlannerStep } from '../services/content-v3-steps/planner.step.js';
import { livePlannerDeps } from '../services/content-v3-steps/steps.default.js';
import { liveRegulatedTopics, REGULATED_TOPICS_DEF } from '../services/content-v3/regulated-topics.js';
import { liveNicheSettings } from '../services/niche-profile/niche-profile.default.js';
import { createBlueprintRouter } from './content-v3-blueprint.handler.js';
import { createTrailRouter } from './content-v3-trail.handler.js';
import { createContentV3ArticleRouter, STALE_GRACE_MS } from './content-v3-article.handler.js';
import { liveGenerateArticle } from '../services/writer/article.default.js';
import { isContentV3Regeneration } from '../services/generation-history.js';
import { reserveCredits, refundCredits, getLiveBalance, ISEO_CREDIT_TYPE } from '../models/user.models.js';
import { priceOf, affordableWith } from '../services/credit-pricing.js';
import sql from '../data/db.js';
import { researchBlock } from '../services/content-v3-steps/xml.js';
import { runTestChain } from '../services/writer/test-chain.js';
import { parseBlueprintPins } from './content-v3-blueprint.handler.js';
import { variantFromWords } from '../services/content-blueprint.js';
import { toV3UserError } from '../services/content-v3/user-errors.js';

const researchRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  seed_keyword: z.string().trim().min(1).max(200),
  language: z.string().trim().max(40).optional(),
  niche: z.string().trim().max(120).optional(),
  featured_service: z.string().trim().max(200).optional(),
  reach: z.enum(['local', 'nationwide']).optional(),
  target_town: z.string().trim().max(120).optional(),
  state_hint: z.string().trim().max(40).optional(),
  people_also_ask: z.array(z.object({ text: z.string().max(300), scope: z.enum(['local', 'national']) })).max(20).optional(),
  local_domains: z.array(z.string().max(200)).max(40).optional(),
  /** Run the search data lookup first and feed its questions and local domains in. */
  run_search_data: z.boolean().optional(),
});

const router = Router();

// A3 (decision 14 Nov): niche/profile keys with a disclaimer text. A Regulated business stays on v2
// until its niche has one. Cached for a minute (the plugin's status check asks often).
let disclaimerKeysCache: { at: number; keys: string[] } | null = null;
async function liveDisclaimerKeys(): Promise<string[]> {
  if (disclaimerKeysCache && Date.now() - disclaimerKeysCache.at < 60_000) return disclaimerKeysCache.keys;
  const all = (await liveNicheSettings()).disclaimers;
  const keys = Object.entries(all)
    .filter(([, text]) => typeof text === 'string' && text.trim() !== '')
    .map(([key]) => key);
  disclaimerKeysCache = { at: Date.now(), keys };
  return keys;
}

// B-3: the run ledger, loaded on first use (the database module is imported lazily).
const lazyRuns: RunsStore = {
  claim: async (p) => (await getContentV3Runs()).claim(p),
  charged: async (id, p) => (await getContentV3Runs()).charged(id, p),
  succeeded: async (id, p) => (await getContentV3Runs()).succeeded(id, p),
  failed: async (id, p) => (await getContentV3Runs()).failed(id, p),
  takePendingRefunds: async (n) => (await getContentV3Runs()).takePendingRefunds(n),
  refundDone: async (id, ok) => (await getContentV3Runs()).refundDone(id, ok),
  bySession: async (k, n) => (await getContentV3Runs()).bySession(k, n),
  purge: async (d) => (await getContentV3Runs()).purge(d),
  sweepStale: async (ms) => (await getContentV3Runs()).sweepStale(ms),
  forgetResponses: async (u, k) => (await getContentV3Runs()).forgetResponses(u, k),
  stuckRefunding: async (ms) => (await getContentV3Runs()).stuckRefunding(ms),
};

/**
 * M1: v3 needs its tables. While migration 023 (sessions, post history) or 024 (run ledger, daily
 * counters) is missing, /status says v3 is off and the v3 routes answer v3_disabled, so every site
 * stays on v2 instead of failing at the paid step. Checked at most once a minute; local development
 * with CONTENT_V3_STORE=memory needs no tables.
 */
let readyCache: { at: number; ok: boolean } | null = null;
async function v3TablesReady(): Promise<boolean> {
  if (process.env.CONTENT_V3_STORE === 'memory') return true;
  if (readyCache && Date.now() - readyCache.at < 60_000) return readyCache.ok;
  let ok = false;
  try {
    const rows = await sql`
      SELECT to_regclass('public.content_v3_sessions') IS NOT NULL AS sessions,
             to_regclass('public.content_v3_posts') IS NOT NULL AS posts,
             to_regclass('public.content_v3_runs') IS NOT NULL AS runs,
             to_regclass('public.content_v3_quota') IS NOT NULL AS quota
    `;
    const r = rows[0] ?? {};
    ok = !!(r.sessions && r.posts && r.runs && r.quota);
    if (!ok && (!readyCache || readyCache.ok)) {
      console.warn(`[content-v3] switched on but its tables are missing (sessions=${!!r.sessions} posts=${!!r.posts} runs=${!!r.runs} quota=${!!r.quota}): apply migrations 023 and 024; v3 is reported off until then`);
    }
  } catch (err) {
    console.warn(`[content-v3] could not check the v3 tables, v3 reported off: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  readyCache = { at: Date.now(), ok };
  return ok;
}
const refundV3 = async (userId: number, cost: number, reason: string, websiteId?: number) => {
  await refundCredits(userId, ISEO_CREDIT_TYPE, cost, reason, websiteId);
};
// H2: stopped runs are swept and failed refunds retried every 10 minutes, whether v3 is on or not
// (a rollback must still refund what it interrupted).
startRunsHousekeeping(refundV3, { staleAfterMs: contentV3Config().articleDeadlineMs + STALE_GRACE_MS });

// The paid v3 article (plugin auth). Same price and reserve/refund path as v2's /content-v2/article.
router.use(
  '/',
  createContentV3ArticleRouter({
    auth: validateApiAccess,
    store: getContentV3Store,
    billing: {
      isRegeneration: (userId, key) => isContentV3Regeneration(userId, key),
      price: (action, variant) => priceOf(action, variant),
      reserve: async (userId, cost, reason, websiteId) => {
        const r = await reserveCredits(userId, ISEO_CREDIT_TYPE, cost, reason, websiteId);
        return { ok: r.ok, balance_after: r.ok ? r.included_remaining + r.purchased_remaining : undefined };
      },
      refund: refundV3,
      shortfall: async (userId) => {
        const balance = await getLiveBalance(userId);
        return { available: balance.total, also_affords: affordableWith(balance.total) };
      },
    },
    generate: (input, opts) => liveGenerateArticle(input, opts),
    insertGeneration: async (row) => {
      const rows = await sql`
        INSERT INTO user_generations (user_id, website_id, type, status, parameters, result, metadata, processing_time_ms, target_key, custom_instruction)
        VALUES (${row.user_id}, ${row.website_id}, 'content_v3', 'success', ${JSON.stringify(row.parameters)}, ${JSON.stringify(row.result)},
                ${JSON.stringify(row.metadata)}, ${row.processing_time_ms}, ${row.target_key}, ${row.custom_instruction})
        RETURNING id
      `;
      return rows[0]?.id ?? null;
    },
    disclaimerKeys: liveDisclaimerKeys,
    runs: lazyRuns,
    ready: v3TablesReady,
    deadlineMs: contentV3Config().articleDeadlineMs,
    // B-5: credits already bound the article; this stops a client hammering the route.
    rateLimit: rateLimitPerUser({ limit: 30, windowMs: 60_000, keyPrefix: 'content-v3-article', message: 'Too many requests in a short time. Please wait a minute and try again.' }),
    quota: getContentV3Quota,
  }),
);

// Blueprint preview for the tester panel (admin, no model call).
router.use('/', createBlueprintRouter({ auth: requireAdmin }));

// D: one run's trail for support (admin): ledger rows, generation rows, post history row.
router.use(
  '/',
  createTrailRouter({
    auth: requireAdmin,
    runs: (run) => lazyRuns.bySession(run, 50),
    generations: async (run) => [...(await sql`
      SELECT id, user_id, website_id, type, status, created_at, processing_time_ms, metadata
      FROM user_generations WHERE target_key = ${run} ORDER BY id LIMIT 50
    `)],
    posts: async (run) => [...(await sql`
      SELECT id, user_id, website_id, session_key, bulk_batch, article_type, post_size, proof_level, fingerprint, validator, created_at
      FROM content_v3_posts WHERE session_key = ${run} ORDER BY id LIMIT 20
    `)],
  }),
);

// Research alone (admin: tester panel, 10-keyword run). Spends Perplexity money when configured.
router.post('/research', requireAdmin, async (req: Request, res: Response) => {
  const parsed = researchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', message: parsed.error.issues.map((i) => i.message).join('; ') });
  }
  const b = parsed.data;
  let paa = b.people_also_ask;
  let localDomains = b.local_domains;
  if (b.run_search_data) {
    const sd = await lookupSearchData({ seed_keyword: b.seed_keyword, language: b.language, reach: b.reach, target_town: b.target_town }, liveSearchDataDeps());
    paa = sd.block?.people_also_ask ?? [];
    localDomains = sd.meta.local_domains;
  }
  const r = await runResearch(
    { ...b, people_also_ask: paa, local_domains: localDomains },
    { resolveInstructions: () => liveResearchInstructions() },
  );
  return res.json({ success: true, data: { ...r, xml: r.research ? researchBlock(toResearchInput(r.research)) : '' } });
});

// The single wizard's v3 steps (plugin auth). Free, rate-limited per account and capped per day; 409 while
// CONTENT_V3_ENABLED is off so the plugin falls back to v2.
router.use(
  '/',
  createContentV3WizardRouter({
    auth: validateApiAccess,
    rateLimit: rateLimitPerUser({ limit: 30, windowMs: 60_000, keyPrefix: 'content-v3-wizard', message: 'Too many requests in a short time. Please wait a minute and try again.' }),
    store: getContentV3Store,
    searchData: (store, ids, req) => sessionSearchData(store, ids, req),
    runTitle: (input, { runId, deadlineAt }) => runTitleStep(input, { ...liveTitleDeps(), runId, deadlineAt }),
    research: (store, ids, req, opts) => sessionResearch(store, ids, req, { deadlineAt: opts?.deadlineAt }),
    runPlanner: (input, { runId, deadlineAt }) => runPlannerStep(input, { ...livePlannerDeps(), runId, deadlineAt }),
    regulatedList: () => liveRegulatedTopics(() => new PromptManagementService().getPrompt(REGULATED_TOPICS_DEF.templateType)),
    nicheSettings: async () => (await liveNicheSettings()).settings,
    get locations() {
      return liveSearchDataDeps().locations;
    },
    countryIso: searchDataConfig().countryIso,
    // B-5: daily allowance per free step, tied to the articles generated that day.
    freeStepGuard: (step) => freeStepGuard(step, getContentV3Quota, { limits: freeStepLimits() }),
    ready: v3TablesReady,
    titleDeadlineMs: contentV3Config().titleDeadlineMs,
    approveDeadlineMs: contentV3Config().approveDeadlineMs,
  }),
);

// Search data lookup on its own (admin: tester panel, 10-keyword run). Spends DataForSEO money.
router.use('/', createSearchDataRouter({ auth: requireAdmin, lookup: (req) => lookupSearchData(req, liveSearchDataDeps()) }));

// Plugin-facing status and session housekeeping (content-v3-plugin.handler.ts). The status check
// does not stamp the website's last connection: it is a capability probe, not a generation.
router.use(
  '/',
  createContentV3PluginRouter({
    auth: validateApiAccessWithoutStamp,
    store: getContentV3Store,
    disclaimerKeys: liveDisclaimerKeys,
    ready: v3TablesReady,
    forgetRunResponses: (userId, sessionKey) => lazyRuns.forgetResponses(userId, sessionKey),
    // Leave (W10): the unsubmitted article's text goes; the row, its billing and its status stay
    // (so a later regeneration in the same slot is still priced as one). Written exactly as the
    // insert above writes `result` (same parameter, no cast), so readers see the same encoding.
    forgetArticles: async (userId, sessionKey) => {
      const rows = await sql`
        UPDATE user_generations
           SET result = ${JSON.stringify({ content: '', removed: 'left_unsubmitted' })}
         WHERE user_id = ${userId} AND target_key = ${sessionKey} AND type = 'content_v3'
        RETURNING id
      `;
      return rows.length;
    },
  }),
);

// Keyword data (Option A/B plumbing). Auth is applied INSIDE the sub-router: prefetch is
// plugin-authenticated, everything else on it is requireAdmin.
router.use('/keyword-data', keywordDataRoutes);

// The Title and Planner steps (admin-only, like /article/test). Mounted at the root so the paths
// are /content-v3/title and /content-v3/planner; auth is applied inside the sub-router.
router.use('/', stepsRoutes);

const VALID_WORDS = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];

function parseBlueprintOverrides(raw: any): { error?: string; overrides?: BlueprintOverrides } {
  if (!raw || typeof raw !== 'object') return {};
  const ov: BlueprintOverrides = {};

  const oneOf = <T extends string>(value: unknown, allowed: T[], field: string): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      return `blueprint_overrides.${field} must be one of: ${allowed.join(', ')}`;
    }
    return undefined;
  };

  for (const [field, allowed] of [
    ['openingMove', OPENING_MOVES],
    ['accent', ACCENTS],
    ['faqPlacement', FAQ_PLACEMENTS],
    ['closeMove', CLOSE_MOVES],
  ] as const) {
    const err = oneOf(raw[field], allowed as unknown as string[], field);
    if (err) return { error: err };
    if (raw[field]) (ov as Record<string, unknown>)[field] = raw[field];
  }

  if (typeof raw.includeToc === 'boolean') ov.includeToc = raw.includeToc;

  if (raw.sectionCount !== undefined && raw.sectionCount !== null && raw.sectionCount !== '') {
    const n = Number(raw.sectionCount);
    if (!Number.isFinite(n) || n < 1 || n > 12) {
      return { error: 'blueprint_overrides.sectionCount must be a number between 1 and 12' };
    }
    ov.sectionCount = Math.round(n);
  }

  if (typeof raw.pov === 'string' && raw.pov.trim()) ov.pov = raw.pov.trim();

  return { overrides: Object.keys(ov).length ? ov : undefined };
}

interface ParseResult {
  error?: string;
  params?: GenerateV3Params;
  warnings?: string[];
}

function strOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function parseParamsV3(body: any): ParseResult {
  if (!body?.seed_keyword) return { error: 'seed_keyword is required' };
  if (!body?.niche) return { error: 'niche is required' };
  if (body.nos_of_words && !VALID_WORDS.includes(body.nos_of_words)) {
    return { error: `nos_of_words must be one of: ${VALID_WORDS.join(', ')}` };
  }

  const warnings: string[] = [];

  let articleType: ArticleType | undefined;
  if (body.article_type) {
    if (!ARTICLE_TYPES.includes(body.article_type)) {
      return { error: `article_type must be one of: ${ARTICLE_TYPES.join(', ')}` };
    }
    articleType = body.article_type;
  }

  // `brand_profile` is v2's shape. Accepting it as a deprecated alias means a copy-pasted v2 body
  // still produces a populated business block instead of a silent "(none provided)".
  const parsed = parseBusinessProfile(body.business_profile, body.brand_profile);
  warnings.push(...parsed.warnings);

  const bp = parseBlueprintOverrides(body.blueprint_overrides);
  if (bp.error) return { error: bp.error };

  const schemaArticleType =
    body.schema_article_type === 'Article' ? 'Article' : ('BlogPosting' as const);

  let servicesSelected: string[] | undefined;
  if (Array.isArray(body.services_selected)) {
    const names = body.services_selected
      .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean);
    if (names.length) servicesSelected = names;
  }

  return {
    warnings,
    params: {
      seed_keyword: String(body.seed_keyword),
      niche: String(body.niche),
      title: strOrUndefined(body.title),
      nos_of_words: body.nos_of_words || '1200 to 2400 words',
      content_lang: body.content_lang || 'English (US)',
      niche_data:
        body.niche_data && typeof body.niche_data === 'object' ? body.niche_data : undefined,
      business_profile: parsed.profile,
      article_type: articleType,
      services_selected: servicesSelected,
      call_to_action: strOrUndefined(body.call_to_action),
      cta_url: strOrUndefined(body.cta_url),
      humanize: body.humanize === false ? false : true,
      seed: strOrUndefined(body.seed),
      blueprint_overrides: bp.overrides,
      custom_instruction: sanitizeCustomInstruction(body.custom_instruction) ?? undefined,
      site_url: strOrUndefined(body.site_url),
      post_url: strOrUndefined(body.post_url),
      featured_image_url: strOrUndefined(body.featured_image_url),
      date_published: strOrUndefined(body.date_published),
      date_modified: strOrUndefined(body.date_modified),
      schema_article_type: schemaArticleType,
      // `diagnostics` is NOT read from the body — see the handler below.
    },
  };
}

/**
 * Prompt-tuning endpoint. Admin only, no credits, full diagnostics.
 *
 * Diagnostics are switched on here as a literal, and parseParamsV3 never reads the flag from the
 * request. That matters because the bundle contains the fully rendered system prompt: on a
 * credit-gated endpoint, which is reached with a site API key stored in plaintext in every
 * customer's WordPress options table, returning it would publish the prompt library to anyone
 * holding or sniffing one site's credentials.
 */
router.post('/article/test', requireAdmin, async (req: Request, res: Response) => {
  const { error, params, warnings } = parseParamsV3(req.body);
  if (error) return res.status(400).json({ success: false, error });
  const pins = parseBlueprintPins(req.body?.blueprint_pins);
  if (pins.error) return res.status(400).json({ success: false, error: pins.error });

  const prof = params!.business_profile ?? {};
  const reach: 'local' | 'nationwide' = prof.is_local === false ? 'nationwide' : 'local';
  // X6: Auto (no pin) means the Business details point of view, sent by the tester as business_pov.
  const POVS = ['we', 'i', 'business_name'];
  const pov = POVS.includes(req.body?.point_of_view) ? req.body.point_of_view : POVS.includes(req.body?.business_pov) ? req.body.business_pov : 'we';
  const tone = typeof req.body?.tone === 'string' && req.body.tone.trim() ? req.body.tone.trim().slice(0, 40)
    : typeof params!.niche_data?.preferred_tone === 'string' ? String(params!.niche_data.preferred_tone).slice(0, 40) : undefined;
  const seed = params!.seed !== undefined && /^-?\d+$/.test(params!.seed) ? Number(params!.seed) : undefined;
  const nicheDetails = params!.niche_data && typeof params!.niche_data === 'object'
    ? Object.entries(params!.niche_data).filter(([k]) => k !== 'preferred_tone').map(([k, v]) => `${k}: ${String(v)}`).join('; ')
    : '';

  try {
    const start = Date.now();
    console.log(`🧪 [v3] test chain: "${params!.seed_keyword}" (${params!.niche})`);
    const r = await runTestChain(
      {
        seed_keyword: params!.seed_keyword,
        niche: params!.niche,
        title: params!.title,
        post_size: variantFromWords(params!.nos_of_words ?? '1200 to 2400 words'),
        language: params!.content_lang,
        reach,
        target_town: reach === 'local' ? prof.locations_served?.[0] : undefined,
        business_name: prof.business_name,
        business_description: [prof.description, prof.own_words].filter(Boolean).join(' ') || undefined,
        stand_out: prof.differentiators?.join('; ') || undefined,
        ideal_client: prof.ideal_client,
        featured_service: params!.services_selected?.[0] ?? prof.services?.[0]?.name,
        business_pricing: [prof.price_range, nicheDetails].filter(Boolean).join('; ') || undefined,
        proof_level: req.body?.proof_level === 'regulated' ? 'regulated' : 'standard',
        tone,
        point_of_view: pov,
        cta: { text: params!.call_to_action ?? prof.call_to_action, url: params!.cta_url ?? prof.cta_url, phone: prof.phone },
        anything_else: params!.custom_instruction,
        pins: pins.pins,
        seed,
      },
      {
        searchData: (q) => lookupSearchData(q, liveSearchDataDeps()),
        title: (input) => runTitleStep(input, liveTitleDeps()),
        research: (q) => runResearch(q, { resolveInstructions: () => liveResearchInstructions() }),
        planner: (input) => runPlannerStep(input, livePlannerDeps()),
        generate: (input) => liveGenerateArticle(input, { runId: `iseo_test_${Date.now()}` }),
      },
    );
    const a = r.article;
    res.json({
      success: true,
      data: {
        title: r.title,
        content: a.content,
        meta_title: a.meta_title,
        meta_description: a.meta_description,
        faq: a.faq,
        faq_schema: a.faq_schema,
        blueprint: { ...a.picks, fingerprint: a.fingerprint },
        proof_level: a.proof_level,
        needs_review: a.needs_review,
        validator: a.validator,
        plan: r.plan,
        plan_fallback: r.plan_fallback,
        regulated: r.regulated,
        research: r.research,
        search_data: r.search_data,
        diagnostics: {
          prompts: r.prompts,
          blueprint_directive: a.messages.blueprint,
          niche_profile: a.messages.niche_profile,
          prompt_sources: [],
          profile_warnings: warnings,
          validator: a.validator,
          writer_json: a.writer_json,
          linked_sources: a.linked_sources,
        },
      },
      metadata: { method: 'claude-v3', timings: { ...r.timings, ...a.timings }, cost: a.cost, prompt_version: a.prompt_version, model: a.model, totalTime: Date.now() - start },
    });
  } catch (e) {
    console.error('❌ [v3] test chain error:', e);
    const ue = toV3UserError(e);
    res.status(ue.status).json({ success: false, error: e instanceof Error ? e.message : ue.message });
  }
});

/**
 * Register the six v3 prompt templates and seed a first active version for any that lack one.
 *
 * Idempotent and skip-only: a template with an active version is untouched, so this can never
 * clobber a prompt tuned in the panel. Safe to call from a button.
 */
router.post('/prompts/seed', requireAdmin, async (req: Request, res: Response) => {
  try {
    const mode = req.query?.mode === 'replace' || req.body?.mode === 'replace' ? 'replace' : 'skip';
    const report = await seedV3Prompts(undefined, { mode });
    const seeded = report.filter((r) => r.version === 'seeded').length;
    res.json({
      success: true,
      data: { report, seeded, total: report.length },
    });
  } catch (e) {
    console.error('❌ [v3] prompt seeding error:', e);
    res
      .status(500)
      .json({ success: false, error: e instanceof Error ? e.message : 'Seeding failed' });
  }
});

/** Back up the active value of every content_v3_* template as "pre-v3" (once). Activates nothing. */
router.post('/prompts/backup-pre-v3', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const legacy = ['content_v3_intelligence', 'content_v3_system', 'content_v3_humanize', 'content_v3_blueprint_directives', 'content_v3_seo_rules', 'content_v3_business_context'];
    const types = [...new Set([...legacy, ...v3DocPromptDefs().map((d) => d.templateType)])];
    const report = await new PromptManagementService().backupPreV3(types, 'admin-backup');
    res.json({ success: true, data: { report } });
  } catch (e) {
    console.error('❌ [v3] pre-v3 backup error:', e);
    res.status(500).json({ success: false, error: 'Backup failed' });
  }
});

/** Production gate item 2: active DB text vs the doc text, per doc-sourced prompt. Read-only. */
router.get('/prompts/check', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const report = await checkV3Prompts();
    res.json({ success: true, data: { report, all_equal: report.every((r) => r.status === 'equal') } });
  } catch (e) {
    console.error('❌ [v3] prompt check error:', e);
    res.status(500).json({ success: false, error: 'Check failed' });
  }
});

export default router;
