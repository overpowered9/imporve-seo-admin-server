/**
 * Rank tracker admin API (handler only; rank-tracker.routes.ts does the live wiring).
 *
 *   GET    /api/v1/rank-tracker/targets            requireAdmin. Free.
 *   POST   /api/v1/rank-tracker/targets            requireAdmin. Free (no check is run).
 *   DELETE /api/v1/rank-tracker/targets/:id        requireAdmin. Free.
 *   GET    /api/v1/rank-tracker/targets/:id/history requireAdmin. Free.
 *   POST   /api/v1/rank-tracker/targets/:id/check  requireAdmin. ONE paid SERP call.
 *   POST   /api/v1/rank-tracker/run                requireAdmin. Paid, capped.
 *
 * Adding a target deliberately does NOT check it. Adding is free and reversible; spending is an
 * explicit act. The scheduler picks a new target up on its next tick, or the user presses Check.
 */
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { keywordDataErrorResponse, validationErrorBody } from './keyword-metrics.handler.js';
import type { createRankTracker } from '../services/keyword-data/rank-tracker.service.js';

export type RankTracker = ReturnType<typeof createRankTracker>;

export const addTargetSchema = z.object({
  domain: z
    .string({ required_error: 'domain is required' })
    .trim()
    .min(3, 'domain must not be empty')
    .max(253, 'domain must be at most 253 characters'),
  keyword: z
    .string({ required_error: 'keyword is required' })
    .trim()
    .min(1, 'keyword must not be empty')
    .max(200, 'keyword must be at most 200 characters'),
  location_code: z.number().int().positive().default(2840),
  language_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'language_code must be a two-letter code such as "en"')
    .transform((s) => s.toLowerCase())
    .default('en'),
  label: z.string().trim().max(200).nullable().optional(),
});

export const runSchema = z.object({
  stale_hours: z.number().int().min(1).max(24 * 90).optional(),
  max: z.number().int().min(1).max(200).optional(),
});

const idSchema = z.coerce.number().int().positive();

export interface RankTrackerDeps {
  auth: RequestHandler;
  tracker: () => RankTracker;
  configured: () => boolean;
  log?: (line: string) => void;
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
  log(`[rank-tracker] unhandled: ${message}`);
  if (/is required|no rank target/.test(message)) {
    res.status(400).json({ success: false, error: message, code: 'VALIDATION_ERROR' });
    return;
  }
  res.status(500).json({ success: false, error: 'Rank tracker failed.', code: 'RANK_TRACKER_ERROR' });
}

export function createRankTrackerRouter(deps: RankTrackerDeps): Router {
  const { auth, tracker, configured, log = (l: string) => console.log(l) } = deps;
  const router = Router();

  router.get('/targets', auth, async (_req, res) => {
    try {
      res.json({ success: true, targets: await tracker().listTargets() });
    } catch (err) {
      fail(res, err, log);
    }
  });

  router.post('/targets', auth, async (req, res) => {
    const parsed = addTargetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(validationErrorBody(parsed.error));
      return;
    }
    try {
      res.json({ success: true, target: await tracker().addTarget(parsed.data) });
    } catch (err) {
      fail(res, err, log);
    }
  });

  router.delete('/targets/:id', auth, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json(validationErrorBody(id.error));
      return;
    }
    try {
      await tracker().removeTarget(id.data);
      res.json({ success: true });
    } catch (err) {
      fail(res, err, log);
    }
  });

  router.get('/targets/:id/history', auth, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json(validationErrorBody(id.error));
      return;
    }
    try {
      res.json({ success: true, history: await tracker().history(id.data) });
    } catch (err) {
      fail(res, err, log);
    }
  });

  // The two paid routes. Both need credentials; everything above works without them.
  router.post('/targets/:id/check', auth, async (req, res) => {
    if (!configured()) {
      res.status(503).json(NOT_CONFIGURED);
      return;
    }
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json(validationErrorBody(id.error));
      return;
    }
    try {
      res.json({ success: true, result: await tracker().checkById(id.data) });
    } catch (err) {
      fail(res, err, log);
    }
  });

  router.post('/run', auth, async (req, res) => {
    if (!configured()) {
      res.status(503).json(NOT_CONFIGURED);
      return;
    }
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(validationErrorBody(parsed.error));
      return;
    }
    try {
      const r = await tracker().runDue({ staleHours: parsed.data.stale_hours, max: parsed.data.max });
      res.json({ success: true, ...r });
    } catch (err) {
      fail(res, err, log);
    }
  });

  return router;
}
