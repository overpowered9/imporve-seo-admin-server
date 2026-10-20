/**
 * Claude Content Generator (v3 route).
 *
 * A copy of the v2 generator, deliberately. v2 is what the WordPress plugin calls in production, so
 * it is not the place to try things. Everything genuinely shared — the Anthropic wrapper, the meta
 * budgets, the blueprint engine, the post-processor — is imported rather than duplicated; what is
 * copied here is the prompt-assembly glue that v3 needs to diverge on.
 *
 * What v3 changes:
 *
 *  1. A full business profile instead of v2's four-field brand profile, with the content/schema
 *     split enforced by the types in business-profile.v3.ts.
 *  2. Section headings written from the article's own topic. v2 mandates the literal labels
 *     "Quick answer", "Key Takeaways", "Frequently asked questions" and "What's next", so every
 *     article on every site it has ever written shares four identical headings — a site-level
 *     structural footprint. v3 keeps the sections mandatory but carries their identity in a
 *     `data-iseo` attribute rather than in the visible text.
 *  3. Its own prompt namespace (content_v3_*), so prompt experiments cannot touch the live route.
 *  4. JSON-LD output for the post, built after the meta description is final.
 *  5. Diagnostics — the rendered prompts, which templates came from the DB, and a field audit.
 *     Test endpoint only; see content-v3.routes.ts for why.
 */

import { claudeText, claudeJSON, parseJsonLoose, ClaudeUsage } from './claude.service.js';
import { PromptManagementService } from './prompt-management.service.js';
import { enforceMetaLength, META_BOUNDS, MetaKind } from './meta-length.js';
import { postProcessArticle } from './content-postprocess.js';
import { config } from '../config/config.js';
import {
  buildBlueprint,
  blueprintDirective,
  variantFromWords,
  ContentBlueprint,
  BlueprintOverrides,
  BlueprintDirectives,
  DEFAULT_BLUEPRINT_DIRECTIVES,
  mergeDirectives,
} from './content-blueprint.js';
import { buildAdditionalInstructionsBlock } from './generation-history.js';
import {
  BusinessProfileV3,
  ContentView,
  FieldAudit,
  auditFields,
  contentView,
  schemaView,
  renderBusinessBlock,
  runLeakCheck,
} from './business-profile.v3.js';
import {
  buildArticleSchema,
  buildBusinessEntity,
  ArticleSchemaResult,
} from './schema-builder.v3.js';

const promptService = new PromptManagementService();

// ---------- request / response ----------

export type ArticleType = 'cost_guide' | 'decision_guide' | 'question_guide' | 'topic_guide';

export const ARTICLE_TYPES: ArticleType[] = [
  'cost_guide',
  'decision_guide',
  'question_guide',
  'topic_guide',
];

/** Plain-English framing for the writer. The section machinery per type is a later round. */
const ARTICLE_TYPE_LABELS: Record<ArticleType, string> = {
  cost_guide:
    'a COST GUIDE. The reader wants to know what this costs and what moves the price. Give the real ' +
    'ranges you were supplied, name what pushes a job to the top or the bottom of one, and say ' +
    'plainly what cannot be quoted without seeing the work.',
  decision_guide:
    'a DECISION GUIDE. The reader is weighing options and wants help choosing, not a sales pitch. ' +
    'Lay out the honest tradeoff, say which option suits which situation, and give the cutoff you ' +
    'would use yourself. Do not pretend one option always wins.',
  question_guide:
    'a QUESTION GUIDE. The reader has one specific worry. Answer it directly and early, then ' +
    'explain what causes it, how to judge how serious it is, and what to do about it.',
  topic_guide:
    'a TOPIC GUIDE. The reader wants to understand the subject and what to expect. Cover what ' +
    'actually happens, in what order, and what usually surprises people.',
};

export interface GenerateV3Params {
  seed_keyword: string;
  niche: string;
  title?: string;
  nos_of_words?: '600 to 1200 words' | '1200 to 2400 words' | '2400 to 3600 words';
  content_lang?: string;
  /** Structured, labelled per-article fields (carried over from v2). */
  niche_data?: Record<string, string>;
  /** The full business profile. Schema-only fields never reach the writer. */
  business_profile?: BusinessProfileV3;
  article_type?: ArticleType;
  /** Service names this article is about — become `about` @id references in the Article schema. */
  services_selected?: string[];
  call_to_action?: string;
  cta_url?: string;
  humanize?: boolean;
  seed?: string;
  /** Pin parts of the structure by hand instead of letting the seed draw them. */
  blueprint_overrides?: BlueprintOverrides;
  /**
   * Optional free-text steer for THIS generation. UNTRUSTED — must already have passed
   * sanitizeCustomInstruction() in the route. Rendered into the USER message inside a delimited
   * block that cannot override the output contract; never concatenated into a system prompt.
   */
  custom_instruction?: string;

  // ---- schema context (describes the page, not the writing) ----
  site_url?: string;
  post_url?: string;
  featured_image_url?: string;
  date_published?: string;
  date_modified?: string;
  schema_article_type?: 'Article' | 'BlogPosting';

  /**
   * Collect and return the full diagnostics bundle.
   *
   * Set as a literal by the test route only. parseParamsV3 does not read it from the request body,
   * so no caller can switch it on.
   */
  diagnostics?: boolean;
}

export interface AudienceIntelligence {
  psychology: {
    primary_fear: string;
    desired_outcome: string;
    current_frustration: string;
    trust_blockers: string;
  };
  search_context: {
    urgency_level: string;
    buying_stage: string;
    ai_search_question: string;
  };
  niche_voice: {
    words_they_use: string[];
    words_they_avoid: string[];
    local_references: string;
  };
  lsi_keywords: string[];
  faq_questions: string[];
}

export interface FaqPair {
  question: string;
  answer: string;
}

export interface PromptSource {
  templateType: string;
  displayName: string;
  source: 'db' | 'fallback';
}

export interface V3Diagnostics {
  prompts: {
    intelligence_system: string;
    intelligence_user: string;
    generation_system: string;
    generation_user: string;
    humanize_system: string;
  };
  /**
   * Whether each template came from the DB or the in-code constant.
   *
   * This is the single most useful line in the bundle when tuning: it separates "my panel edit is
   * live" from "I am still looking at the fallback", which otherwise look identical.
   */
  prompt_sources: PromptSource[];
  field_audit: FieldAudit & {
    services_selected_matched: string[];
    services_selected_unmatched: string[];
  };
  leak_check: {
    schema_values_found_in_prompt: string[];
    content_values_found_in_schema: string[];
    passed: boolean;
  };
  raw: {
    article_pre_humanize: string;
    article_pre_postprocess: string;
    trailer_raw: string;
  };
  meta_attempts: Array<{ kind: MetaKind; attempt: number; length: number; accepted: boolean }>;
  blueprint_directive: string;
  article_type_label: string;
  schema_warnings: string[];
  profile_warnings: string[];
}

export interface GenerateV3Result {
  content: string;
  meta_title: string;
  meta_description: string;
  faq: FaqPair[];
  faq_schema: Record<string, unknown>;
  schema: {
    article: Record<string, unknown> | null;
    faq: Record<string, unknown>;
    /** Site-wide entity. A preview for the operator — the plugin owns emitting this. */
    business_preview: Record<string, unknown> | null;
  };
  blueprint: ContentBlueprint;
  intelligence: AudienceIntelligence | null;
  timings: Record<string, number>;
  usage: Record<string, ClaudeUsage>;
  diagnostics?: V3Diagnostics;
}

const TRAILER_DELIM = '===META_JSON===';

/** Separator for directive text assembled at runtime. */
const EOL_DIRECTIVE = '\n';

/**
 * Both classes, intentionally.
 *
 * The plugin's stylesheet lives in another repo and targets `.improveseo-v2-content`; a v3-only
 * class would render unstyled on a customer's site. Keeping both means v3 output is still greppable
 * and still styled, with no plugin change needed to test end to end.
 */
const V3_WRAPPER_CLASS = 'improveseo-v2-content improveseo-v3-content';

const BANNED =
  '"it\'s important to note", "in conclusion", "game-changer", "seamless", "robust", "utilize", ' +
  '"leverage", "ensure", "dive into", "comprehensive", "in the realm of", "in today\'s world", ' +
  '"it\'s worth noting", "elevate", "unlock", "navigate the landscape", "testament to", "tapestry"';

/** Heading labels that must never appear as visible heading text. These are v2's fingerprint. */
const BANNED_HEADINGS =
  '"Quick answer", "Key Takeaways", "Takeaways", "Frequently asked questions", "FAQ", "FAQs", ' +
  '"What\'s next", "Conclusion", "Introduction", "Overview", "Summary", "Final thoughts"';

// ---------- static, cacheable system blocks ----------

const INTEL_SYSTEM = `You are an audience and search analyst for local-business content.
Return ONLY valid JSON — no prose, no markdown fences. Use the searcher's real vocabulary, never invent
testimonials or specific numbers. If a field is unknown, use an empty string or empty array.`;

const GEN_SYSTEM = `You are a working specialist in your field with 15+ years of hands-on experience,
writing a blog article for your own local business. You know this customer personally and write the way
you'd actually talk to one of them.

NON-NEGOTIABLE VOICE RULES (these defeat AI-detection):
- Vary sentence length aggressively: mix short punches (3-6 words) with longer explanatory sentences.
- At least one paragraph must be a single short sentence.
- Include one genuine opinion or honest qualification roughly every 250-300 words.
- Write to ONE specific person, not "readers" or "businesses".
- No uniform paragraph lengths. No formulaic transitions ("Furthermore", "Moreover", "Additionally").
- At most ONE em-dash in the entire article. Prefer commas, periods, or parentheses.
- Never invent fake testimonials, fake review counts, or specific statistics you weren't given.

BANNED words/phrases — never use any of these: ${BANNED}

WRITE TO THE NICHE. The niche is not decoration. It decides the questions this reader actually
asks, the words they use for things, how careful a claim has to be, and what a reasonable next step
sounds like. An article for a dentist and one for a roofer should not read alike even on the same
structure. In a regulated field (medical, dental, legal, financial), never promise an outcome,
never give advice that needs a licence, and say when someone should talk to a professional about
their own situation.

EVERY FIGURE MUST HAVE BEEN GIVEN TO YOU. Prices, percentages, timeframes, measurements and counts
may only come from the business details or the article-specific details supplied with this request.
If a number would help and none was supplied, write it qualitatively ("a few hundred", "about a
day") or say that it depends on the job. Never invent a statistic, a review count, a testimonial,
an award, a certification, or a figure you were not handed.

IF THE TITLE CONTAINS A NUMBER, deliver exactly that many. "7 signs your water heater is failing"
owes the reader seven signs, not six and not nine.
- This OVERRIDES the blueprint's section count. The items are the structure of the article.
- Each item gets its own visible heading, as an <h3> inside a body section or as its own body
  section. A reader must be able to count them without interpreting prose. Never bundle two items
  under one heading ("Loud noises and a musty smell" is two items pretending to be one).
- Each item has to earn its place: roughly 60 words for a tip or a reason, 40 for a step, 35 for a
  short entry. Never pad to reach the number, and never quietly deliver fewer than the title promises.

HEADINGS ARE WRITTEN FROM THIS ARTICLE'S OWN TOPIC — this is a hard rule.
Every heading must be specific to this subject and could not be copy-pasted onto another article.
NEVER use any of these as visible heading text: ${BANNED_HEADINGS}
Each required section is identified by a data-iseo attribute, NOT by its wording. Readers see the
topic-specific heading; the attribute is how our software finds the section.
  Wrong: <h2 data-iseo="quick-answer">Quick answer</h2>
  Right: <h2 data-iseo="quick-answer">What a roof replacement runs in Tulsa</h2>
  Wrong: <h2 data-iseo="takeaways">Key Takeaways</h2>
  Right: <h2 data-iseo="takeaways">What to hold on to before you call anyone</h2>

REQUIRED ARTICLE STRUCTURE — you MUST produce every one of these sections, in this exact order. The
blueprint controls HOW you write (opening style, number of body sections, deliberately uneven lengths,
formatting accent, closing style) — it never removes a section. Missing any section is a failure.

1. INTRODUCTION — 2 to 3 short paragraphs, NO heading. Apply the blueprint's opening move. Use the main
   keyword naturally within the first 100 words. Do NOT write a table of contents anywhere; one is
   added automatically after you finish.
2. DIRECT ANSWER — '<h2 data-iseo="quick-answer">' with a topic-specific heading, then exactly ONE <p>
   of 40-60 words that directly answers the core question (written for Google featured snippets and
   voice search).
3. MAIN BODY — the number of '<h2 data-iseo="body">' sections the blueprint specifies (unless a
   numbered title overrides it, see above), with
   deliberately UNEVEN lengths. Each heading is specific and benefit- or question-led. Use <h3>
   sub-points only where they genuinely help. Apply the blueprint's formatting accent. Weave in the
   business and niche details where they earn their place, and put the blueprint's local-proof angle
   in one of these sections.
4. TAKEAWAYS — '<h2 data-iseo="takeaways">' with a topic-specific heading, then ONE <ul> of 3 to 5
   concrete, specific bullet points (no filler, no restating the intro).
5. CLOSING — '<h2 data-iseo="conclusion">' with a natural, specific heading (never the word
   "Conclusion", and never begin a sentence with "In conclusion"). Apply the blueprint's closing move.
6. QUESTIONS — '<h2 data-iseo="faq">' with a topic-specific heading, then EXACTLY 3 question/answer
   pairs, each in this EXACT HTML and nothing else (no <ul>, no numbering):
   <p><strong>Q: the exact question?</strong></p>
   <p>A: a direct answer in 35-50 words.</p>
   One of the three MUST be the provided AI/voice-search question.
7. NEXT STEP — '<h2 data-iseo="whats-next">' with a topic-specific heading, then 2 to 4 sentences that
   deliver the provided call to action naturally (do not use "Don't hesitate" or "Feel free"). If a
   CTA link is provided, include the raw URL so it can be linked.

OUTPUT CONTRACT (follow precisely):
- Output the article as clean HTML using <h2>/<h3>/<p>/<ul>/<li> (and at most one <table> if the accent
  calls for it). No <h1>, no <html>/<body> wrapper, no markdown, no commentary, no code fences.
- Every <h2> carries exactly one data-iseo attribute from: quick-answer, body, takeaways, conclusion,
  faq, whats-next.
- After the article, output a line containing exactly: ${TRAILER_DELIM}
- Then ONE JSON object: {"meta_title": "...", "meta_description": "...", "faq": [{"question":"...","answer":"..."}]}
  - meta_title: 50-60 characters, sentence case, keyword included naturally, no pipes/slashes.
  - meta_description: 150-160 characters, addresses the pain then the outcome, soft CTA, sounds human.
  - faq: the SAME 3 questions and answers that appear in the questions section.
Output nothing after the JSON object.`;

const HUMANIZE_SYSTEM = `You are a ruthless line editor whose only job is to remove machine-writing tells
while preserving meaning, facts, HTML structure, and length.

Apply every pass:
- Break up any run of similarly-sized paragraphs; ensure at least one single-sentence paragraph.
- Increase burstiness: shorten some sentences hard, let others breathe.
- Reduce em-dashes to at most one in the whole piece.
- Delete hedging ("it's important to note", "it's worth noting", "keep in mind that") and hollow
  openers ("Absolutely,", "Certainly,", "Of course,", "Great question").
- Replace any banned buzzwords (utilize→use, leverage→use, robust, seamless, game-changer, comprehensive,
  elevate, unlock) with plain words.
- PRESERVE STRUCTURE EXACTLY: keep every <h2>/<h3> heading AND its data-iseo attribute exactly as
  written, keep the direct answer, every body section, the takeaways <ul>, the closing, all 3 question
  pairs (each "<p><strong>Q: ...?</strong></p>" + answer), and the next-step section. Do NOT drop,
  merge, reorder, or rename sections, and do NOT replace a topic-specific heading with a generic label.
  Edit prose only.
- Do NOT change any number, price, range, date, measurement or count, and do not introduce one
  that is not already in the text. Those figures came from the business; you were not given the
  source and cannot check them.
- Keep all HTML tags intact. Do NOT add commentary.

Return ONLY the revised HTML article — no explanation, no JSON.`;

const DEFAULT_SEO_RULES =
  "Use the main keyword naturally within the first 100 words. Weave in 3-4 of the audience's real " +
  'phrases. Do not repeat any phrase more than twice.';

/**
 * How the writer is told to USE the business details.
 *
 * v2 says "use these exact details", which produces an article that name-drops the business in
 * every section and reads as a sales page. The spec asks for the opposite: details used where a
 * reader would welcome them. Kept as a plain appended string rather than a {{placeholder}} template
 * so a panel edit cannot silently delete the facts themselves.
 */
const DEFAULT_BUSINESS_CONTEXT = `HOW TO USE THE BUSINESS DETAILS:
These are facts about the business this article is written for. Use them where a reader would
genuinely welcome them and where they make the advice concrete, not in every section. Two or three
well-placed, specific uses beat ten generic mentions; an article that mentions the business
everywhere reads as a sales page and gets skimmed.
Never contradict these facts, and never invent beyond them — no prices, guarantees, review counts,
certifications, years in business or service areas that are not listed here. If a detail you would
want is missing, write around it rather than inventing it.`;

// ---------- DB-tunable prompt definitions ----------

export const V3_PROMPT_DEFS = {
  intelligence: {
    templateType: 'content_v3_intelligence' as const,
    displayName: 'Content v3 — Intelligence (audience / LSI / FAQ)',
    fallback: INTEL_SYSTEM,
  },
  generation: {
    templateType: 'content_v3_system' as const,
    displayName: 'Content v3 — Article Writer',
    fallback: GEN_SYSTEM,
  },
  humanize: {
    templateType: 'content_v3_humanize' as const,
    displayName: 'Content v3 — Humanizer (de-tell pass)',
    fallback: HUMANIZE_SYSTEM,
  },
  blueprintDirectives: {
    templateType: 'content_v3_blueprint_directives' as const,
    displayName: 'Content v3 — Blueprint Directives (structure wording, JSON)',
    fallback: JSON.stringify(DEFAULT_BLUEPRINT_DIRECTIVES, null, 2),
  },
  seoRules: {
    templateType: 'content_v3_seo_rules' as const,
    displayName: 'Content v3 — SEO Integration Rules',
    fallback: DEFAULT_SEO_RULES,
  },
  businessContext: {
    templateType: 'content_v3_business_context' as const,
    displayName: 'Content v3 — Business Detail Usage',
    fallback: DEFAULT_BUSINESS_CONTEXT,
  },
};

export type V3PromptDef = (typeof V3_PROMPT_DEFS)[keyof typeof V3_PROMPT_DEFS];

interface ResolvedPrompt {
  text: string;
  source: 'db' | 'fallback';
  templateType: string;
  displayName: string;
}

/**
 * Resolve one tunable prompt, reporting where it came from.
 *
 * getPrompt() throws when the template is missing OR when it has no active version; that throw is
 * the fallback trigger. The warn matters: on a Mongo outage every prompt silently reverts to its
 * in-code constant, which is the right behaviour but a bad thing to discover by reading output.
 */
async function getV3Prompt(def: V3PromptDef): Promise<ResolvedPrompt> {
  const base = { templateType: def.templateType, displayName: def.displayName };
  try {
    const text = await promptService.getPrompt(def.templateType);
    if (text && text.trim()) return { ...base, text, source: 'db' };
    return { ...base, text: def.fallback, source: 'fallback' };
  } catch (e) {
    console.warn(`ℹ️ v3 prompt ${def.templateType}: using in-code fallback (${(e as Error).message})`);
    return { ...base, text: def.fallback, source: 'fallback' };
  }
}

/**
 * How many items a numbered title promises, if it is one.
 *
 * The spec is explicit that a numbered title is a format rather than a type, and that whichever
 * type it is, the article must deliver the number in the title. Asking for that in the system
 * prompt was not enough: the blueprint directive in the user message says "write N body sections"
 * in plain numbers, and that won every time, so seven signs came back bundled into four headings.
 * The conflict has to be resolved before the model sees it.
 *
 * Deliberately narrow: a leading count up to 30. A year or a model number in a title is not a
 * promise of items, and reading it as one would wreck the structure of an ordinary article.
 */
export function titleItemCount(title?: string): number | null {
  if (!title) return null;
  const m = title.match(/^\s*(?:top\s+|the\s+)?(\d{1,2})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 && n <= 30 ? n : null;
}

/** Vary the TOC heading so it is not a fifth identical heading across every article on a site. */
const TOC_HEADINGS = ['Table of contents', "What's covered", 'In this guide', 'Jump to a section'];

function tocHeadingFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TOC_HEADINGS[h % TOC_HEADINGS.length];
}

// ---------- pipeline ----------

export async function generateContentV3(params: GenerateV3Params): Promise<GenerateV3Result> {
  const timings: Record<string, number> = {};
  const usage: Record<string, ClaudeUsage> = {};
  const lang = params.content_lang || 'English (US)';
  const variant = variantFromWords(params.nos_of_words || '1200 to 2400 words');
  const profile: BusinessProfileV3 = params.business_profile || {};
  const wantDiagnostics = params.diagnostics === true;

  // The two projections. Everything downstream takes one of these, never the raw profile.
  const forWriter = contentView(profile);
  const forSchema = schemaView(profile);

  const [intel, gen, humanize, directivesRaw, seoRules, businessContext] = await Promise.all([
    getV3Prompt(V3_PROMPT_DEFS.intelligence),
    getV3Prompt(V3_PROMPT_DEFS.generation),
    getV3Prompt(V3_PROMPT_DEFS.humanize),
    getV3Prompt(V3_PROMPT_DEFS.blueprintDirectives),
    getV3Prompt(V3_PROMPT_DEFS.seoRules),
    getV3Prompt(V3_PROMPT_DEFS.businessContext),
  ]);
  const promptSources: PromptSource[] = [intel, gen, humanize, directivesRaw, seoRules, businessContext].map(
    (p) => ({ templateType: p.templateType, displayName: p.displayName, source: p.source })
  );

  let directivesCfg: BlueprintDirectives;
  try {
    directivesCfg = mergeDirectives(JSON.parse(directivesRaw.text));
  } catch {
    console.warn('⚠️ v3 blueprint directives JSON invalid, using defaults');
    directivesCfg = DEFAULT_BLUEPRINT_DIRECTIVES;
  }

  // ---- Phase 1: intelligence JSON ----
  let intelligence: AudienceIntelligence | null = null;
  const intelUser = buildIntelligenceUser(params, forWriter, lang);
  {
    const t = Date.now();
    try {
      const r = await claudeJSON<AudienceIntelligence>({
        system: intel.text,
        user: intelUser,
        maxTokens: 1800,
      });
      intelligence = r.data;
      usage.intelligence = r.usage;
    } catch (e) {
      console.warn('⚠️ v3 intelligence phase failed, continuing without it:', e);
    }
    timings.intelligence = Date.now() - t;
  }

  // ---- Phase 2: blueprint (no AI) ----
  const blueprint = buildBlueprint({
    keyword: params.seed_keyword,
    niche: params.niche,
    variant,
    seed: params.seed,
    overrides: params.blueprint_overrides,
  });
  let directive = blueprintDirective(blueprint, directivesCfg);
  const promisedItems = titleItemCount(params.title);
  if (promisedItems) {
    // Appended rather than spliced into the directive: the wording above is DB-tunable, so
    // rewriting it by string surgery would break the moment someone edits the template.
    directive +=
      `${EOL_DIRECTIVE}NUMBERED TITLE — THIS REPLACES THE BODY SECTION COUNT ABOVE. The title promises ` +
      `${promisedItems} items, so the article owes the reader exactly ${promisedItems}. Give each one its own ` +
      `<h3> heading inside the body sections, so they can be counted at a glance. Never put two items ` +
      `under one heading, and never deliver more or fewer than ${promisedItems}.`;
  }

  // ---- Phase 3: single-pass generation ----
  const t3 = Date.now();
  const genUser = buildGenerationUserV3(
    params,
    forWriter,
    lang,
    intelligence,
    directive,
    seoRules.text,
    businessContext.text
  );
  const maxTokens = variant === 'large' ? 12000 : variant === 'medium' ? 8000 : 6000;
  const generated = await claudeText({
    system: gen.text,
    user: genUser,
    maxTokens,
    thinking: false,
    model: config.anthropicWriteModel,
  });
  usage.generation = generated.usage;
  timings.generation = Date.now() - t3;

  let { article, trailer } = splitArticleAndTrailer(generated.text);
  let meta = parseTrailer(trailer);
  const articlePreHumanize = article;

  // ---- Phase 4: humanization (optional) ----
  if (params.humanize !== false && article) {
    const t4 = Date.now();
    try {
      const h = await claudeText({
        system: humanize.text,
        user: article,
        maxTokens,
        thinking: false,
        model: config.anthropicWriteModel,
      });
      if (h.text && h.text.length > 100) article = stripFences(h.text);
      usage.humanize = h.usage;
    } catch (e) {
      console.warn('⚠️ v3 humanize phase failed, using un-humanized article:', e);
    }
    timings.humanize = Date.now() - t4;
  }

  if (!meta.meta_title || !meta.meta_description || meta.faq.length === 0) {
    const tr = Date.now();
    meta = await recoverMeta(article, params, meta, usage);
    timings.meta_recovery = Date.now() - tr;
  }

  const metaAttempts: V3Diagnostics['meta_attempts'] = [];
  {
    const tl = Date.now();
    const [fixedTitle, fixedDesc] = await Promise.all([
      enforceMetaLength({
        kind: 'meta_title',
        current: meta.meta_title,
        regenerate: (attempt) => regenerateMetaField('meta_title', article, params, usage, attempt),
        onAttempt: ({ attempt, candidate, accepted }) => {
          metaAttempts.push({
            kind: 'meta_title',
            attempt,
            length: candidate.trim().length,
            accepted,
          });
          console.log(
            `ℹ️ v3 meta_title retry ${attempt} — ${candidate.trim().length} chars, accepted=${accepted}`
          );
        },
      }),
      enforceMetaLength({
        kind: 'meta_description',
        current: meta.meta_description,
        regenerate: (attempt) =>
          regenerateMetaField('meta_description', article, params, usage, attempt),
        onAttempt: ({ attempt, candidate, accepted }) => {
          metaAttempts.push({
            kind: 'meta_description',
            attempt,
            length: candidate.trim().length,
            accepted,
          });
          console.log(
            `ℹ️ v3 meta_description retry ${attempt} — ${candidate.trim().length} chars, accepted=${accepted}`
          );
        },
      }),
    ]);
    meta.meta_title = fixedTitle;
    meta.meta_description = fixedDesc;
    timings.meta_length = Date.now() - tl;
  }

  // ---- Phase 5: assembly ----
  const articlePrePostprocess = article;
  // normalizeHeadings off: that pass force-casts a heading to the literal "Key Takeaways", which is
  // exactly the fingerprint v3 exists to remove. The TOC now honours the blueprint's own decision,
  // which v2 computes and then ignores.
  article = postProcessArticle(article, {
    normalizeHeadings: false,
    includeToc: blueprint.includeToc,
    tocHeading: tocHeadingFor(blueprint.seed),
  });
  const content = `<div class="${V3_WRAPPER_CLASS}">${article}</div>`;
  const faqSchema = buildFaqSchema(meta.faq);

  // Schema is built HERE, after enforceMetaLength, because Article.description is the final meta
  // description. Building it earlier would publish a description that disagrees with the meta tag.
  const schemaWarnings: string[] = [];
  const businessResult = buildBusinessEntity(forSchema, { siteUrl: params.site_url });
  schemaWarnings.push(...businessResult.warnings);

  const availableServices = (profile.services || []).map((s) => s.name);
  const articleResult: ArticleSchemaResult = buildArticleSchema(
    {
      siteUrl: params.site_url,
      postUrl: params.post_url,
      headline: params.title || meta.meta_title,
      description: meta.meta_description,
      imageUrl: params.featured_image_url,
      authorName: profile.business_name,
      datePublished: params.date_published,
      dateModified: params.date_modified,
      language: lang,
      articleType: params.schema_article_type,
      aboutServices: params.services_selected,
    },
    availableServices
  );
  schemaWarnings.push(...articleResult.warnings);

  const result: GenerateV3Result = {
    content,
    meta_title: meta.meta_title,
    meta_description: meta.meta_description,
    faq: meta.faq,
    faq_schema: faqSchema,
    schema: {
      article: articleResult.schema,
      faq: faqSchema,
      business_preview: wantDiagnostics ? businessResult.schema : null,
    },
    blueprint,
    intelligence,
    timings,
    usage,
  };

  if (wantDiagnostics) {
    const audit = auditFields(profile);
    result.diagnostics = {
      prompts: {
        intelligence_system: intel.text,
        intelligence_user: intelUser,
        generation_system: gen.text,
        generation_user: genUser,
        humanize_system: humanize.text,
      },
      prompt_sources: promptSources,
      field_audit: {
        ...audit,
        services_selected_matched: articleResult.matched,
        services_selected_unmatched: articleResult.unmatched,
      },
      leak_check: runLeakCheck(
        profile,
        genUser,
        JSON.stringify({ business: businessResult.schema, article: articleResult.schema })
      ),
      raw: {
        article_pre_humanize: articlePreHumanize,
        article_pre_postprocess: articlePrePostprocess,
        trailer_raw: trailer,
      },
      meta_attempts: metaAttempts,
      blueprint_directive: directive,
      article_type_label: ARTICLE_TYPE_LABELS[params.article_type || 'topic_guide'],
      schema_warnings: schemaWarnings,
      profile_warnings: [],
    };
  }

  return result;
}

// ---------- prompt assembly ----------

/**
 * The intelligence call now sees who the business serves.
 *
 * v2 gives this phase only the keyword and niche, so its "audience psychology" is generic to the
 * trade. The ideal client and the business's own description are exactly the inputs that make it
 * specific, and both are content-feeding fields, so there is nothing to withhold.
 */
function buildIntelligenceUser(
  params: GenerateV3Params,
  p: ContentView,
  lang: string
): string {
  const context = [
    p.description ? `Business: ${p.description}` : '',
    p.ideal_client ? `Their ideal client: ${p.ideal_client}` : '',
    p.niche ? `Niche detail: ${p.niche}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `Keyword: ${params.seed_keyword}
Niche: ${params.niche}
Language: ${lang}
${context ? `\n${context}\n` : ''}
Return JSON exactly in this shape:
{
  "psychology": { "primary_fear": "", "desired_outcome": "", "current_frustration": "", "trust_blockers": "" },
  "search_context": { "urgency_level": "low|medium|high|emergency", "buying_stage": "awareness|consideration|decision", "ai_search_question": "the exact question they'd ask a voice assistant" },
  "niche_voice": { "words_they_use": [], "words_they_avoid": [], "local_references": "" },
  "lsi_keywords": ["8-12 closely related phrases in their vocabulary"],
  "faq_questions": ["3 questions exactly as this customer types them into Google"]
}`;
}

export function buildGenerationUserV3(
  params: GenerateV3Params,
  p: ContentView,
  lang: string,
  intel: AudienceIntelligence | null,
  directive: string,
  seoRules: string,
  businessContext: string
): string {
  const nicheData =
    params.niche_data && Object.keys(params.niche_data).length
      ? Object.entries(params.niche_data)
          .filter(([, v]) => v && v.trim())
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join('\n')
      : '  (none provided)';

  const aud = intel
    ? `Audience primary fear: ${intel.psychology?.primary_fear || ''}
Audience desired outcome: ${intel.psychology?.desired_outcome || ''}
Words they use: ${(intel.niche_voice?.words_they_use || []).join(', ')}
Words they avoid: ${(intel.niche_voice?.words_they_avoid || []).join(', ')}
Buying stage: ${intel.search_context?.buying_stage || ''}
AI/voice search question (use as one FAQ): ${intel.search_context?.ai_search_question || ''}
Customer FAQ questions: ${(intel.faq_questions || []).join(' | ')}
LSI phrases to weave in naturally: ${(intel.lsi_keywords || []).join(', ')}`
    : '(audience intelligence unavailable — infer from the keyword and niche)';

  // The CTA falls back to the saved profile value, so a wizard that sends neither still closes on
  // something the business actually wants the reader to do.
  const ctaMessage = params.call_to_action?.trim() || p.call_to_action?.trim();
  const ctaLink = params.cta_url?.trim() || p.cta_url?.trim();

  return `Write the article now.

Keyword: ${params.seed_keyword}
Title (use as the article's H1 / opening focus): ${params.title || '(create a natural, specific title)'}
Niche: ${params.niche}
Language: ${lang}
This article is ${ARTICLE_TYPE_LABELS[params.article_type || 'topic_guide']}.

AUDIENCE & SEARCH CONTEXT:
${aud}

${businessContext}

BUSINESS DETAILS:
${renderBusinessBlock(p)}

ARTICLE-SPECIFIC DETAILS (labelled):
${nicheData}

CALL TO ACTION (deliver this in the final section):
  - Message: ${ctaMessage || '(none — write a natural closing nudge to get in touch)'}
  - Link: ${ctaLink || '(none)'}

PER-ARTICLE STRUCTURE BLUEPRINT (mandatory — follow exactly):
${directive}

${seoRules}
Produce ALL required sections in order, each <h2> carrying its data-iseo attribute, and every heading
written from this article's own topic rather than a generic label. Remember the OUTPUT CONTRACT:
article HTML, then ${TRAILER_DELIM}, then the JSON trailer.${buildAdditionalInstructionsBlock(params.custom_instruction ?? null)}`;
}

// ---------- shared helpers (same contract as v2) ----------

function stripFences(s: string): string {
  return s.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function splitArticleAndTrailer(raw: string): { article: string; trailer: string } {
  const idx = raw.indexOf(TRAILER_DELIM);
  if (idx === -1) return { article: stripFences(raw), trailer: '' };
  return {
    article: stripFences(raw.slice(0, idx)),
    trailer: raw.slice(idx + TRAILER_DELIM.length).trim(),
  };
}

function parseTrailer(trailer: string): {
  meta_title: string;
  meta_description: string;
  faq: FaqPair[];
} {
  const empty = { meta_title: '', meta_description: '', faq: [] as FaqPair[] };
  if (!trailer) return empty;
  try {
    const obj = parseJsonLoose<{
      meta_title?: string;
      meta_description?: string;
      faq?: FaqPair[];
    }>(trailer);
    return {
      meta_title: (obj.meta_title || '').trim(),
      meta_description: (obj.meta_description || '').trim(),
      faq: Array.isArray(obj.faq)
        ? obj.faq
            .filter((f) => f && f.question && f.answer)
            .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
        : [],
    };
  } catch {
    return empty;
  }
}

async function recoverMeta(
  article: string,
  params: GenerateV3Params,
  partial: { meta_title: string; meta_description: string; faq: FaqPair[] },
  usage: Record<string, ClaudeUsage>
): Promise<{ meta_title: string; meta_description: string; faq: FaqPair[] }> {
  try {
    const plain = article.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const user = `From the article below, output ONLY JSON:
{"meta_title": "50-60 chars, sentence case, includes the keyword naturally, no pipes/slashes",
 "meta_description": "150-160 chars, pain then outcome, soft CTA, human voice",
 "faq": [{"question": "...", "answer": "35-50 words"}]}
The faq MUST be the same 3 Q/A that already appear in the article.
Keyword: ${params.seed_keyword}

Article:
${plain}`;
    const r = await claudeJSON<{
      meta_title?: string;
      meta_description?: string;
      faq?: FaqPair[];
    }>({
      system: 'You write SEO metadata. Return ONLY valid JSON, no prose, no fences.',
      user,
      maxTokens: 900,
    });
    usage.meta_recovery = r.usage;
    const recovered = r.data || {};
    const recoveredFaq = Array.isArray(recovered.faq)
      ? recovered.faq
          .filter((f) => f && f.question && f.answer)
          .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
      : [];
    return {
      meta_title: partial.meta_title || (recovered.meta_title || '').trim(),
      meta_description: partial.meta_description || (recovered.meta_description || '').trim(),
      faq: partial.faq.length ? partial.faq : recoveredFaq,
    };
  } catch (e) {
    console.warn('⚠️ v3 meta recovery failed, returning partial meta:', e);
    return partial;
  }
}

async function regenerateMetaField(
  kind: MetaKind,
  article: string,
  params: GenerateV3Params,
  usage: Record<string, ClaudeUsage>,
  attempt: number
): Promise<string> {
  const plain = article.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const isTitle = kind === 'meta_title';
  const { min, max } = META_BOUNDS[kind];
  const style = isTitle
    ? 'sentence case, include the keyword naturally, no pipes or slashes'
    : "address the reader's pain then the outcome, with a soft CTA, in a human voice";
  const user = `Rewrite ONLY the ${isTitle ? 'meta title' : 'meta description'} for the article below.
HARD REQUIREMENT: the result MUST be between ${min} and ${max} characters, counting every character including spaces. Closer to ${max} is better than under ${min}. Never exceed ${max}.
Style: ${style}.
Return ONLY JSON: {"${kind}": "..."}
Keyword: ${params.seed_keyword}

Article:
${plain}`;
  const r = await claudeJSON<Record<string, string>>({
    system:
      'You write SEO metadata to an exact character budget. Return ONLY valid JSON, no prose, no fences.',
    user,
    maxTokens: 300,
  });
  usage[`meta_len_${kind}_${attempt}`] = r.usage;
  return (r.data?.[kind] || '').trim();
}

function buildFaqSchema(faq: FaqPair[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}
