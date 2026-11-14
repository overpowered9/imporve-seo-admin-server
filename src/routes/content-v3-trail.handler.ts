/**
 * GET /api/v1/content-v3/admin/trail?run=<session key>  (requireAdmin)
 *
 * D: everything stored about one wizard run, for support: the run ledger rows (status, credits,
 * step costs, timings, errors), the user_generations rows written for it (model, prompt versions,
 * what was billed, the validator verdict) and its post history row. Article text is left out;
 * the server log lines of the run are found by `run=<session key>` (see the runbook).
 *
 * Pure handler; content-v3.routes.ts does the live wiring.
 */
import { Router, type RequestHandler, type Request, type Response } from 'express';
import type { RunRow } from '../services/content-v3/runs.js';

export interface TrailDeps {
  auth: RequestHandler;
  runs: (run: string) => Promise<RunRow[]>;
  generations: (run: string) => Promise<Array<Record<string, unknown>>>;
  posts: (run: string) => Promise<Array<Record<string, unknown>>>;
}

const RUN_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** A JSONB value that may have been stored as a JSON string scalar. */
function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

export function createTrailRouter(deps: TrailDeps): Router {
  const router = Router();
  router.get('/admin/trail', deps.auth, async (req: Request, res: Response) => {
    const run = String(req.query.run ?? '').trim();
    if (!RUN_RE.test(run)) {
      return res.status(400).json({ success: false, error: 'invalid_request', message: 'run must be a wizard session key (iseo_tk_…).' });
    }
    const settle = async <T>(p: Promise<T>): Promise<T | { unavailable: string }> =>
      p.catch((err) => ({ unavailable: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
    const [runs, generations, posts] = await Promise.all([settle(deps.runs(run)), settle(deps.generations(run)), settle(deps.posts(run))]);
    return res.json({
      success: true,
      data: {
        run,
        log_query: `run=${run}`,
        // The stored answer (the article) is what a replay sends back; it is not repeated here.
        runs: Array.isArray(runs) ? runs.map(({ response, ...rest }) => ({ ...rest, has_stored_answer: response !== null && response !== undefined })) : runs,
        generations: Array.isArray(generations)
          ? generations.map((g) => {
              const m = obj(g.metadata);
              const v = obj(m.validator);
              return {
                id: g.id,
                user_id: g.user_id,
                website_id: g.website_id,
                type: g.type,
                status: g.status,
                created_at: g.created_at,
                processing_time_ms: g.processing_time_ms,
                model: m.model ?? null,
                prompt_version: m.prompt_version ?? null,
                prompt_versions: m.prompt_versions ?? null,
                billed: m.billed ?? null,
                needs_review: m.needs_review ?? null,
                validator: Object.keys(v).length ? { passed: v.passed, errors: v.errors, warnings: v.warnings, word_count: v.word_count } : null,
              };
            })
          : generations,
        posts: Array.isArray(posts) ? posts.map(({ validator, ...rest }) => ({ ...rest, validator_passed: obj(validator).passed ?? null })) : posts,
      },
    });
  });
  return router;
}
