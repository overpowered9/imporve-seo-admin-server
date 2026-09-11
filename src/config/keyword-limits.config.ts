/**
 * Keyword Generator daily allowance — how many keyword-generation RUNS a plan gets per UTC day.
 *
 *   Free Trial / Free (slug `free`)   10
 *   Grow              (slug `basic`)  20
 *   Optimize          (slug `starter`) 50
 *   Scale             (slug `pro`)    50
 *
 * A run is one successful POST /generate/generatekeyword, however many keywords it returns. Runs
 * that fail or come back empty are handed back (see the route), so they never cost a use.
 *
 * ── WHY THIS IS ITS OWN, DATABASE-FREE MODULE ───────────────────────────────
 * Same reason as models/trial.ts: the rules are pure, and keeping them away from the pool means
 * they can be unit-tested without DATABASE_URL. Enforcement lives in models/keyword-usage.ts.
 *
 * ── WHY THIS DOES NOT FAIL CLOSED LIKE credits.config.ts ────────────────────
 * A missing or malformed value here cannot give work away — every run is still credit-charged —
 * so an override that does not parse falls back to the product default instead of refusing to
 * boot. The env keys are optional and exist for tuning without a code change.
 *
 * Day boundaries are UTC, matching the rest of the server (see notification-jobs.ts).
 */

/** Stable contract with the plugin: it matches on this, never on the English message. */
export const KEYWORD_DAILY_LIMIT_CODE = 'KEYWORD_DAILY_LIMIT_REACHED';

/**
 * Sent as `error`. Plugin builds that predate the allowance modal `alert()` the server's `error`
 * for any status they do not recognise, so this is also what they show — which is why it is the
 * full customer-facing sentence rather than a terse code description.
 */
export const KEYWORD_DAILY_LIMIT_MESSAGE =
  'Your daily Keyword Generator tool allowance is exhausted. You will be able to use the Keyword Generator tool again tomorrow.';

/** Keyed by subscription_plans.slug — the real slugs, which do not match the product names. */
const DEFAULT_LIMITS = Object.freeze({ free: 10, basic: 20, starter: 50, pro: 50 });
type AllowanceTier = keyof typeof DEFAULT_LIMITS;

const ENV_KEYS: Readonly<Record<AllowanceTier, string>> = Object.freeze({
  free: 'KEYWORD_DAILY_LIMIT_FREE',
  basic: 'KEYWORD_DAILY_LIMIT_BASIC',
  starter: 'KEYWORD_DAILY_LIMIT_STARTER',
  pro: 'KEYWORD_DAILY_LIMIT_PRO',
});

/** Plans whose limit notice also offers the manual keyword-list route (Optimize and Scale). */
const MANUAL_LISTS_TIERS: ReadonlySet<AllowanceTier> = new Set<AllowanceTier>(['starter', 'pro']);

export interface KeywordAllowancePlan {
  /** subscription_plans.slug, or null when the user has no plan row. */
  slug: string | null | undefined;
  /** price_cents > 0 — used only to place a slug this module does not know. */
  isPaid: boolean;
}

/**
 * The tier a plan is limited as. A slug added to subscription_plans after this was written is
 * placed by price: a paying customer gets the top tier rather than being quietly held to the free
 * allowance, and an unpaid one gets the free tier.
 */
export function allowanceTierFor(plan: KeywordAllowancePlan): AllowanceTier {
  const slug = String(plan.slug ?? '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, slug)) {
    return slug as AllowanceTier;
  }
  return plan.isPaid ? 'pro' : 'free';
}

/** A clean positive integer, or null. Same strictness as credits.config.ts: no '', '1.5' or '-3'. */
function parseOverride(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 ? n : null;
}

/** Runs per UTC day for this plan. `env` is a parameter so tests do not have to mutate process.env. */
export function keywordDailyLimitFor(
  plan: KeywordAllowancePlan,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const tier = allowanceTierFor(plan);
  return parseOverride(env[ENV_KEYS[tier]]) ?? DEFAULT_LIMITS[tier];
}

/** True when the limit notice should point the user at manual keyword lists. */
export function offersManualListsHint(plan: KeywordAllowancePlan): boolean {
  return MANUAL_LISTS_TIERS.has(allowanceTierFor(plan));
}

/** The moment the current UTC day's allowance resets. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
