/**
 * Claude Content Generator (v2 route).
 *
 * Non-AI-detectable content via:
 *  1. Intelligence JSON  — audience psychology / voice / real customer FAQ questions (1 Claude call).
 *  2. Structure blueprint — per-article variable skeleton (no AI, seeded).
 *  3. Single-pass article — whole piece in one pass (continuous burstiness) + a structured trailer
 *     carrying meta_title, meta_description (140–155), and the FAQ pairs.
 *  4. Optional humanization — a de-tell editor pass.
 *  5. Assembly — FAQPage JSON-LD + CTA, no uniform section wrappers.
 */

import { claudeText, claudeJSON, parseJsonLoose, ClaudeUsage } from './claude.service.js';
import { PromptManagementService } from './prompt-management.service.js';
import {
  buildBlueprint,
  blueprintDirective,
  variantFromWords,
  ContentBlueprint,
} from './content-blueprint.js';

const promptService = new PromptManagementService();

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

STRUCTURE PHILOSOPHY:
- Follow the per-article blueprint you are given EXACTLY. Do not fall back to a generic
  intro → equal sections → conclusion → FAQ template. The blueprint's opening move, uneven section
  lengths, formatting accent, FAQ placement, and closing move are mandatory.

OUTPUT CONTRACT (follow precisely):
- First output the article as clean HTML using <h2>/<h3>/<p> and, only if the blueprint asks for it,
  one <ul> or one simple <table>. No <html>/<body> wrapper, no markdown, no commentary.
- The article body MUST contain the FAQ as HTML (each question in <strong> tags).
- Then output a line containing exactly: ${TRAILER_DELIM}
- Then output ONE JSON object: {"meta_title": "...", "meta_description": "...", "faq": [{"question":"...","answer":"..."}]}
  - meta_title: 50-60 characters, sentence case, keyword included naturally, no pipes/slashes.
  - meta_description: 140-155 characters, addresses the pain then the outcome, soft CTA, sounds human.
  - faq: the SAME questions and answers that appear in the article body (answers 35-50 words).
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
- Keep all HTML tags and the FAQ intact. Do NOT add commentary.

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

  // Resolve the three system prompts from DB (admin-tunable) with in-code fallback.
  const [intelSystem, genSystem, humanizeSystem] = await Promise.all([
    getV2Prompt(V2_PROMPT_DEFS.intelligence),
    getV2Prompt(V2_PROMPT_DEFS.generation),
    getV2Prompt(V2_PROMPT_DEFS.humanize),
  ]);

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
  const directive = blueprintDirective(blueprint);

  // ---- Phase 3: single-pass generation ----
  const t3 = Date.now();
  const genUser = buildGenerationUser(params, lang, intelligence, directive);
  const maxTokens = variant === 'large' ? 12000 : variant === 'medium' ? 8000 : 5000;
  // Thinking OFF for the writing pass: the blueprint already plans structure, and on Sonnet
  // adaptive-thinking tokens consume the same max_tokens budget (starving the article).
  const gen = await claudeText({ system: genSystem, user: genUser, maxTokens, thinking: false });
  usage.generation = gen.usage;
  timings.generation = Date.now() - t3;

  let { article, trailer } = splitArticleAndTrailer(gen.text);
  const meta = parseTrailer(trailer);

  // ---- Phase 4: humanization (optional) ----
  if (params.humanize !== false && article) {
    const t4 = Date.now();
    try {
      const h = await claudeText({
        system: humanizeSystem,
        user: article,
        maxTokens,
        thinking: false,
      });
      if (h.text && h.text.length > 100) article = stripFences(h.text);
      usage.humanize = h.usage;
    } catch (e) {
      console.warn('⚠️ v2 humanize phase failed, using un-humanized article:', e);
    }
    timings.humanize = Date.now() - t4;
  }

  // ---- Phase 5: assembly ----
  // Deterministic em-dash guard: em-dash overuse is the single highest-signal AI tell, and the model
  // won't reliably self-limit. Convert spaced/standalone em-dashes to commas (keeps en-dashes in
  // numeric ranges like "$180–$350" untouched).
  article = article.replace(/\s*—\s*/g, ', ');
  const ctaHtml = buildCtaHtml(params);
  const content = `<div class="improveseo-v2-content">${article}${ctaHtml}</div>`;
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
  directive: string
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

PER-ARTICLE STRUCTURE BLUEPRINT (mandatory — follow exactly):
${directive}

Use the main keyword naturally within the first 100 words. Weave in 3-4 of the audience's real phrases.
Do not repeat any phrase more than twice. Remember the OUTPUT CONTRACT: article HTML, then ${TRAILER_DELIM}, then the JSON trailer.`;
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

function buildCtaHtml(params: GenerateV2Params): string {
  const cta = (params.call_to_action || '').trim();
  if (!cta) return '';
  const url = (params.cta_url || '').trim();
  const text = url
    ? `${cta} <a href="${url}" target="_blank" rel="noopener">${url}</a>`
    : cta;
  return `<p class="improveseo-cta">${text}</p>`;
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
