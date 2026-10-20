/**
 * Structure Blueprint — the anti-uniformity engine for the v2 content route.
 *
 * The conversational generator produces one fixed skeleton every time (intro+TOC → N uniform
 * sections → conclusion → FAQ → what's-next). That repetition is a site-level footprint Google flags.
 *
 * This module picks a DIFFERENT structure per article using a deterministic, seeded weighted-random
 * selector. No AI call. Same niche + same keyword on different runs (different timestamp seed) → a
 * different skeleton, so two articles in the same niche don't share a shape. It is fully unit-testable:
 * pass a fixed seed to reproduce a blueprint.
 */

export type WordCountVariant = 'small' | 'medium' | 'large';

export type OpeningMove =
  | 'lived_scenario'
  | 'direct_question'
  | 'contrarian_claim'
  | 'micro_anecdote'
  | 'myth_correction';

export type Accent = 'none' | 'short_list' | 'comparison_table' | 'pull_quote';
export type FaqPlacement = 'end' | 'woven';
export type CloseMove = 'forward_question' | 'soft_fade' | 'single_punch_line' | 'practical_next_step';

export const OPENING_MOVES: OpeningMove[] = [
  'lived_scenario',
  'direct_question',
  'contrarian_claim',
  'micro_anecdote',
  'myth_correction',
];
export const ACCENTS: Accent[] = ['none', 'short_list', 'comparison_table', 'pull_quote'];
export const FAQ_PLACEMENTS: FaqPlacement[] = ['end', 'woven'];
export const CLOSE_MOVES: CloseMove[] = [
  'forward_question',
  'soft_fade',
  'single_punch_line',
  'practical_next_step',
];
export const POV_OPTIONS: string[] = [
  'first person plural (we, our, us)',
  'first person singular (I, my, me)',
  'third person',
];

/**
 * Structure chosen by hand instead of drawn.
 *
 * The seeded random exists so two articles in a niche do not share a skeleton. That is right for
 * production and wrong for a tuning session, where you need to hold the structure still and change
 * one thing. Any field left undefined is still drawn from the seed, so a partial override pins only
 * what it names.
 */
export interface BlueprintOverrides {
  openingMove?: OpeningMove;
  includeToc?: boolean;
  sectionCount?: number;
  accent?: Accent;
  faqPlacement?: FaqPlacement;
  closeMove?: CloseMove;
  pov?: string;
}

export interface ContentBlueprint {
  seed: string;
  variant: WordCountVariant;
  openingMove: OpeningMove;
  includeToc: boolean;
  sectionCount: number;
  /** Non-uniform target word counts per body section (intentionally uneven). */
  sectionWordTargets: number[];
  accent: Accent;
  faqPlacement: FaqPlacement;
  faqCount: number;
  closeMove: CloseMove;
  /** Resolved point of view (we / I / third person) — driven by niche, never user-chosen. */
  pov: string;
  /** Human-readable description injected into the generation prompt. */
  directive: string;
}

// ----- niche → POV (resolved server-side, dropdown removed from UI) -----
const LOCAL_SERVICE_NICHES = new Set([
  'hvac', 'plumbing', 'electrical', 'roofing', 'contractor', 'landscaping', 'home_services',
  'dental', 'medical', 'wellness', 'legal', 'legal_services', 'personal_injury_law', 'family_law',
  'realestate', 'real_estate', 'mortgage', 'accounting', 'education', 'restaurant', 'fitness',
  'beauty', 'salon', 'spa', 'pet', 'pet_services', 'vet', 'auto_repair',
]);
const PERSONAL_NICHES = new Set(['general_blog', 'blog', 'personal_blog']);

export function resolvePov(niche: string): string {
  const key = (niche || '').toLowerCase().trim().replace(/[\s/]+/g, '_');
  if (LOCAL_SERVICE_NICHES.has(key)) return 'first person plural (we, our, us)';
  if (PERSONAL_NICHES.has(key)) return 'first person singular (I, my, me)';
  return 'third person';
}

// ----- seeded RNG (mulberry32 over a string hash) -----
function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, options: T[]): T {
  return options[Math.floor(rng() * options.length)];
}

const VARIANT_BUDGET: Record<WordCountVariant, { total: number; minSections: number; maxSections: number }> = {
  small: { total: 950, minSections: 3, maxSections: 4 },
  medium: { total: 1800, minSections: 4, maxSections: 5 },
  large: { total: 3000, minSections: 5, maxSections: 6 },
};

export function variantFromWords(nos_of_words: string): WordCountVariant {
  if (nos_of_words === '600 to 1200 words') return 'small';
  if (nos_of_words === '2400 to 3600 words') return 'large';
  return 'medium';
}

/** Build a non-uniform length vector that sums to ~bodyTarget (no two sections identical). */
function nonUniformLengths(rng: () => number, count: number, bodyTarget: number): number[] {
  const weights = Array.from({ length: count }, () => 0.6 + rng() * 0.9); // 0.6–1.5
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((w / sum) * bodyTarget / 10) * 10);
}

export function buildBlueprint(params: {
  keyword: string;
  niche: string;
  variant: WordCountVariant;
  seed?: string;
  overrides?: BlueprintOverrides;
}): ContentBlueprint {
  const ov = params.overrides ?? {};
  const seed = params.seed ?? `${params.keyword}|${params.niche}|${Date.now()}`;
  const rng = mulberry32(hashSeed(seed));
  const budget = VARIANT_BUDGET[params.variant];

  const drawnSectionCount =
    budget.minSections + Math.floor(rng() * (budget.maxSections - budget.minSections + 1));

  const drawnOpening = pick<OpeningMove>(rng, [
    'lived_scenario', 'direct_question', 'contrarian_claim', 'micro_anecdote', 'myth_correction',
  ]);
  // TOC is rare on short pieces, occasional on large.
  const drawnToc = params.variant === 'large' ? rng() < 0.5 : rng() < 0.15;
  const drawnAccent = pick<Accent>(rng, ['none', 'none', 'short_list', 'comparison_table', 'pull_quote']);
  const drawnFaqPlacement = pick<FaqPlacement>(rng, ['end', 'end', 'woven']);
  const drawnClose = pick<CloseMove>(rng, [
    'forward_question', 'soft_fade', 'single_punch_line', 'practical_next_step',
  ]);

  // Clamp rather than reject: the picker offers only sane counts, but a hand-written request
  // asking for 40 sections should produce a long article, not a broken one.
  const sectionCount = Math.min(12, Math.max(1, Math.round(ov.sectionCount ?? drawnSectionCount)));
  const openingMove = ov.openingMove ?? drawnOpening;
  const includeToc = ov.includeToc ?? drawnToc;
  const accent = ov.accent ?? drawnAccent;
  const faqPlacement = ov.faqPlacement ?? drawnFaqPlacement;
  const closeMove = ov.closeMove ?? drawnClose;
  const faqCount = 3;

  // reserve budget for intro (~120) + faq (~150) + cta (~80)
  const bodyTarget = Math.max(300, budget.total - 350);
  const sectionWordTargets = nonUniformLengths(rng, sectionCount, bodyTarget);

  return {
    seed,
    variant: params.variant,
    openingMove,
    includeToc,
    sectionCount,
    sectionWordTargets,
    accent,
    faqPlacement,
    faqCount,
    closeMove,
    pov: ov.pov ?? resolvePov(params.niche),
    directive: '', // filled below
  };
}

/**
 * Directive wording — the prose injected into the generation prompt for each blueprint choice.
 * This is the TUNABLE structural layer: prompt engineers edit these strings (stored as JSON in the
 * `content_v2_blueprint_directives` DB template) to change how openings/accents/closings/FAQ/POV are
 * phrased, WITHOUT touching the deterministic selection logic above. Placeholders: {count}, {placement},
 * {pov}. Unknown/missing keys fall back to these defaults via mergeDirectives().
 */
export interface BlueprintDirectives {
  opening: Record<OpeningMove, string>;
  accent: Record<Accent, string>;
  close: Record<CloseMove, string>;
  tocOn: string;
  tocOff: string;
  bodyIntro: string; // {count}
  faqEnd: string;
  faqWoven: string;
  faqLine: string; // {count}, {placement}
  povLine: string; // {pov}
}

export const DEFAULT_BLUEPRINT_DIRECTIVES: BlueprintDirectives = {
  opening: {
    lived_scenario: 'Open mid-scene with a real situation this reader has lived. No statistics, no "In today\'s world".',
    direct_question: 'Open with the exact question this reader would type or speak, then answer it head-on.',
    contrarian_claim: 'Open with a specific contrarian claim that challenges common advice in this niche.',
    micro_anecdote: 'Open with a short, concrete two-sentence anecdote — a single moment, not a summary.',
    myth_correction: 'Open by naming a widespread myth in this niche and correcting it immediately.',
  },
  accent: {
    none: 'Use flowing prose only — no bulleted lists or tables in the body.',
    short_list: 'Include exactly ONE short bulleted list (3–5 items) where it genuinely helps; everything else is prose.',
    comparison_table: 'Include exactly ONE small comparison table (2 columns, 3–4 rows) where a tradeoff is being weighed.',
    pull_quote: 'Include exactly ONE short pull-quote line (a single emphasized sentence on its own) — no blockquote spam.',
  },
  close: {
    forward_question: 'Close by turning the topic forward with a question the reader should now ask themselves.',
    soft_fade: 'Close on a quiet, concrete note — no summary, no "In conclusion".',
    single_punch_line: 'Close with one short, blunt sentence that lands the main point.',
    practical_next_step: 'Close with the single most useful next step the reader can take today.',
  },
  tocOn: 'Include a short linked table of contents after the intro.',
  tocOff: 'Do NOT include a table of contents.',
  bodyIntro: 'Write {count} body sections with DELIBERATELY UNEVEN lengths (do not make them equal):',
  faqEnd: 'near the end',
  faqWoven: 'woven near the most relevant section',
  faqLine: 'Place a {count}-question FAQ {placement}.',
  povLine: 'Write in {pov}.',
};

/** Deep-merge a partial (admin-edited) directives object over the defaults; tolerant of garbage. */
export function mergeDirectives(partial: unknown): BlueprintDirectives {
  const d = DEFAULT_BLUEPRINT_DIRECTIVES;
  if (!partial || typeof partial !== 'object') return d;
  const p = partial as Partial<BlueprintDirectives>;
  return {
    opening: { ...d.opening, ...(p.opening as object) },
    accent: { ...d.accent, ...(p.accent as object) },
    close: { ...d.close, ...(p.close as object) },
    tocOn: p.tocOn || d.tocOn,
    tocOff: p.tocOff || d.tocOff,
    bodyIntro: p.bodyIntro || d.bodyIntro,
    faqEnd: p.faqEnd || d.faqEnd,
    faqWoven: p.faqWoven || d.faqWoven,
    faqLine: p.faqLine || d.faqLine,
    povLine: p.povLine || d.povLine,
  };
}

/** Render the blueprint into prose constraints for the generation prompt. */
export function blueprintDirective(
  bp: ContentBlueprint,
  dirs: BlueprintDirectives = DEFAULT_BLUEPRINT_DIRECTIVES
): string {
  const lengths = bp.sectionWordTargets.map((n, i) => `  - Section ${i + 1}: ~${n} words`).join('\n');
  const placement = bp.faqPlacement === 'woven' ? dirs.faqWoven : dirs.faqEnd;
  return [
    `OPENING: ${dirs.opening[bp.openingMove] || DEFAULT_BLUEPRINT_DIRECTIVES.opening[bp.openingMove]}`,
    `BODY: ${dirs.bodyIntro.replace('{count}', String(bp.sectionCount))}`,
    lengths,
    `FORMATTING ACCENT: ${dirs.accent[bp.accent] || DEFAULT_BLUEPRINT_DIRECTIVES.accent[bp.accent]}`,
    `FAQ: ${dirs.faqLine.replace('{count}', String(bp.faqCount)).replace('{placement}', placement)}`,
    `CLOSING: ${dirs.close[bp.closeMove] || DEFAULT_BLUEPRINT_DIRECTIVES.close[bp.closeMove]}`,
    `POINT OF VIEW: ${dirs.povLine.replace('{pov}', bp.pov)}`,
  ].join('\n');
}
