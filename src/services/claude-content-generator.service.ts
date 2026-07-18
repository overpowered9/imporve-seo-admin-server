/**
 * Claude Content Generator (v2 route).
 *
 * Non-AI-detectable content via:
 *  1. Intelligence JSON  — audience psychology / voice / real customer FAQ questions (1 Claude call).
 *  2. Structure blueprint — per-article variable skeleton (no AI, seeded).
 *  3. Single-pass article — whole piece in one pass (continuous burstiness) + a structured trailer
 *     carrying meta_title (50–60), meta_description (150–160), and the FAQ pairs.
 *  4. Optional humanization — a de-tell editor pass.
 *  5. Assembly — FAQPage JSON-LD + CTA, no uniform section wrappers.
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
  BlueprintDirectives,
  DEFAULT_BLUEPRINT_DIRECTIVES,
  mergeDirectives,
} from './content-blueprint.js';

const promptService = new PromptManagementService();

// Default SEO-integration microcopy appended to the writer's user message. Tunable via the
// `content_v2_seo_rules` DB template; falls back to this string.
const DEFAULT_SEO_RULES =
  "Use the main keyword naturally within the first 100 words. Weave in 3-4 of the audience's real " +
  'phrases. Do not repeat any phrase more than twice.';

export interface BrandProfile {
  business_name?: string;
  location?: { city?: string; state?: string; region?: string; local_details?: string };
  services?: string[];
  differentiators?: string[];
  trust_signals?: string[];
  tone?: string;
}

export interface GenerateV2Params {
  seed_keyword: string;
  niche: string;
  title?: string;
  nos_of_words?: '600 to 1200 words' | '1200 to 2400 words' | '2400 to 3600 words';
  content_lang?: string;
  /** Structured, labelled niche fields (the key v2 change vs the freeform details box). */
  niche_data?: Record<string, string>;
  brand_profile?: BrandProfile;
  call_to_action?: string;
  cta_url?: string;
  /** Run the de-tell humanization pass (default true). */
  humanize?: boolean;
  /** Fixed blueprint seed for reproducible structure (testing). */
  seed?: string;
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

export interface GenerateV2Result {
  content: string;
  meta_title: string;
  meta_description: string;
  faq: FaqPair[];
  faq_schema: Record<string, unknown>;
  blueprint: ContentBlueprint;
  intelligence: AudienceIntelligence | null;
  timings: Record<string, number>;
  usage: Record<string, ClaudeUsage>;
}

const TRAILER_DELIM = '===META_JSON===';

const BANNED =
  '"it\'s important to note", "in conclusion", "game-changer", "seamless", "robust", "utilize", ' +
  '"leverage", "ensure", "dive into", "comprehensive", "in the realm of", "in today\'s world", ' +
  '"it\'s worth noting", "elevate", "unlock", "navigate the landscape", "testament to", "tapestry"';

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

REQUIRED ARTICLE STRUCTURE — you MUST produce every one of these sections, in this exact order. The
blueprint controls HOW you write (opening style, number of body sections, deliberately uneven lengths,
formatting accent, closing style) — it never removes a section. Missing any section is a failure.

1. INTRODUCTION — 2 to 3 short paragraphs, NO heading. Apply the blueprint's opening move. Use the main
   keyword naturally within the first 100 words. Do NOT write a "Table of Contents" anywhere; it is
   added automatically after you finish.
2. QUICK ANSWER — "<h2>Quick answer</h2>" then exactly ONE <p> of 40-60 words that directly answers the
   core question (written for Google featured snippets and voice search).
3. MAIN BODY — the number of <h2> sections the blueprint specifies, with deliberately UNEVEN lengths.
   Each section starts with a specific, descriptive <h2> heading (benefit- or question-led, never generic
   like "Overview" or "Introduction"). Use <h3> sub-points only where they genuinely help. Apply the
   blueprint's formatting accent. Weave in the business/niche details and the audience's real phrases, and
   put the blueprint's local-proof angle in one of these sections.
4. KEY TAKEAWAYS — "<h2>Key Takeaways</h2>" then ONE <ul> of 3 to 5 concrete, specific bullet points
   (no filler, no restating the intro).
5. CONCLUSION — one <h2> with a natural, specific heading (NEVER just the word "Conclusion", and never
   begin a sentence with "In conclusion"). Apply the blueprint's closing move.
6. FREQUENTLY ASKED QUESTIONS — "<h2>Frequently asked questions</h2>" then EXACTLY 3 question/answer
   pairs, each in this EXACT HTML and nothing else (no <ul>, no numbering):
   <p><strong>Q: the exact question?</strong></p>
   <p>A: a direct answer in 35-50 words.</p>
   One of the three MUST be the provided AI/voice-search question.
7. WHAT'S NEXT — "<h2>What's next</h2>" then 2 to 4 sentences that deliver the provided call to action
   naturally (do not use "Don't hesitate" or "Feel free"). If a CTA link is provided, include the raw URL
   so it can be linked.

OUTPUT CONTRACT (follow precisely):
- Output the article as clean HTML using <h2>/<h3>/<p>/<ul>/<li> (and at most one <table> if the accent
  calls for it). No <h1>, no <html>/<body> wrapper, no markdown, no commentary, no code fences.
- After the article, output a line containing exactly: ${TRAILER_DELIM}
- Then ONE JSON object: {"meta_title": "...", "meta_description": "...", "faq": [{"question":"...","answer":"..."}]}
  - meta_title: 50-60 characters, sentence case, keyword included naturally, no pipes/slashes.
  - meta_description: 150-160 characters, addresses the pain then the outcome, soft CTA, sounds human.
  - faq: the SAME 3 questions and answers that appear in the FAQ section.
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
- PRESERVE STRUCTURE EXACTLY: keep every <h2>/<h3> heading, the Quick answer, every body section, the
  Key takeaways <ul>, the Conclusion, all 3 FAQ pairs (each "<p><strong>Q: ...?</strong></p>" + answer),
  and the What's next section. Do NOT drop, merge, reorder, or rename sections. Edit prose only.
- Keep all HTML tags intact. Do NOT add commentary.

Return ONLY the revised HTML article — no explanation, no JSON.`;

// ---------- DB-tunable prompt definitions ----------
// Each v2 system prompt is stored in the prompt-management DB (admin-panel tunable) and falls back to
// the in-code constant above if no active DB version exists. The seed script (seed-content-v2-prompts.ts)
// registers these as templates so prompt engineers can version them from the admin panel.

export const V2_PROMPT_DEFS = {
  intelligence: {
    templateType: 'content_v2_intelligence' as const,
    displayName: 'Content v2 — Intelligence (audience / LSI / FAQ)',
    fallback: INTEL_SYSTEM,
  },
  generation: {
    templateType: 'content_v2_system' as const,
    displayName: 'Content v2 — Article Writer',
    fallback: GEN_SYSTEM,
  },
  humanize: {
    templateType: 'content_v2_humanize' as const,
    displayName: 'Content v2 — Humanizer (de-tell pass)',
    fallback: HUMANIZE_SYSTEM,
  },
  blueprintDirectives: {
    templateType: 'content_v2_blueprint_directives' as const,
    displayName: 'Content v2 — Blueprint Directives (structure wording, JSON)',
    fallback: JSON.stringify(DEFAULT_BLUEPRINT_DIRECTIVES, null, 2),
  },
  seoRules: {
    templateType: 'content_v2_seo_rules' as const,
    displayName: 'Content v2 — SEO Integration Rules',
    fallback: DEFAULT_SEO_RULES,
  },
};

async function getV2Prompt(def: { templateType: string; fallback: string }): Promise<string> {
  try {
    const text = await promptService.getPrompt(def.templateType);
    return text && text.trim() ? text : def.fallback;
  } catch {
    return def.fallback; // no template / no active version → use the in-code constant
  }
}

// ---------- pipeline ----------

export async function generateContentV2(params: GenerateV2Params): Promise<GenerateV2Result> {
  const timings: Record<string, number> = {};
  const usage: Record<string, ClaudeUsage> = {};
  const lang = params.content_lang || 'English (US)';
  const variant = variantFromWords(params.nos_of_words || '1200 to 2400 words');

  // Resolve all tunable prompts from DB (admin-tunable) with in-code fallback.
  const [intelSystem, genSystem, humanizeSystem, directivesRaw, seoRules] = await Promise.all([
    getV2Prompt(V2_PROMPT_DEFS.intelligence),
    getV2Prompt(V2_PROMPT_DEFS.generation),
    getV2Prompt(V2_PROMPT_DEFS.humanize),
    getV2Prompt(V2_PROMPT_DEFS.blueprintDirectives),
    getV2Prompt(V2_PROMPT_DEFS.seoRules),
  ]);

  // Parse the admin-edited blueprint directives (JSON); bad/partial JSON falls back per-key.
  let directivesCfg: BlueprintDirectives;
  try {
    directivesCfg = mergeDirectives(JSON.parse(directivesRaw));
  } catch {
    console.warn('⚠️ v2 blueprint directives JSON invalid, using defaults');
    directivesCfg = DEFAULT_BLUEPRINT_DIRECTIVES;
  }

  // ---- Phase 1: intelligence JSON ----
  let intelligence: AudienceIntelligence | null = null;
  {
    const t = Date.now();
    const user = `Keyword: ${params.seed_keyword}
Niche: ${params.niche}
Language: ${lang}

Return JSON exactly in this shape:
{
  "psychology": { "primary_fear": "", "desired_outcome": "", "current_frustration": "", "trust_blockers": "" },
  "search_context": { "urgency_level": "low|medium|high|emergency", "buying_stage": "awareness|consideration|decision", "ai_search_question": "the exact question they'd ask a voice assistant" },
  "niche_voice": { "words_they_use": [], "words_they_avoid": [], "local_references": "" },
  "lsi_keywords": ["8-12 closely related phrases in their vocabulary"],
  "faq_questions": ["3 questions exactly as this customer types them into Google"]
}`;
    try {
      const r = await claudeJSON<AudienceIntelligence>({ system: intelSystem, user, maxTokens: 1800 });
      intelligence = r.data;
      usage.intelligence = r.usage;
    } catch (e) {
      console.warn('⚠️ v2 intelligence phase failed, continuing without it:', e);
    }
    timings.intelligence = Date.now() - t;
  }

  // ---- Phase 2: blueprint (no AI) ----
  const blueprint = buildBlueprint({
    keyword: params.seed_keyword,
    niche: params.niche,
    variant,
    seed: params.seed,
  });
  const directive = blueprintDirective(blueprint, directivesCfg);

  // ---- Phase 3: single-pass generation ----
  const t3 = Date.now();
  const genUser = buildGenerationUser(params, lang, intelligence, directive, seoRules);
  const maxTokens = variant === 'large' ? 12000 : variant === 'medium' ? 8000 : 6000;
  // Thinking OFF for the writing pass: the blueprint already plans structure, and adaptive-thinking
  // tokens consume the same max_tokens budget (starving the article). Use the higher-quality write model.
  const gen = await claudeText({ system: genSystem, user: genUser, maxTokens, thinking: false, model: config.anthropicWriteModel });
  usage.generation = gen.usage;
  timings.generation = Date.now() - t3;

  let { article, trailer } = splitArticleAndTrailer(gen.text);
  let meta = parseTrailer(trailer);

  // ---- Phase 4: humanization (optional) ----
  if (params.humanize !== false && article) {
    const t4 = Date.now();
    try {
      const h = await claudeText({
        system: humanizeSystem,
        user: article,
        maxTokens,
        thinking: false,
        model: config.anthropicWriteModel,
      });
      if (h.text && h.text.length > 100) article = stripFences(h.text);
      usage.humanize = h.usage;
    } catch (e) {
      console.warn('⚠️ v2 humanize phase failed, using un-humanized article:', e);
    }
    timings.humanize = Date.now() - t4;
  }

  // Harden the output contract: if the model didn't emit a usable trailer (e.g. a prompt edit broke
  // the format), recover meta + FAQ from the finished article so generation never returns empty SEO
  // fields. This is the safety net that lets prompt engineers edit GEN_SYSTEM without bricking output.
  if (!meta.meta_title || !meta.meta_description || meta.faq.length === 0) {
    const tr = Date.now();
    meta = await recoverMeta(article, params, meta, usage);
    timings.meta_recovery = Date.now() - tr;
  }

  // Enforce the meta length budgets (title 50-60, description 150-160). When a field is
  // out of range we re-run its own prompt a few times and keep the first compliant result;
  // enforceMetaLength hard-caps to the max as a last resort so we never emit an over-length tag.
  {
    const tl = Date.now();
    const [fixedTitle, fixedDesc] = await Promise.all([
      enforceMetaLength({
        kind: 'meta_title',
        current: meta.meta_title,
        regenerate: (attempt) => regenerateMetaField('meta_title', article, params, usage, attempt),
        onAttempt: ({ attempt, candidate, accepted }) =>
          console.log(`ℹ️ v2 meta_title retry ${attempt} — ${candidate.trim().length} chars, accepted=${accepted}`),
      }),
      enforceMetaLength({
        kind: 'meta_description',
        current: meta.meta_description,
        regenerate: (attempt) => regenerateMetaField('meta_description', article, params, usage, attempt),
        onAttempt: ({ attempt, candidate, accepted }) =>
          console.log(`ℹ️ v2 meta_description retry ${attempt} — ${candidate.trim().length} chars, accepted=${accepted}`),
      }),
    ]);
    meta.meta_title = fixedTitle;
    meta.meta_description = fixedDesc;
    timings.meta_length = Date.now() - tl;
  }

  // ---- Phase 5: assembly + deterministic post-processing ----
  // Defensive fixes (markdown→HTML, anchor repair, em-dash guard, whitespace cleanup, code-built TOC
  // with matching ids, email/URL linkification). See content-postprocess.ts.
  article = postProcessArticle(article);
  const content = `<div class="improveseo-v2-content">${article}</div>`;
  const faqSchema = buildFaqSchema(meta.faq);

  return {
    content,
    meta_title: meta.meta_title,
    meta_description: meta.meta_description,
    faq: meta.faq,
    faq_schema: faqSchema,
    blueprint,
    intelligence,
    timings,
    usage,
  };
}

// ---------- helpers ----------

function buildGenerationUser(
  params: GenerateV2Params,
  lang: string,
  intel: AudienceIntelligence | null,
  directive: string,
  seoRules: string
): string {
  const nicheData = params.niche_data && Object.keys(params.niche_data).length
    ? Object.entries(params.niche_data)
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join('\n')
    : '  (none provided)';

  const bp = params.brand_profile;
  const brandLines = bp
    ? [
        bp.business_name ? `  - Business: ${bp.business_name}` : '',
        bp.location?.city ? `  - Location: ${[bp.location.city, bp.location.state].filter(Boolean).join(', ')}` : '',
        bp.location?.local_details ? `  - Local detail: ${bp.location.local_details}` : '',
        bp.services?.length ? `  - Services: ${bp.services.join(', ')}` : '',
        bp.differentiators?.length ? `  - Differentiators: ${bp.differentiators.join(', ')}` : '',
        bp.trust_signals?.length ? `  - Trust signals: ${bp.trust_signals.join(', ')}` : '',
      ].filter(Boolean).join('\n')
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

  return `Write the article now.

Keyword: ${params.seed_keyword}
Title (use as the article's H1 / opening focus): ${params.title || '(create a natural, specific title)'}
Niche: ${params.niche}
Language: ${lang}

AUDIENCE & SEARCH CONTEXT:
${aud}

BUSINESS CONTEXT — use these exact details, do not contradict or invent beyond them:
NICHE DATA (labelled):
${nicheData}
BRAND PROFILE:
${brandLines}

CALL TO ACTION (deliver this in the "What's next" section):
  - Message: ${params.call_to_action && params.call_to_action.trim() ? params.call_to_action.trim() : '(none — write a natural closing nudge to get in touch)'}
  - Link: ${params.cta_url && params.cta_url.trim() ? params.cta_url.trim() : '(none)'}

PER-ARTICLE STRUCTURE BLUEPRINT (mandatory — follow exactly):
${directive}

${seoRules}
Produce ALL required sections (Intro, Quick answer, the body sections, Key takeaways, Conclusion, FAQ, What's next). Remember the OUTPUT CONTRACT: article HTML, then ${TRAILER_DELIM}, then the JSON trailer.`;
}

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

function parseTrailer(trailer: string): { meta_title: string; meta_description: string; faq: FaqPair[] } {
  const empty = { meta_title: '', meta_description: '', faq: [] as FaqPair[] };
  if (!trailer) return empty;
  try {
    const obj = parseJsonLoose<{ meta_title?: string; meta_description?: string; faq?: FaqPair[] }>(trailer);
    return {
      meta_title: (obj.meta_title || '').trim(),
      meta_description: (obj.meta_description || '').trim(),
      faq: Array.isArray(obj.faq)
        ? obj.faq.filter((f) => f && f.question && f.answer).map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
        : [],
    };
  } catch {
    return empty;
  }
}

/**
 * Safety net for the output contract. When the trailer is missing or partial, derive meta_title,
 * meta_description and the FAQ pairs from the finished article. Only fills what's missing.
 */
async function recoverMeta(
  article: string,
  params: GenerateV2Params,
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
    const r = await claudeJSON<{ meta_title?: string; meta_description?: string; faq?: FaqPair[] }>({
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
    console.warn('⚠️ v2 meta recovery failed, returning partial meta:', e);
    return partial;
  }
}

/**
 * Re-prompt a single meta field to a strict character budget, sourced from the finished
 * article. Used by enforceMetaLength when the trailer/recovered value is out of range.
 */
async function regenerateMetaField(
  kind: MetaKind,
  article: string,
  params: GenerateV2Params,
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
    system: 'You write SEO metadata to an exact character budget. Return ONLY valid JSON, no prose, no fences.',
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
