/**
 * Daily Keyword Generator allowance — the counter behind config/keyword-limits.config.ts.
 *
 * One row per (user, UTC day) in keyword_daily_usage (migration 019). The allowance is per
 * ACCOUNT, not per website: the plan is the account's, so connecting a second site does not
 * double it.
 *
 * ── WHY A RESERVATION, NOT A COUNT ──────────────────────────────────────────
 * Counting today's user_generations rows before generating would be a read-then-write race: two
 * clicks landing together both read 9 of 10 and both run. Instead the slot is taken up front by a
 * single conditional upsert that only increments while `used < limit`, so Postgres serialises
 * concurrent requests on the row and exactly one of them gets the last slot. A run that then fails
 * gives its slot back with releaseKeywordGeneration.
 */
import sql from '../data/db.js';
import type { KeywordAllowancePlan } from '../config/keyword-limits.config.js';

export interface KeywordReservation {
  /** Runs used today, including this one. */
  used: number;
  /** The UTC day the slot was taken from, as YYYY-MM-DD — released against this exact day. */
  usageDate: string;
}

/** The plan fields the allowance needs, in one query (getUserWithPlan selects u.* and no price). */
export const getKeywordPlanContext = async (userId: number): Promise<KeywordAllowancePlan> => {
  const rows = await sql`
    SELECT sp.slug, sp.price_cents
    FROM users u
    LEFT JOIN subscription_plans sp ON sp.id = u.plan_id
    WHERE u.id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  return {
    slug: row?.slug ?? null,
    isPaid: !!row && Number(row.price_cents) > 0,
  };
};

/**
 * Take one of today's slots. Returns null when the allowance is already spent.
 *
 * `usage_date` is returned as text so the day is carried back verbatim: a run that starts at
 * 23:59:59 UTC and fails after midnight must give back yesterday's slot, not today's.
 */
export const reserveKeywordGeneration = async (
  userId: number,
  limit: number,
): Promise<KeywordReservation | null> => {
  if (!(limit > 0)) return null;
  const rows = await sql`
    INSERT INTO keyword_daily_usage (user_id, usage_date, used)
    VALUES (${userId}, (NOW() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (user_id, usage_date) DO UPDATE
      SET used = keyword_daily_usage.used + 1, updated_at = NOW()
      WHERE keyword_daily_usage.used < ${limit}
    RETURNING used, usage_date::text AS usage_date
  `;
  const row = rows[0];
  return row ? { used: Number(row.used), usageDate: String(row.usage_date) } : null;
};

/** Give back a slot taken by reserveKeywordGeneration for a run that did not deliver keywords. */
export const releaseKeywordGeneration = async (userId: number, usageDate: string): Promise<void> => {
  await sql`
    UPDATE keyword_daily_usage
    SET used = GREATEST(used - 1, 0), updated_at = NOW()
    WHERE user_id = ${userId} AND usage_date = ${usageDate}::date
  `;
};
