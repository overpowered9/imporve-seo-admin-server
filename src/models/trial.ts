/**
 * The free-trial window, as pure functions over plain data.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 * These three rules used to live in user.models.ts, which opens the database
 * connection at import. That made them unreachable from a unit test: importing
 * the rule imported the pool, and a test run without DATABASE_URL dies before
 * the first assertion. The rules are pure — they take timestamps and return a
 * date or a boolean — so nothing about them needed the database; only their
 * address did.
 *
 * user.models.ts re-exports all three, so every existing importer is unchanged.
 */

/** Length of the free trial started at signup. */
export const TRIAL_DAYS = 7;

/**
 * Effective trial end for a user: the explicit `trial_ends_at`, or — when that was never
 * set — `created_at + TRIAL_DAYS` as a fallback. Returns null only when neither is known.
 * The fallback closes the hole where a NULL `trial_ends_at` would otherwise bypass every
 * trial check (a null timestamp is not "no trial", it's a trial whose end we must infer).
 */
export const effectiveTrialEnd = (
  user: { trial_ends_at?: Date | null; created_at?: Date | null }
): Date | null => {
  if (user.trial_ends_at) return new Date(user.trial_ends_at);
  if (user.created_at) {
    const d = new Date(user.created_at);
    d.setDate(d.getDate() + TRIAL_DAYS);
    return d;
  }
  return null;
};

/** True when the user's free-trial window has elapsed (uses effectiveTrialEnd). */
export const isTrialExpired = (
  user: { trial_ends_at?: Date | null; created_at?: Date | null }
): boolean => {
  const end = effectiveTrialEnd(user);
  return !!end && end.getTime() < Date.now();
};
