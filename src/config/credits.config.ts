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

/**
 * Plan slugs that receive a credit grant each billing cycle.
 *
 * These MUST match subscription_plans.slug in the database exactly. They are the real production
 * slugs, confirmed against it — note that the 950-cent plan has the slug 'basic' while its display
 * name is "Grow", which is why guessing from the product names got this wrong. A slug with no
 * matching key falls back to the FREE grant (see grantForPlanSlug), so a mismatch silently gives
 * paying customers the free allotment rather than failing loudly.
 */
const PLAN_SLUGS = ['free', 'basic', 'starter', 'pro'] as const;
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
  ISEO_GRANT_BASIC: positiveInt('ISEO_GRANT_BASIC'),
  ISEO_GRANT_STARTER: positiveInt('ISEO_GRANT_STARTER'),
  ISEO_GRANT_PRO: positiveInt('ISEO_GRANT_PRO'),

  // ── Top-up packages — sold from the Credits page ───────────────────────────
  //
  // Sized in PIECES OF CONTENT, not round credit numbers: at ~19 credits for a
  // finished piece (article 10 + image 5 + keyword list 1, plus a 30%/40% rerun
  // allowance) these are roughly 3, 5 and 10 pieces.
  //
  // Prices are required rather than defaulted, for the same reason the deduction
  // table is: a deploy missing a package price would otherwise sell credits for
  // nothing. Missing keys abort boot and are named in the error.
  ISEO_PACKAGE_SMALL_CREDITS: positiveInt('ISEO_PACKAGE_SMALL_CREDITS'),
  ISEO_PACKAGE_SMALL_PRICE_CENTS: positiveInt('ISEO_PACKAGE_SMALL_PRICE_CENTS'),
  ISEO_PACKAGE_MEDIUM_CREDITS: positiveInt('ISEO_PACKAGE_MEDIUM_CREDITS'),
  ISEO_PACKAGE_MEDIUM_PRICE_CENTS: positiveInt('ISEO_PACKAGE_MEDIUM_PRICE_CENTS'),
  ISEO_PACKAGE_LARGE_CREDITS: positiveInt('ISEO_PACKAGE_LARGE_CREDITS'),
  ISEO_PACKAGE_LARGE_PRICE_CENTS: positiveInt('ISEO_PACKAGE_LARGE_PRICE_CENTS'),
});

/**
 * How long a credit lives, by where it came from.
 *
 * Defaulted in code rather than required from env — unlike a price, a missing
 * value here cannot give work away for free, and these two numbers are the
 * product rule itself ("plan credits expire after two months, purchased after
 * twelve") rather than a tunable. Overridable for testing and for a future
 * policy change without a code edit.
 */
export const PLAN_CREDIT_LIFETIME_MONTHS =
  Number(process.env.ISEO_PLAN_CREDIT_LIFETIME_MONTHS || 2);
export const PURCHASED_CREDIT_LIFETIME_MONTHS =
  Number(process.env.ISEO_PURCHASED_CREDIT_LIFETIME_MONTHS || 12);

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
  basic: env.ISEO_GRANT_BASIC,
  starter: env.ISEO_GRANT_STARTER,
  pro: env.ISEO_GRANT_PRO,
});

/** A purchasable top-up. `id` is the stable key the CMS sends. */
export interface CreditPackage {
  id: CreditPackageId;
  credits: number;
  price_cents: number;
  /** Roughly how many finished pieces this buys, for the storefront label. */
  approx_pieces: number;
}

const PACKAGE_IDS = ['small', 'medium', 'large'] as const;
export type CreditPackageId = (typeof PACKAGE_IDS)[number];

/**
 * Credits for one finished piece: article (medium) + AI image + keyword list,
 * with an allowance for the reruns real users do.
 *
 *   10 + 5 + 1 = 16, plus 0.30 x 6 content rerun and 0.40 x 3 image rerun ≈ 19
 *
 * Derived from the live cost table rather than hardcoded, so changing a price
 * moves the "≈ N pieces" labels with it instead of leaving them stale.
 */
export const creditsPerPiece = (): number =>
  Math.round(
    costs.content.medium + costs.image + costs.keywords
    + 0.3 * costs.content_regen.medium
    + 0.4 * costs.image_regen,
  );

/** The top-up packages, frozen. Ordered smallest first for the storefront. */
const packages: readonly CreditPackage[] = Object.freeze([
  { id: 'small', credits: env.ISEO_PACKAGE_SMALL_CREDITS, price_cents: env.ISEO_PACKAGE_SMALL_PRICE_CENTS },
  { id: 'medium', credits: env.ISEO_PACKAGE_MEDIUM_CREDITS, price_cents: env.ISEO_PACKAGE_MEDIUM_PRICE_CENTS },
  { id: 'large', credits: env.ISEO_PACKAGE_LARGE_CREDITS, price_cents: env.ISEO_PACKAGE_LARGE_PRICE_CENTS },
].map((p) => Object.freeze({ ...p, approx_pieces: Math.max(1, Math.round(p.credits / creditsPerPiece())) })) as CreditPackage[]);

export const creditPackages = (): readonly CreditPackage[] => packages;

/** One package by id, or null. The route answers 400 on null rather than guessing. */
export const creditPackageById = (id: string | null | undefined): CreditPackage | null =>
  packages.find((p) => p.id === String(id || '').trim().toLowerCase()) ?? null;

export const creditsConfig = Object.freeze({ costs, grants, packages });

/**
 * Fingerprint of the active price table, for the boot log and support triage.
 * Exported so a health endpoint can report WHICH table is live without revealing the values.
 */
export const creditsConfigHash: string = createHash('sha256')
  .update(JSON.stringify({ costs, grants, packages }))
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

/**
 * Is there an explicit grant for this slug, as opposed to the free-grant fallback?
 *
 * Used by the boot-time plan-coverage check so a PAID plan with no configured grant aborts startup
 * instead of silently receiving the free allotment.
 */
export function hasExplicitGrant(slug: string | null | undefined): boolean {
  return ((slug || '').trim().toLowerCase() as PlanSlug) in grants;
}

export function logCreditsConfigFingerprint(): void {
  console.log(`💳 ISEO credit table loaded — sha256:${creditsConfigHash.slice(0, 16)}`);
}

export default creditsConfig;
