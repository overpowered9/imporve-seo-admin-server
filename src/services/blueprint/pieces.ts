/**
 * Blueprint (#5 with #6) text pieces, verbatim from docs/content-v3-prompt-drafts.md "Writer part 2:
 * Blueprint" (generated from the doc's code blocks; blueprint-pieces.test.ts re-parses the doc and
 * compares every key). B1: one editable record, content_v3_blueprint_directives, holds every piece
 * under its own key — this object is its fallback and the seed value.
 *
 * Keys: openings (5), length patterns (4), accents (4), closing moves (4), closing formats (2),
 * firmness levels (3), the four article type pieces plus "Cost guide, no figure available", and the
 * numbered piece.
 */
export const BLUEPRINT_PIECES_V1: Readonly<Record<string, string>> = Object.freeze({
  "reader_situation": "Open with the situation the reader is probably in, as a possibility, in second person: \"If ...\". Use <their_words>. No story, no invented moment.",
  "reader_stakes": "Open with what this decision or problem means for the reader in plain terms: money, time, safety or comfort. Use a figure only if the data gives one.",
  "direct_question": "Open with the question the reader is asking, using <their_words>, and answer it in the next sentence.",
  "contrarian_claim": "Open with a claim that goes against a common assumption, but only if <research> supplies it. Otherwise use direct_question.",
  "myth_correction": "Open by correcting a common belief about this topic, but only if <research> supplies the belief. Otherwise use reader_situation.",
  "front_heavy": "Make the first body section the longest. The rest get shorter.",
  "back_heavy": "Keep the early body sections short. Give the most room to the last one or two.",
  "anchor": "Make one body section, the one that answers the main concern, clearly the longest. Keep the others short.",
  "alternating": "Alternate longer and shorter body sections.",
  "prose_only": "Write the body in paragraphs, with no lists or tables except any the article type requires.",
  "one_list": "Use one bulleted or numbered list in the body, where items really are separate.",
  "one_table": "Use one table in the body, where a side-by-side comparison helps.",
  "one_checklist": "Use one short checklist the reader can act on.",
  "forward_question": "End by turning the topic forward with one question the reader should now ask themselves or a provider. Not a rhetorical question.",
  "quiet_close": "End on a quiet, concrete note: the last useful fact or condition. No summary, no \"In conclusion\".",
  "punch_line": "End with one short, plain sentence that lands the main point from a new angle. Never a restatement of the article.\n  Example of what to avoid: \"Water heaters matter.\"\n  Example of what to write instead: \"The cheapest heater is the one you replace before it floods the basement.\"",
  "next_step": "End with the single most useful step the reader can take today.",
  "one_paragraph": "Write the closing as one paragraph that ends with the call to action.",
  "cta_own_line": "Write one short paragraph, then the call to action as its own one-sentence paragraph.",
  "soft": "Offer a light next step. Give <cta> plainly as one option, without urging the reader to contact the business.",
  "medium": "Suggest what to check, ask or compare, and mention the business as one option.",
  "direct": "Invite the reader to contact the business, using <cta>.",
  "cost_guide": "COST GUIDE\nThe reader wants to know what this will cost them. Reading path: the number, what drives it, how to spend well.\nQuick answer states: a price range with its location and the main cost driver.\nMust cover:\n- What it costs: a range from the business details or a sourced figure.\n- What drives the price up or down. Comes after the price range.\n- How to avoid overpaying, or when paying more is worth it.\nAt least one figure, from <research> or the business details.\nTakeaways carry figures and cost rules. The closing names the price range from the body in a few words, next to the call to action.\nOptional pool: options compared in a table · extra or hidden costs · local price factors (local only) · financing, insurance or payment options (supplied only) · doing it yourself versus hiring · timeline · what a fair quote should include · questions to ask before hiring.",
  "cost_guide_no_figure": "COST GUIDE, NO FIGURE AVAILABLE (code sends this instead when neither research nor the business details hold a price)\nReplace the price range with how pricing works: what the price is usually based on and how quotes are structured. State no figure.",
  "decision_guide": "DECISION GUIDE\nThe reader is choosing between options or providers. Reading path: the options, the deciding factors, the verdict.\nQuick answer states: \"Choose A if ..., choose B if ...\", or for a provider, the two or three things that matter most.\nMust cover:\n- The choice laid out: a comparison table of the options against at least 3 criteria, or a criteria checklist when the choice is a provider.\n- At least 2 deciding factors explained in prose.\n- A recommendation by situation: which choice for which reader. Comes after the table and the factors.\nWhen the choice is a provider, the business may appear only as one example that meets the criteria, from its details. Never conclude that the reader should pick this business.\nTakeaways carry decision rules.\nOptional pool: cost over time · lifespan and maintenance · local suitability (local only) · a common belief corrected · questions to ask before deciding · warning signs · when to get a second opinion · what this business offers (supplied only).",
  "question_guide": "QUESTION GUIDE\nThe reader has a problem, symptom, risk or requirement and wants to know what it means and what to do.\nReading path: diagnose, then act.\nQuick answer states: the direct answer and the most likely cause.\nMust cover:\n- Why it happens: the causes or what is behind it.\n- What to do now, including when it needs a professional. Comes after the causes.\nAt least one part uses a local fact (for a local business) or a business fact.\nTakeaways carry warning signs and action rules.\nOptional pool: signs or symptoms · a common belief corrected · what it costs to fix (sourced or supplied only) · a local factor (local only) · prevention · what happens if it is ignored · how this business handles it (supplied only).",
  "topic_guide": "TOPIC GUIDE\nThe reader wants to understand something, get ready for it, or follow a process.\nQuick answer states: the direct answer to the core question.\nMust cover:\n- At least 2 body sections, each answering one of the body questions.\n- At least one practical element: an action, a decision rule, a timeline or a checklist.\n- At least one section or paragraph built on a local fact, a business fact or a sourced figure. A passing mention does not count.\nAdd when code finds the trigger in the title:\n- Task (how to, steps, prepare, set up, apply): the steps as one ordered list, then a stop point: when to get professional help, or safety limits. The stop point comes after the steps.\n- Time (a season, month, before, after): what to do when.\n- Process (what to expect, process, timeline, recovery, how long): the stages in order.\nTakeaways carry action rules or facts.\nOptional pool: signs · a common belief corrected · a local factor (local only) · prevention · cost (sourced or supplied only) · timeline · checklist · questions to ask · mistakes to avoid · tools and materials · what happens if it is ignored · how this business handles it (supplied only).",
  "numbered": "The title promises [N] [items]. Deliver exactly [N], each under its own heading, each opening with its point. Items are at least [M] words each. Group them as [items as H2 sections / items as H3s under 2 or 3 grouping H2s]. Order them by [priority / sequence / cost / season]. Do not start every item heading with the same kind of word. Add a short guide to which items matter most for which reader, before or after the items. Cover the article type's required content inside the items where it fits; anything left gets one short section after the items. Add no other optional elements and no other list: the items are the list."
});

export const OPENINGS = ['reader_situation', 'reader_stakes', 'direct_question', 'contrarian_claim', 'myth_correction'] as const;
export const LENGTH_PATTERNS = ['front_heavy', 'back_heavy', 'anchor', 'alternating'] as const;
export const ACCENTS = ['prose_only', 'one_list', 'one_table', 'one_checklist'] as const;
export const CLOSING_MOVES = ['forward_question', 'quiet_close', 'punch_line', 'next_step'] as const;
export const CLOSING_FORMATS = ['one_paragraph', 'cta_own_line'] as const;
export const FIRMNESS = ['soft', 'medium', 'direct'] as const;
export const TYPE_PIECE_KEYS = { cost: 'cost_guide', decision: 'decision_guide', question: 'question_guide', topic: 'topic_guide' } as const;

export type Opening = (typeof OPENINGS)[number];
export type LengthPattern = (typeof LENGTH_PATTERNS)[number];
export type Accent = (typeof ACCENTS)[number];
export type ClosingMove = (typeof CLOSING_MOVES)[number];
export type ClosingFormat = (typeof CLOSING_FORMATS)[number];
export type FirmnessLevel = (typeof FIRMNESS)[number];

export const BLUEPRINT_DIRECTIVES_DEF = {
  templateType: 'content_v3_blueprint_directives' as const,
  displayName: 'Content v3 — Blueprint text pieces (JSON, every piece by key)',
  fallback: JSON.stringify(BLUEPRINT_PIECES_V1, null, 2),
};

/** An admin-edited record: every known key must be a non-empty string, else the default is used. */
export function parseBlueprintPieces(raw: string | null | undefined): Record<string, string> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(BLUEPRINT_PIECES_V1)) if (typeof v[k] !== 'string' || !(v[k] as string).trim()) return null;
    return v as Record<string, string>;
  } catch {
    return null;
  }
}
