/**
 * The plan an ADMIN is shown for a user — in the support queue, on a ticket, and
 * in the user list. One derivation for all of them, so the same account cannot
 * be described two ways depending on which screen an agent happens to open.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 * Pure functions over plain data, deliberately free of any database import, so
 * the two rules below can be unit-tested directly — neither ticket.models.ts nor
 * admin-users.routes.ts can be imported without opening a connection.
 */
import { planLabel } from '../services/billing/descriptions.js';
import { effectiveTrialEnd } from './trial.js';

/** What an agent sees for the $0 plan once no trial is running. */
export const FREE_PLAN_LABEL = 'Basic (free)';

/**
 * The plan an agent sees beside a ticket.
 *
 * `plan_name` is the RAW `subscription_plans.name` and is kept only so the panel
 * can fall back or debug; `plan_display_name` is the one to print.
 */
export interface UserPlanSummary {
  plan_slug: string | null;
  /** Raw `subscription_plans.name` — outdated by design. Prefer plan_display_name. */
  plan_name: string | null;
  /** The name the CUSTOMER knows the plan by, 'Free Trial', or 'Basic (free)'. Always safe to print. */
  plan_display_name: string;
  on_trial: boolean;
  trial_expired: boolean;
  /**
   * The EFFECTIVE trial end (see effectiveTrialEnd): the explicit
   * `users.trial_ends_at`, or signup + TRIAL_DAYS when that was never set.
   *
   * Null for a PAYING account. Every user has a signup date, so the fallback
   * yields a date for everyone — including customers who are years past any
   * trial — and a panel rendering it beside a Scale customer would print a
   * trial that does not exist. Trial fields only carry meaning on the $0 plan.
   */
  trial_ends_at: Date | null;
}

/** The shape the ticket queries select for the plan derivation. */
export interface UserPlanRow {
  plan_slug?: string | null;
  plan_name?: string | null;
  plan_price_cents?: number | string | null;
  trial_ends_at?: Date | null;
  /** The USER's created_at — aliased, because `t.*` already occupies `created_at`. */
  user_created_at?: Date | null;
}

/**
 * Derive the plan an agent needs to see from a joined ticket row.
 *
 * Two things go wrong if the raw row is handed to the panel as-is, and both were
 * reported against the ticket queue:
 *
 * 1. `subscription_plans.name` still holds the ORIGINAL names — "Starter Plan",
 *    "Pro Plan" — while the product and the customer call those Optimize and
 *    Scale, and the 950-cent plan whose slug is 'basic' is called Grow. Printing
 *    the column names a plan nobody recognises. planLabel() is the same mapping
 *    the billing ledger uses, so the queue, the ledger and the CMS agree.
 *
 * 2. A trial account and a lapsed free account are the SAME row: both sit on the
 *    $0 plan and only `trial_ends_at` separates them. An agent reading "Free"
 *    cannot tell a prospect mid-trial from a churned user — which is exactly the
 *    distinction that decides how the ticket gets answered.
 *
 * `price_cents` decides what counts as free rather than the slug, mirroring
 * isFreePlanId(): a missing or unknown plan is treated as free, so a user with a
 * broken plan_id is never shown to an agent as paying.
 */
export const describeUserPlan = (row: UserPlanRow): UserPlanSummary => {
  const slug = row.plan_slug ?? null;
  const name = row.plan_name ?? null;
  const isFree = row.plan_price_cents == null || Number(row.plan_price_cents) === 0;

  // A trial is only claimed when its end is actually KNOWN. Without this guard a
  // row carrying neither timestamp (a deleted user, a row fetched without the
  // trial columns) reads as "not yet expired" and every such account would be
  // labelled Free Trial — the opposite of the distinction being added here.
  const trialEnd = effectiveTrialEnd({
    trial_ends_at: row.trial_ends_at ?? null,
    created_at: row.user_created_at ?? null,
  });
  const expired = !!trialEnd && trialEnd.getTime() < Date.now();
  const onTrial = isFree && !!trialEnd && !expired;

  return {
    plan_slug: slug,
    plan_name: name,
    // The $0 plan outside its trial is "Basic (free)": the CMS shows that
    // customer "Basic" (user-cms planUtils.js), so an agent quoting the plain
    // "Free" the ledger uses would name a plan the customer never saw — and
    // "Free" next to "Free Trial" is exactly the confusion this field exists to
    // remove. Paid plans are keyed on the slug first: it is stable, while the
    // name is the column that drifted. planLabel falls back to the name's own
    // text for a plan added since this mapping was written.
    plan_display_name: onTrial ? 'Free Trial' : isFree ? FREE_PLAN_LABEL : planLabel(slug ?? name) || FREE_PLAN_LABEL,
    on_trial: onTrial,
    trial_expired: isFree && expired,
    trial_ends_at: isFree ? trialEnd : null,
  };
};
