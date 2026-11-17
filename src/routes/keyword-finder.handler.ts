/**
 * The Keyword Finder admin API (handler only; keyword-finder.routes.ts does the live wiring).
 *
 *   GET  /api/v1/keyword-finder/locations?country=us&q=austin   requireAdmin. Free, cached.
 *   POST /api/v1/keyword-finder/discover                        requireAdmin. Paid.
 *
 * Admin-only on purpose. This is the panel where the tool is proven and tuned before any of it is
 * exposed to a plugin site: every call spends DataForSEO money, and the thresholds behind the
 * traffic lights are still being calibrated. The plugin-facing route comes after that, with its
 * own auth and its own credit decision.
 *
 * Error mapping is shared with the metrics route so a client sees the same `code` for the same
 * provider failure on either endpoint.
 */
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { languageCodeSchema, keywordDataErrorResponse, validationErrorBody } from './keyword-metrics.handler.js';
import type { FinderMode, FinderResult } from '../services/keyword-data/keyword-finder.service.js';
import { FINDER_DEFAULTS } from '../services/keyword-data/keyword-finder.service.js';
import type { GeoService, GeoStep } from '../services/keyword-data/keyword-geo.service.js';

const countryIsoSchema = z
  .string({ required_error: 'country is required', invalid_type_error: 'country must be a string' })
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'country must be a two-letter ISO code such as "us"')
  .transform((s) => s.toLowerCase());

export const discoverRequestSchema = z.object({
  seed: z
    .string({ required_error: 'seed is required', invalid_type_error: 'seed must be a string' })
    .trim()
    .min(1, 'seed must not be empty')
    .max(200, 'seed must be at most 200 characters'),
  country_iso: countryIsoSchema.default('us'),
  /**
   * Optional. Omit for national figures. A town or state code makes the volumes local, with the
   * city -> state -> country ladder behind it.
   */
  location_code: z
    .number({ invalid_type_error: 'location_code must be a number' })
    .int('location_code must be an integer')
    .positive('location_code must be a positive Google location code')
    .optional(),
  language_code: languageCodeSchema,
  mode: z.enum(['list', 'recommend'], { invalid_type_error: 'mode must be "list" or "recommend"' }).default('list'),
  /** Opt-in and paid: one SERP call per checked row. Never on by default. */
  serp_check: z.enum(['off', 'top'], { invalid_type_error: 'serp_check must be "off" or "top"' }).default('off'),
  limit: z
    .number({ invalid_type_error: 'limit must be a number' })
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(FINDER_DEFAULTS.maxLimit, `limit must be at most ${FINDER_DEFAULTS.maxLimit}`)
    .optional(),
});

export const locationsQuerySchema = z.object({
  country: countryIsoSchema.default('us'),
  q: z.string().trim().min(1, 'q must not be empty').max(100, 'q must be at most 100 characters'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface KeywordFinderDeps {
  auth: RequestHandler;
  /** Lazy so the live services are built after dotenv has loaded. */
  finder: () => { discover: (params: DiscoverCall) => Promise<FinderResult> };
  geo: () => GeoService;
  /** False when DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are absent. */
  configured: () => boolean;
  log?: (line: string) => void;
}

export interface DiscoverCall {
  seed: string;
  country_iso: string;
  country_location_code: number;
  location_code?: number;
  language_code: string;
  mode: FinderMode;
  limit?: number;
  serp_check: 'off' | 'top';
}

const NOT_CONFIGURED = {
  success: false as const,
  error: 'Keyword data is not configured on this server.',
  code: 'KEYWORD_DATA_NOT_CONFIGURED' as const,
};

function fail(res: Response, err: unknown, log: (l: string) => void): void {
  const mapped = keywordDataErrorResponse(err);
  if (mapped) {
    if (mapped.retryAfterSeconds) res.set('Retry-After', String(mapped.retryAfterSeconds));
    res.status(mapped.status).json(mapped.body);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log(`[keyword-finder] unhandled: ${message}`);
  // A bad location code is the one user-correctable error that reaches here, and it names itself.
  if (/not a Google Ads location|no country row/.test(message)) {
    res.status(400).json({ success: false, error: message, code: 'VALIDATION_ERROR' });
    return;
  }
  res.status(500).json({ success: false, error: 'Keyword finder failed.', code: 'KEYWORD_FINDER_ERROR' });
}

export function createKeywordFinderRouter(deps: KeywordFinderDeps): Router {
  const { auth, finder, geo, configured, log = (l: string) => console.log(l) } = deps;
  const router = Router();

  router.get('/locations', auth, async (req, res) => {
    if (!configured()) {
      res.status(503).json(NOT_CONFIGURED);
      return;
    }
    const parsed = locationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(validationErrorBody(parsed.error));
      return;
    }
    try {
      const found: GeoStep[] = await geo().searchLocations(parsed.data.country, parsed.data.q, parsed.data.limit);
      res.json({ success: true, locations: found });
    } catch (err) {
      fail(res, err, log);
    }
  });

  router.post('/discover', auth, async (req, res) => {
    if (!configured()) {
      res.status(503).json(NOT_CONFIGURED);
      return;
    }
    const parsed = discoverRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(validationErrorBody(parsed.error));
      return;
    }
    const body = parsed.data;
    try {
      // Labs takes a country code, so it is resolved here rather than trusted from the request:
      // a caller that could choose it could point a "national" figure at the wrong nation.
      const countryCode = await geo().countryLocationCode(body.country_iso);
      const result = await finder().discover({
        seed: body.seed,
        country_iso: body.country_iso,
        country_location_code: countryCode,
        location_code: body.location_code,
        language_code: body.language_code,
        mode: body.mode,
        limit: body.limit,
        serp_check: body.serp_check,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      fail(res, err, log);
    }
  });

  return router;
}
