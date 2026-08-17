/**
 * ISEO Credits — the deduction table and plan grants.
 *
 * These are FINANCIAL values, so this module is deliberately stricter than config.ts:
 *
 *  - env is the single source of truth; there is no runtime write path, no setter and no exported
 *    mutable reference, so no request can move a price;
 *  - every value is Zod-validated at import as a positive integer and the process THROWS on a
 *    missing or malformed key. A server that cannot price an action must not serve traffic —
 *    silently falling back to 0 would be a free-content bug;
 *  - values are never echoed into an API response or an error message. They are integrity-
 *    sensitive rather than confidentiality-sensitive: the protection is validation, immutability
 *    and having no write path, not secrecy;
 *  - a single SHA-256 of the serialised table is logged at boot, so it is auditable which price
 *    table a given deploy was running without printing a price list into the logs.
 *
 * Changing a price requires a redeploy. That is intentional.
 */
import dotenv from 'dotenv';
import { createHash } from 'crypto';
import { z } from 'zod';

// Self-loading for the same reason as adminAuth.middleware.ts: index.ts calls dotenv.config() in
// its module body, which runs after this import is evaluated. Idempotent.
dotenv.config();

/** Article size tiers. Mirrors WordCountVariant in services/content-blueprint.ts. */
export type WordCountVariant = 'small' | 'medium' | 'large';

/** Plan slugs that receive a credit grant each billing cycle. */
const PLAN_SLUGS = ['free', 'grow', 'scale', 'enterprise'] as const;
export type PlanSlug = (typeof PLAN_SLUGS)[number];

/**
 * A positive integer, parsed from a string env var.
 *
 * `z.coerce.number()` is not used on purpose: it accepts '' as 0 and '1.5' as 1.5, either of which
 * would price an action at zero or fractionally. This insists on a clean integer literal.
 */
const positiveInt = (key: string) =>
  z
    .string({ required_error: `${key} is required` })
    .trim()
    .regex(/^\d+$/, `${key} must be a whole number (got "${process.env[key] ?? ''}")`)
    .transform((s) => parseInt(s, 10))
    .refine((n) => n > 0, `${key} must be greater than 0`);

const envSchema = z.object({
  // ── Deduction table — ISEO Credits per action ──────────────────────────────
  ISEO_COST_CONTENT_SMALL: positiveInt('ISEO_COST_CONTENT_SMALL'),
  ISEO_COST_CONTENT_MEDIUM: positiveInt('ISEO_COST_CONTENT_MEDIUM'),
  ISEO_COST_CONTENT_LARGE: positiveInt('ISEO_COST_CONTENT_LARGE'),

  // Regeneration. Priced separately because a regen is server-detected (a prior user_generations
  // row for the same target_key) and is cheaper to the customer than a first generation.
  ISEO_COST_CONTENT_REGEN_SMALL: positiveInt('ISEO_COST_CONTENT_REGEN_SMALL'),
  ISEO_COST_CONTENT_REGEN_MEDIUM: positiveInt('ISEO_COST_CONTENT_REGEN_MEDIUM'),
  ISEO_COST_CONTENT_REGEN_LARGE: positiveInt('ISEO_COST_CONTENT_REGEN_LARGE'),

  ISEO_COST_IMAGE: positiveInt('ISEO_COST_IMAGE'),
  ISEO_COST_IMAGE_REGEN: positiveInt('ISEO_COST_IMAGE_REGEN'),

  ISEO_COST_KEYWORDS: positiveInt('ISEO_COST_KEYWORDS'),

  // ── Plan grants — ISEO Credits per billing cycle, keyed by subscription_plans.slug ──
  ISEO_GRANT_FREE: positiveInt('ISEO_GRANT_FREE'),
  ISEO_GRANT_GROW: positiveInt('ISEO_GRANT_GROW'),
  ISEO_GRANT_SCALE: positiveInt('ISEO_GRANT_SCALE'),
  ISEO_GRANT_ENTERPRISE: positiveInt('ISEO_GRANT_ENTERPRISE'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.message}`).join('\n');
  // Throwing at import aborts boot. This is the "fail closed" requirement: a deploy missing a
  // price must never start and begin serving generations at 0 credits.
  throw new Error(
    `Invalid ISEO credit configuration — refusing to start.\n${issues}\n` +
      `Set these in the environment (see .env.sample). Prices are env-only by design; there is no runtime override.`,
  );
}

const env = parsed.data;

/** Per-action costs. Frozen — read-only for the life of the process. */
const costs = Object.freeze({
  content: Object.freeze({
    small: env.ISEO_COST_CONTENT_SMALL,
    medium: env.ISEO_COST_CONTENT_MEDIUM,
    large: env.ISEO_COST_CONTENT_LARGE,
  }),
  content_regen: Object.freeze({
    small: env.ISEO_COST_CONTENT_REGEN_SMALL,
    medium: env.ISEO_COST_CONTENT_REGEN_MEDIUM,
    large: env.ISEO_COST_CONTENT_REGEN_LARGE,
  }),
  image: env.ISEO_COST_IMAGE,
  image_regen: env.ISEO_COST_IMAGE_REGEN,
  keywords: env.ISEO_COST_KEYWORDS,
});

/** Per-billing-cycle grant, keyed by subscription_plans.slug. Frozen. */
const grants: Readonly<Record<PlanSlug, number>> = Object.freeze({
  free: env.ISEO_GRANT_FREE,
  grow: env.ISEO_GRANT_GROW,
  scale: env.ISEO_GRANT_SCALE,
  enterprise: env.ISEO_GRANT_ENTERPRISE,
});

export const creditsConfig = Object.freeze({ costs, grants });

/**
 * Fingerprint of the active price table, for the boot log and support triage.
 * Exported so a health endpoint can report WHICH table is live without revealing the values.
 */
export const creditsConfigHash: string = createHash('sha256')
  .update(JSON.stringify({ costs, grants }))
  .digest('hex');

/**
 * Grant for a plan slug. Unknown slugs fall back to the free grant rather than throwing, so an
 * unrecognised plug/plan row degrades to the smallest allotment instead of taking the service
 * down or handing out an unbounded one.
 */
export function grantForPlanSlug(slug: string | null | undefined): number {
  const key = (slug || '').trim().toLowerCase() as PlanSlug;
  if (key in grants) return grants[key];
  console.warn(`⚠️  Unknown plan slug "${slug}" — falling back to the free grant.`);
  return grants.free;
}

export function logCreditsConfigFingerprint(): void {
  console.log(`💳 ISEO credit table loaded — sha256:${creditsConfigHash.slice(0, 16)}`);
}

export default creditsConfig;
