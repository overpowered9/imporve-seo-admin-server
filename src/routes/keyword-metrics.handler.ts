/**
 * POST /api/v1/generate/keywords/metrics — Option A, the keyword metrics API.
 *
 * Contract (the plugin's keyword tool is built against this):
 *   Request   { keywords: string[] (1..100), location_code?: number = 2840, language_code?: string = "en" }
 *   Response  { success: true, items: [{ keyword, search_volume, keyword_difficulty, intent, scope, fetched_at }],
 *               cached_count: number, cost_usd: number }
 *
 * The response is the contract shape with `success: true` added at the top level (decided
 * 2026-11-11): a plugin built against the contract reads `items` directly, and the repo's generic
 * success check still works.
 *
 * Every number comes from the server cache or DataForSEO through the keyword data service. Nothing
 * in the request body is ever echoed as a metric.
 *
 * CREDITS. KEYWORD_METRICS_CREDIT_COST (default 0) is charged with the same atomic reserve/refund
 * pair the v2 money paths use: reserve BEFORE the provider call, refund if it fails. At 0 no credit
 * code runs at all. Whether to charge is an open product decision; this route only honours the
 * config. No user_generations row is written — the live table's `type` constraint is unverified
 * (see content-v3.routes.ts) and a metrics lookup is not a generation.
 *
 * This file is the pure handler: every dependency is injected, so the HTTP tests run it with a fake
 * auth, a fake service and fake credit functions. keyword-metrics.routes.ts does the live wiring.
 */
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { KEYWORD_DATA_DEFAULTS } from '../config/keyword-data.config.js';
import { DataForSeoError } from '../services/keyword-data/dataforseo.client.js';
import {
  KeywordDataBudgetError,
  KeywordDataNotConfiguredError,
  type KeywordDataService,
} from '../services/keyword-data/keyword-data.service.js';

export const locationCodeSchema = z
  .number({ invalid_type_error: 'location_code must be a number' })
  .int('location_code must be an integer')
  .positive('location_code must be a positive DataForSEO location code')
  .default(KEYWORD_DATA_DEFAULTS.locationCode);

export const languageCodeSchema = z
  .string({ invalid_type_error: 'language_code must be a string' })
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'language_code must be a two-letter code such as "en"')
  .transform((s) => s.toLowerCase())
  .default(KEYWORD_DATA_DEFAULTS.languageCode);

export const metricsRequestSchema = z.object({
  keywords: z
    .array(
      z
        .string({ invalid_type_error: 'each keyword must be a string' })
        .trim()
        .min(1, 'a keyword must not be empty')
        .max(200, 'a keyword must be at most 200 characters'),
      { required_error: 'keywords is required', invalid_type_error: 'keywords must be an array of strings' },
    )
    .min(1, 'keywords must contain at least 1 keyword')
    .max(KEYWORD_DATA_DEFAULTS.metricsMaxKeywords, `keywords must contain at most ${KEYWORD_DATA_DEFAULTS.metricsMaxKeywords} keywords`),
  location_code: locationCodeSchema,
  language_code: languageCodeSchema,
});

export type MetricsRequest = z.infer<typeof metricsRequestSchema>;

/** The 400 body for a zod failure: first message as `error`, the full flatten() as `details`. */
export function validationErrorBody(error: z.ZodError) {
  const first = error.issues[0];
  const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
  return {
    success: false as const,
    error: `${where}${first?.message ?? 'invalid request'}`,
    code: 'VALIDATION_ERROR' as const,
    details: error.flatten(),
  };
}

export interface MappedError {
  status: number;
  body: { success: false; error: string; code: string; kind?: string };
  retryAfterSeconds?: number;
}

/**
 * Keyword data failures → HTTP. Provider wording is kept generic on the wire (the detailed message
 * goes to the log); the `code` is the stable thing a client may branch on.
 */
export function keywordDataErrorResponse(err: unknown): MappedError | null {
  if (err instanceof KeywordDataNotConfiguredError) {
    return { status: 503, body: { success: false, error: 'Keyword data is not configured on this server.', code: 'KEYWORD_DATA_NOT_CONFIGURED' } };
  }
  if (err instanceof KeywordDataBudgetError) {
    return { status: 504, body: { success: false, error: 'Keyword data provider timed out.', code: 'KEYWORD_DATA_TIMEOUT' } };
  }
  if (err instanceof DataForSeoError) {
    switch (err.kind) {
      case 'timeout':
        return { status: 504, body: { success: false, error: 'Keyword data provider timed out.', code: 'KEYWORD_DATA_TIMEOUT', kind: err.kind } };
      case 'bad_request':
        return {
          status: 400,
          body: { success: false, error: 'Keyword data provider rejected the request; check location_code and language_code.', code: 'KEYWORD_DATA_BAD_REQUEST', kind: err.kind },
        };
      case 'rate_limit':
        return {
          status: 503,
          body: { success: false, error: 'Keyword data provider is rate limiting; try again shortly.', code: 'KEYWORD_DATA_RATE_LIMITED', kind: err.kind },
          retryAfterSeconds: 5,
        };
      case 'auth':
      case 'payment':
        return { status: 503, body: { success: false, error: 'Keyword data provider is unavailable.', code: 'KEYWORD_DATA_PROVIDER_UNAVAILABLE', kind: err.kind } };
      default:
        return { status: 502, body: { success: false, error: 'Keyword data provider error.', code: 'KEYWORD_DATA_PROVIDER_ERROR', kind: err.kind } };
    }
  }
  return null;
}

export interface KeywordMetricsHandlerDeps {
  /** Lazy, so the live service is built after dotenv has loaded. */
  service: () => KeywordDataService;
  auth: RequestHandler;
  rateLimit: RequestHandler;
  /** Credits per request. Read per call so a test can flip it. */
  creditCost: () => number;
  reserveCredits: (userId: number, amount: number, reason: string, websiteId?: number) => Promise<{ ok: boolean }>;
  refundCredits: (userId: number, amount: number, reason: string, websiteId?: number) => Promise<void>;
  /** Optional: what the user holds, for the 402 message. */
  liveBalance?: (userId: number) => Promise<number>;
  log?: (line: string) => void;
  now?: () => number;
}

export function createKeywordMetricsRouter(deps: KeywordMetricsHandlerDeps): Router {
  const { log = (line) => console.log(line), now = () => Date.now() } = deps;
  const router = Router();

  router.post('/metrics', deps.auth, deps.rateLimit, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = metricsRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(validationErrorBody(parsed.error));

    const { keywords, location_code, language_code } = parsed.data;
    const userId = Number(req.user?.id);
    const websiteId: number | undefined = req.website?.id ?? undefined;

    // ── Credits (0 by default: no credit code runs) ─────────────────────────
    const cost = deps.creditCost();
    let charged = 0;
    if (cost > 0) {
      const reservation = await deps.reserveCredits(
        userId,
        cost,
        `Keyword metrics (${keywords.length} keyword${keywords.length === 1 ? '' : 's'})`,
        websiteId,
      );
      if (!reservation.ok) {
        let available: number | null = null;
        if (deps.liveBalance) available = await deps.liveBalance(userId).catch(() => null);
        return res.status(402).json({
          success: false,
          error:
            available === null
              ? `Not enough credits: this needs ${cost}.`
              : `Not enough credits: this needs ${cost} and you have ${available}.`,
          code: 'INSUFFICIENT_CREDITS',
          required: cost,
          ...(available === null ? {} : { available, shortfall: Math.max(0, cost - available) }),
        });
      }
      charged = cost;
    }

    const started = now();
    try {
      const r = await deps.service().getMetrics(keywords, location_code, language_code);
      log(
        `[keyword-metrics] user=${userId} website=${websiteId ?? '-'} requested=${keywords.length} ` +
          `unique=${r.items.length} cached=${r.cached_count} cost_usd=${r.cost_usd} credits=${charged} ms=${now() - started}`,
      );
      return res.json({
        success: true,
        items: r.items,
        cached_count: r.cached_count,
        cost_usd: r.cost_usd,
        ...(charged > 0 ? { credits: { charged } } : {}),
      });
    } catch (err) {
      if (charged > 0) {
        // The user paid for a lookup that did not happen — give it back before answering.
        await deps.refundCredits(userId, charged, 'Refund — keyword metrics lookup failed', websiteId).catch(() => undefined);
      }
      const detail = err instanceof Error ? err.message : String(err);
      log(`[keyword-metrics] user=${userId} failed after ${now() - started} ms: ${detail}`);
      const mapped = keywordDataErrorResponse(err);
      if (mapped) {
        if (mapped.retryAfterSeconds) res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
        return res.status(mapped.status).json(mapped.body);
      }
      return res.status(500).json({ success: false, error: 'Failed to fetch keyword metrics' });
    }
  });

  return router;
}
