/**
 * What an action costs in ISEO Credits.
 *
 * The single place prices are resolved. Routes must never read creditsConfig directly, so there is
 * exactly one code path between the env table and a debit.
 *
 * TWO SECURITY INVARIANTS LIVE HERE — both are about not letting a client choose its own price:
 *
 *  1. The size variant must come from the SAME server-side value that drives generation. Callers
 *     resolve it once with variantFromWords() and hand the same value to priceOf() and to the
 *     generator. A client can ask for a cheaper size, but then it receives the cheaper article —
 *     no arbitrage. variantFromWords() already fails closed to 'medium' on unknown input, so
 *     garbage cannot land on the cheapest tier.
 *
 *  2. Regeneration is never claimed by the client. `content_regen` / `image_regen` are selected by
 *     the ROUTE only after it has found a prior successful user_generations row for the same
 *     (user, target_key, type). A request that merely asserts is_regeneration: true, with no such
 *     row, is priced as a first generation. See isRegeneration() in generation-history.ts.
 */
import { creditsConfig, type WordCountVariant } from '../config/credits.config.js';

export type BillableAction =
  | 'content'
  | 'content_regen'
  | 'image'
  | 'image_regen'
  | 'keywords';

/**
 * Price of one action, in ISEO Credits.
 *
 * @param action  Which billable action. Regen variants are chosen by the caller only on the basis
 *                of server-side history — never on a client-supplied flag.
 * @param variant Article size, required for the content actions. Defaults to 'medium', matching
 *                variantFromWords()' own fail-closed behaviour, so a missing variant can never be
 *                priced at the cheapest tier.
 */
export function priceOf(action: BillableAction, variant?: WordCountVariant): number {
  switch (action) {
    case 'content':
      return creditsConfig.costs.content[variant ?? 'medium'];
    case 'content_regen':
      return creditsConfig.costs.content_regen[variant ?? 'medium'];
    case 'image':
      return creditsConfig.costs.image;
    case 'image_regen':
      return creditsConfig.costs.image_regen;
    case 'keywords':
      return creditsConfig.costs.keywords;
    default: {
      // Exhaustiveness guard: adding a BillableAction without a price becomes a compile error
      // here, rather than a runtime 0 that would silently make the action free.
      const _never: never = action;
      throw new Error(`priceOf: unpriced action ${_never}`);
    }
  }
}

/** The regen counterpart of a first-generation action. Keeps the choice in one place. */
export function regenActionFor(action: 'content' | 'image'): BillableAction {
  return action === 'content' ? 'content_regen' : 'image_regen';
}

/**
 * The pricing block published to clients (plugin, CMS) so they can show a cost before the user
 * commits to an action. Advisory only — the server reservation is the real gate, and the client
 * never gets to state which of these applies.
 */
export function publicPricing() {
  return {
    content: { ...creditsConfig.costs.content },
    content_regen: { ...creditsConfig.costs.content_regen },
    image: creditsConfig.costs.image,
    image_regen: creditsConfig.costs.image_regen,
    keywords: creditsConfig.costs.keywords,
  };
}
