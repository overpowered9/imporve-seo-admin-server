/**
 * Keyword data (DataForSEO Labs) configuration — Option A metrics API and Option B v3 integration.
 *
 * ENV (all optional; the feature degrades rather than aborting boot):
 *
 *   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD   Basic-auth credentials. Read through
 *                                           dataForSeoCredentials() and handed straight to the
 *                                           client; never logged, never echoed in a response.
 *                                           Missing → keyword data is "not configured": the
 *                                           metrics endpoint answers 503 and the Title/Planner
 *                                           steps run exactly as without the flag.
 *   ISEO_V3_KEYWORD_DATA                    Option B master switch. Only the literal "true"
 *                                           turns it on, and a request must ALSO send
 *                                           use_keyword_data: true (see keywordDataEffective).
 *   KEYWORD_METRICS_CREDIT_COST             ISEO credits charged per metrics request. Default 0
 *                                           (free). Whether and how much to charge is an open
 *                                           product decision; nothing here decides it.
 *
 * ── WHY THIS IS NOT IN credits.config.ts ────────────────────────────────────
 * credits.config.ts throws at import on a missing key so a deploy can never price an article at
 * zero by accident. The metrics cost defaults to zero BY DECISION (open until product decides), so
 * a missing key is the expected state, not a misconfiguration. It follows keyword-limits.config.ts
 * instead: pure functions with `env` as a parameter so tests do not mutate process.env, and a
 * malformed value falls back to the default with a warning rather than refusing to boot.
 */

import dotenv from 'dotenv';

// Self-loading, like credits.config.ts: index.ts calls dotenv.config() in its module body, which
// runs AFTER the route imports that pull this file in. Idempotent.
dotenv.config();

/** Product constants. Not env-tunable in v1; listed in the final report as defaults. */
export const KEYWORD_DATA_DEFAULTS = Object.freeze({
  /** DataForSEO location code for the United States. */
  locationCode: 2840,
  languageCode: 'en',
  /** How long a fetched keyword stays valid in the cache. */
  cacheTtlDays: 30,
  /** Overall budget for a cache-miss fetch inside the Title/Planner steps. */
  fetchBudgetMs: 8000,
  /** Related keywords shown to the Title step. */
  titleRelatedLimit: 10,
  /** Related keywords shown to the Planner step, and how many are fetched and cached per seed. */
  plannerRelatedLimit: 30,
  /** Contract: 1..100 keywords per metrics request. */
  metricsMaxKeywords: 100,
  /** Per-user, per-minute ceilings. Lower than /auxiliary's 120 because each call spends money. */
  metricsRateLimitPerMinute: 30,
  prefetchRateLimitPerMinute: 30,
});

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

/** Credentials from env, or null when either half is missing. The values are never logged. */
export function dataForSeoCredentials(env: NodeJS.ProcessEnv = process.env): DataForSeoCredentials | null {
  const login = (env.DATAFORSEO_LOGIN ?? '').trim();
  const password = (env.DATAFORSEO_PASSWORD ?? '').trim();
  if (!login || !password) return null;
  return { login, password };
}

export function keywordDataConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return dataForSeoCredentials(env) !== null;
}

/** Option B master switch. Only the exact string "true" counts. */
export function keywordDataFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ISEO_V3_KEYWORD_DATA === 'true';
}

/**
 * Option B is EFFECTIVE for one request only when the env flag is on AND the request opted in with
 * `use_keyword_data: true` (a boolean, not a truthy string). Anything else behaves exactly as today.
 */
export function keywordDataEffective(useKeywordData: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return keywordDataFlagOn(env) && useKeywordData === true;
}

/**
 * Credits per metrics request. A clean non-negative integer, else the default (0).
 *
 * Same strictness as keyword-limits.config.ts: '', '1.5' and '-3' are malformed, not "almost
 * right". A malformed value is reported by `parseKeywordMetricsCreditCost().warning` so the boot
 * log can say so; it does not abort boot because the default is already the decided v1 behaviour.
 */
export function parseKeywordMetricsCreditCost(raw: string | undefined): { cost: number; warning: string | null } {
  if (raw == null) return { cost: 0, warning: null };
  const s = raw.trim();
  if (s === '') return { cost: 0, warning: null };
  if (!/^\d+$/.test(s)) {
    return {
      cost: 0,
      warning: `KEYWORD_METRICS_CREDIT_COST must be a whole number of credits (got "${raw}"); charging 0`,
    };
  }
  return { cost: parseInt(s, 10), warning: null };
}

export function keywordMetricsCreditCost(env: NodeJS.ProcessEnv = process.env): number {
  return parseKeywordMetricsCreditCost(env.KEYWORD_METRICS_CREDIT_COST).cost;
}

/** Resolved once at boot for the live process, with the one-line warning if the value was malformed. */
const bootParse = parseKeywordMetricsCreditCost(process.env.KEYWORD_METRICS_CREDIT_COST);
if (bootParse.warning) console.warn(`⚠️  ${bootParse.warning}`);
export const KEYWORD_METRICS_CREDIT_COST: number = bootParse.cost;
