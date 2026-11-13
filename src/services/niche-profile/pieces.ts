/**
 * Niche profile (#7) text pieces, verbatim from docs/content-v3-prompt-drafts.md "Writer part 3:
 * Niche profile" (generated from the doc; doc-equality.test.ts compares). Editable in the prompt
 * registry as content_v3_niche_standard_piece / content_v3_niche_regulated_piece; the in-code text
 * is the fallback. The Standard piece keeps its "[watchlist]" placeholder, which code fills in.
 */

export const NICHE_STANDARD_PIECE_V1 = `STANDARD
Claims follow the shared rules. Watch these words in this niche: [watchlist].
A sentence that uses one of them needs a source token or a business detail
behind it, and promises nothing.`;

export const NICHE_REGULATED_PIECE_V1 = `REGULATED (health, legal, financial, insurance)
- Every figure, dosage, legal time limit, fee or rate needs a research source
  token. Without one, leave it out.
- Promise no outcome: no results, success rates, approval odds, cures, wins
  or savings.
- No past results or case examples, even if the business details include them.
- Do not compare this business with other providers.
- Do not diagnose or give advice that needs a licence. Explain what the
  situation usually involves, and say when the reader should talk to a
  professional about their own case.
- Name the reader's worry once, plainly, then move to explanation and next
  steps. Never use fear to push a decision.
- Do not write a disclaimer; code adds one.`;

/** Part 3: type adjustments, the table's "Line added" cells word for word. */
export const TYPE_ADJUSTMENT_LINES = Object.freeze({
  cost_money_legal:
    'Replace the price range with how pricing works: fee structures explained, with a sourced range only where one exists. The firm\'s own fees appear only if supplied.',
  cost_health_care: 'Insurance and payment options are required, not optional. Never promise coverage.',
  question_regulated: '"What to do now" always includes when to see a professional. Warning signs come only from sourced material.',
  topic_task_regulated: 'Steps cover preparation and process only, from official or sourced material. No self-treatment or self-representation steps.',
  decision_content_or_shops: 'Compare products or approaches. Choosing a provider applies only when the site offers a service.',
  any_content_or_online_shops:
    'The required local or business element may be a product fact, the author\'s own experience as supplied by the user, or a sourced figure.',
});

export const NICHE_STANDARD_PIECE_DEF = {
  templateType: 'content_v3_niche_standard_piece' as const,
  displayName: 'Content v3 — Niche profile: Standard proof piece',
  fallback: NICHE_STANDARD_PIECE_V1,
};

export const NICHE_REGULATED_PIECE_DEF = {
  templateType: 'content_v3_niche_regulated_piece' as const,
  displayName: 'Content v3 — Niche profile: Regulated proof piece',
  fallback: NICHE_REGULATED_PIECE_V1,
};
