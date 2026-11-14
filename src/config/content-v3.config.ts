/**
 * Content v3 — the master switch, timeouts and the working values the design doc leaves open.
 *
 * TWO SWITCHES, BOTH REQUIRED. Content v3 runs only when CONTENT_V3_ENABLED is "true" here (server
 * env) AND the site's plugin setting "Use Content v3" is on. The plugin asks GET
 * /api/v1/content-v3/status and falls back to the v2 chain when this side is off, so turning the
 * env flag off is the rollback: every site goes back to v2 on its next request, with no data loss.
 *
 * ISEO_V3_KEYWORD_DATA (config/keyword-data.config.ts) keeps its own meaning and is independent.
 *
 * OPEN QUESTIONS STAY CONFIG. Anything docs/content-v3-prompt-drafts.md marks as an open question
 * or a working value is read from the environment with the doc's working value as the default, so
 * changing it after the 10-keyword test needs no deploy of new code. Every such value is listed in
 * .env.example and in docs/CONTENT_V3.md.
 */

export function contentV3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTENT_V3_ENABLED === 'true';
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export type V3Step = 'search_data' | 'title' | 'research' | 'planner' | 'writer' | 'meta';

export interface ContentV3Config {
  enabled: boolean;
  /** Attempts per model step where the doc says "up to 3 attempts". */
  maxAttempts: number;
  /** Wall-clock budget for ONE attempt of each step, in ms. */
  timeoutsMs: Record<V3Step, number>;
  /** Abandoned wizard sessions are purged after this many days (OPS5). */
  sessionTtlDays: number;
  /**
   * A1 (decision 14 Nov): factor per size for the word targets the Writer is given, because it
   * delivers ~95 / 70 / 55% of its targets on Small / Medium / Large. Numbers only; the wording of
   * the BODY line is the doc's. CONTENT_V3_TARGET_CALIBRATION_JSON, e.g. {"medium":1.3}.
   */
  targetCalibration: Record<'small' | 'medium' | 'large', number>;
  /** B-3: the paid article request's whole budget; kept below the plugin's 600 s HTTP timeout. */
  articleDeadlineMs: number;
  /** B-3: the title request's budget (plugin waits 240 s). CONTENT_V3_TITLE_DEADLINE_MS. */
  titleDeadlineMs: number;
  /** B-3: the approve request's budget (plugin waits 420 s). CONTENT_V3_APPROVE_DEADLINE_MS. */
  approveDeadlineMs: number;
}

export const DEFAULT_TARGET_CALIBRATION = { small: 1.0, medium: 1.3, large: 1.6 } as const;

/** Each size's factor from JSON, kept within 0.5–2.5; anything unreadable falls back to the default. */
export function targetCalibration(env: NodeJS.ProcessEnv = process.env): Record<'small' | 'medium' | 'large', number> {
  const out: Record<'small' | 'medium' | 'large', number> = { ...DEFAULT_TARGET_CALIBRATION };
  const raw = env.CONTENT_V3_TARGET_CALIBRATION_JSON;
  if (!raw || !raw.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const size of ['small', 'medium', 'large'] as const) {
      const v = Number(parsed?.[size]);
      if (Number.isFinite(v) && v >= 0.5 && v <= 2.5) out[size] = v;
    }
  } catch {
    // keep the defaults
  }
  return out;
}

/**
 * D: what one article may cost us before a warning is logged, per size (USD, all steps). Only a
 * warning: billing does not change. CONTENT_V3_COST_CEILING_USD_JSON, e.g. {"large":0.6}.
 */
export const DEFAULT_COST_CEILING_USD = { small: 0.25, medium: 0.35, large: 0.5 } as const;

export function costCeilingUsd(env: NodeJS.ProcessEnv = process.env): Record<'small' | 'medium' | 'large', number> {
  const out: Record<'small' | 'medium' | 'large', number> = { ...DEFAULT_COST_CEILING_USD };
  const raw = env.CONTENT_V3_COST_CEILING_USD_JSON;
  if (!raw || !raw.trim()) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const size of ['small', 'medium', 'large'] as const) {
      const v = Number(parsed?.[size]);
      if (Number.isFinite(v) && v > 0 && v <= 10) out[size] = v;
    }
  } catch {
    // keep the defaults
  }
  return out;
}

export function contentV3Config(env: NodeJS.ProcessEnv = process.env): ContentV3Config {
  return {
    enabled: contentV3Enabled(env),
    maxAttempts: intEnv(env, 'CONTENT_V3_MAX_ATTEMPTS', 3, 1, 3),
    timeoutsMs: {
      search_data: intEnv(env, 'CONTENT_V3_TIMEOUT_SEARCH_DATA_MS', 30_000, 1_000, 120_000),
      title: intEnv(env, 'CONTENT_V3_TIMEOUT_TITLE_MS', 60_000, 5_000, 300_000),
      research: intEnv(env, 'CONTENT_V3_TIMEOUT_RESEARCH_MS', 120_000, 5_000, 600_000),
      planner: intEnv(env, 'CONTENT_V3_TIMEOUT_PLANNER_MS', 90_000, 5_000, 300_000),
      writer: intEnv(env, 'CONTENT_V3_TIMEOUT_WRITER_MS', 300_000, 30_000, 900_000),
      meta: intEnv(env, 'CONTENT_V3_TIMEOUT_META_MS', 60_000, 5_000, 300_000),
    },
    sessionTtlDays: intEnv(env, 'CONTENT_V3_SESSION_TTL_DAYS', 7, 1, 90),
    targetCalibration: targetCalibration(env),
    articleDeadlineMs: intEnv(env, 'CONTENT_V3_ARTICLE_DEADLINE_MS', 480_000, 60_000, 570_000),
    titleDeadlineMs: intEnv(env, 'CONTENT_V3_TITLE_DEADLINE_MS', 200_000, 30_000, 230_000),
    approveDeadlineMs: intEnv(env, 'CONTENT_V3_APPROVE_DEADLINE_MS', 360_000, 60_000, 400_000),
  };
}
