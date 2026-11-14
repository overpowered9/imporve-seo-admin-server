/**
 * B-5: per-account daily allowance for the FREE v3 steps (title, town check, approve), which cost
 * us DataForSEO, Perplexity and model money but no credits. The allowance grows with the paid
 * articles delivered that day, so normal use (approve → generate, bulk included) never meets it,
 * while free steps called over and over without an article are capped:
 *
 *   allowed uses of a step today = base + per_article × articles delivered today
 *   defaults: title 60 + 5×, town check 100 + 10×, approve 30 + 3×
 *   CONTENT_V3_FREE_STEP_LIMITS_JSON overrides, e.g. {"approve":{"base":50,"per_article":3}}
 *
 * A refused request is not counted, so the next article lifts the cap straight away.
 * Counts live in content_v3_quota (migration 024, UTC days). Without the table the guard lets
 * requests through and logs once (the per-minute limiter still applies).
 */
import type { RequestHandler, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../middleware/apiAuth.middleware.js';
import type { SqlLike } from '../keyword-data/keyword-data-cache.js';
import { v3Error, v3ErrorBody } from './user-errors.js';

export type FreeStep = 'title' | 'town_check' | 'approve';
export interface FreeStepLimit {
  base: number;
  per_article: number;
}

export const DEFAULT_FREE_STEP_LIMITS: Record<FreeStep, FreeStepLimit> = {
  title: { base: 60, per_article: 5 },
  town_check: { base: 100, per_article: 10 },
  approve: { base: 30, per_article: 3 },
};

export function freeStepLimits(env: NodeJS.ProcessEnv = process.env): Record<FreeStep, FreeStepLimit> {
  const out: Record<FreeStep, FreeStepLimit> = structuredClone(DEFAULT_FREE_STEP_LIMITS);
  const raw = env.CONTENT_V3_FREE_STEP_LIMITS_JSON;
  if (!raw || !raw.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<FreeStepLimit>>;
    for (const step of Object.keys(out) as FreeStep[]) {
      const p = parsed?.[step];
      if (!p || typeof p !== 'object') continue;
      const base = Number(p.base);
      const per = Number(p.per_article);
      if (p.base !== undefined && Number.isFinite(base) && base >= 0) out[step].base = Math.round(base);
      if (p.per_article !== undefined && Number.isFinite(per) && per >= 0) out[step].per_article = per;
    }
  } catch {
    // keep the defaults
  }
  return out;
}

/** Uses of a step allowed today, given the articles delivered today. */
export function allowedToday(limit: FreeStepLimit, articles: number): number {
  return Math.floor(limit.base + limit.per_article * Math.max(0, articles));
}

export interface StepTake {
  allowed: boolean;
  /** Today's count for the step after this request (unchanged when refused). */
  used: number;
  articles: number;
}

export interface QuotaStore {
  /** Counts one use of a free step today if the allowance has room; a refusal changes nothing. */
  takeStep(userId: number, step: FreeStep, limit: FreeStepLimit): Promise<StepTake>;
  /** Counts one delivered article today; returns today's article count. */
  countArticle(userId: number): Promise<number>;
  /** Deletes counters older than `days` days; returns how many rows went. */
  purge(days: number): Promise<number>;
}

const utcToday = () => new Date().toISOString().slice(0, 10);

export function createMemoryQuotaStore(today: () => string = utcToday): QuotaStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const key = (userId: number, kind: string) => `${userId}|${today()}|${kind}`;
  return {
    counts,
    async takeStep(userId, step, limit) {
      const articles = counts.get(key(userId, 'article')) ?? 0;
      const current = counts.get(key(userId, step)) ?? 0;
      if (current + 1 > allowedToday(limit, articles)) return { allowed: false, used: current, articles };
      counts.set(key(userId, step), current + 1);
      return { allowed: true, used: current + 1, articles };
    },
    async countArticle(userId) {
      const n = (counts.get(key(userId, 'article')) ?? 0) + 1;
      counts.set(key(userId, 'article'), n);
      return n;
    },
    async purge(days) {
      const cutoff = new Date(Date.parse(`${today()}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
      let n = 0;
      for (const k of [...counts.keys()]) {
        if (k.split('|')[1] < cutoff) {
          counts.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}

export function createPostgresQuotaStore(sql: SqlLike): QuotaStore {
  return {
    async takeStep(userId, step, limit) {
      const a = await sql`SELECT count FROM content_v3_quota WHERE user_id = ${userId} AND day = CURRENT_DATE AND kind = 'article'`;
      const articles = Number(a[0]?.count ?? 0);
      const allowed = allowedToday(limit, articles);
      if (allowed < 1) return { allowed: false, used: 0, articles };
      // The update only happens while the count is below the allowance, so a refusal (no row
      // returned) leaves the counter where it was. Concurrent requests serialise on the row.
      const rows = await sql`
        INSERT INTO content_v3_quota (user_id, day, kind, count) VALUES (${userId}, CURRENT_DATE, ${step}, 1)
        ON CONFLICT (user_id, day, kind) DO UPDATE SET count = content_v3_quota.count + 1
          WHERE content_v3_quota.count < ${allowed}
        RETURNING count
      `;
      if (!rows.length) return { allowed: false, used: allowed, articles };
      return { allowed: true, used: Number(rows[0].count), articles };
    },
    async countArticle(userId) {
      const rows = await sql`
        INSERT INTO content_v3_quota (user_id, day, kind, count) VALUES (${userId}, CURRENT_DATE, 'article', 1)
        ON CONFLICT (user_id, day, kind) DO UPDATE SET count = content_v3_quota.count + 1
        RETURNING count
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async purge(days) {
      const rows = await sql`DELETE FROM content_v3_quota WHERE day < CURRENT_DATE - ${days}::int RETURNING 1`;
      return rows.length;
    },
  };
}

export const QUOTA_MESSAGE =
  "You've used today's allowance for this step. It grows with every article you generate and resets tomorrow.";

/** Express guard for one free step. Fails open (logged once) when the quota table is missing. */
export function freeStepGuard(
  step: FreeStep,
  quota: () => Promise<QuotaStore>,
  opts: { limits?: Record<FreeStep, FreeStepLimit>; log?: (line: string) => void } = {},
): RequestHandler {
  let warned = false;
  const log = opts.log ?? ((l: string) => console.log(l));
  const limits = opts.limits ?? freeStepLimits();
  return async (req, res: Response, next: NextFunction) => {
    const userId = Number((req as AuthenticatedRequest).user?.id);
    if (!Number.isFinite(userId) || userId <= 0) return next();
    try {
      const r = await (await quota()).takeStep(userId, step, limits[step]);
      if (!r.allowed) {
        log(`[content-v3] daily allowance reached user=${userId} step=${step} used=${r.used} articles=${r.articles}`);
        return res.status(429).json(v3ErrorBody(v3Error('rate_limited', QUOTA_MESSAGE)));
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        log(`[content-v3] quota unavailable — free steps not capped: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
    }
    return next();
  };
}
