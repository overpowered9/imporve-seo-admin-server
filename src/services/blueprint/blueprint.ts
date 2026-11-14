/**
 * Blueprint (#5 with #6), built by code — docs/content-v3-prompt-drafts.md "How code assembles the
 * blueprint", steps 1–7 (B1–B12). No model call.
 *
 * 1 LOAD the pieces (pieces.ts / the editable record).   2 PINS (tester panel, admin only).
 * 3 DRAW a–m in order.   4 CHECK against the site's history.   5 ASSEMBLE in the fixed order.
 * 6 WRAP in <blueprint>.   7 SAVE the picks (the caller stores `picks` + `fingerprint` per post).
 *
 * Determinism: every random choice goes through `rng`, so a seeded rng gives the same blueprint.
 *
 * Working values (the doc leaves the exact numbers open; flagged in the progress doc):
 *  - front-heavy / back-heavy shares fall / rise linearly between 1.4 and 0.7 (the same spread the
 *    doc gives for alternating; a steeper split starved the last sections at the bottom-of-range aim);
 *  - "draw one section fewer" never goes below the size's range minimum; if a section is still under
 *    120 words there, it is raised to 120 and the difference taken from the longest sections;
 *  - step 3m aims a quarter of the way into the chosen range (AIM_BOTTOM), not at its edge;
 *  - the section count never goes above the Planner's body questions plus the optional elements to
 *    cover (but never below the size's minimum), as in the doc's own example (4 sections over 3
 *    questions + 2 "Also cover" elements); 3m "takes more" questions only while they last (C12);
 *  - calibrated word targets (decision 14 Nov): the BODY line carries word_targets × the size's
 *    factor (`targetScale`, config CONTENT_V3_TARGET_CALIBRATION_JSON) as `writer_targets`, because
 *    the Writer delivers ~95 / 70 / 55% of its targets on Small / Medium / Large. Numbers only: the
 *    sentence's wording is unchanged. The picks keep the doc-formula targets;
 *  - the 40% spread limit applies once the site has at least 5 earlier v3 posts;
 *  - numbered titles: items under 2–3 grouping H2s from 8 items up, else items as H2 sections;
 *  - an optional element marked "(supplied only)" is drawn only when the business details hold
 *    something to say; "(sourced or supplied only)" only when a price is available.
 */
import { createHash } from 'node:crypto';
import type { PostSize } from '../content-v3-steps/types.js';
import {
  ACCENTS,
  BLUEPRINT_PIECES_V1,
  CLOSING_FORMATS,
  CLOSING_MOVES,
  LENGTH_PATTERNS,
  OPENINGS,
  TYPE_PIECE_KEYS,
  type Accent,
  type ClosingFormat,
  type ClosingMove,
  type FirmnessLevel,
  type LengthPattern,
  type Opening,
} from './pieces.js';

export type ArticleType = 'cost' | 'decision' | 'question' | 'topic';
export type SummaryForm = 'quick_answer' | 'takeaways';
export type LastOrder = 'faq_first' | 'closing_first';

const SIZES: PostSize[] = ['small', 'medium', 'large'];
export const SECTION_RANGE: Record<PostSize, [number, number]> = { small: [2, 3], medium: [4, 6], large: [6, 9] };
export const OPTIONAL_RANGE: Record<PostSize, [number, number]> = { small: [0, 1], medium: [1, 2], large: [2, 3] };
export const FAQ_COUNT: Record<PostSize, number> = { small: 3, medium: 4, large: 5 };
/** Step 3l: middle of each size's range, and the fixed parts (introduction, summary, FAQ, closing). */
export const AIM_MIDDLE: Record<PostSize, number> = { small: 900, medium: 1800, large: 3000 };
/**
 * Step 3m: "aim at the bottom of the chosen size's range" — read as the lower quarter of the range,
 * not its edge. Working value (14 Nov 10-keyword run): aimed at exactly 2,400, a Large article came
 * out at 2,155 words twice (the Writer lands ~8% under its targets) and failed the size check.
 */
export const AIM_BOTTOM: Record<PostSize, number> = { small: 750, medium: 1500, large: 2700 };
export const FIXED_PARTS: Record<PostSize, number> = { small: 380, medium: 450, large: 540 };
export const MIN_SECTION_WORDS = 120;
export const MAX_NUMBERED_ITEMS = 15;

export interface BlueprintPins {
  article_type?: ArticleType;
  opening?: Opening;
  length_pattern?: LengthPattern;
  accent?: Accent;
  summary?: { form: SummaryForm; points?: 3 | 4 | 5; list?: 'bullets' | 'numbered' };
  /** Element labels as the pool names them (multi-select). */
  optional_elements?: string[];
  order?: LastOrder;
  closing_move?: ClosingMove;
  closing_format?: ClosingFormat;
  firmness?: FirmnessLevel;
  toc?: boolean;
}

export interface HistoryPost {
  article_type?: string | null;
  picks: Partial<BlueprintPicks> & Record<string, unknown>;
  fingerprint?: string | null;
}

export interface BlueprintInput {
  articleType: ArticleType;
  /** The size the user chose (step 2). */
  postSize: PostSize;
  /** The Planner's suggestion; a larger chosen size triggers step 3m. */
  suggestedSize?: PostSize;
  title: string;
  /** From the Title step (form/items) or the title check. */
  titleForm?: string | null;
  titleItems?: number | null;
  reach: 'local' | 'nationwide';
  readiness?: string | null;
  bodyQuestions: string[];
  faqQuestions: string[];
  /** The niche profile's firmest allowed closing (N5). */
  firmest: FirmnessLevel;
  /** B8: a currency amount in the research facts or the Business details pricing field. */
  priceAvailable: boolean;
  /** The business details hold something for "(supplied only)" elements. */
  businessSupplied: boolean;
  pins?: BlueprintPins;
  /** The site's last 20 v3 posts (newest first), plus this bulk batch's earlier articles. */
  history?: HistoryPost[];
  rng?: () => number;
  pieces?: Readonly<Record<string, string>>;
  /** Calibration factor for this size's word targets in the BODY line (A1); default 1. */
  targetScale?: number;
}

export interface NumberedPick {
  items: number;
  kind: string;
  min_words: number;
  grouping: 'h2_items' | 'grouped_h3';
  order_by: 'priority' | 'sequence' | 'cost' | 'season';
}

export interface BlueprintPicks {
  article_type: ArticleType;
  no_figure: boolean;
  summary_form: SummaryForm;
  takeaway_points: 3 | 4 | 5 | null;
  takeaway_list: 'bullets' | 'numbered' | null;
  opening: Opening;
  sections: number;
  optional_elements: string[];
  length_pattern: LengthPattern;
  accent: Accent;
  faq_count: number;
  order: LastOrder;
  closing_move: ClosingMove;
  closing_format: ClosingFormat;
  firmness: FirmnessLevel;
  toc: boolean;
  /** The doc's formula (aim minus fixed parts, split by the pattern). */
  word_targets: number[];
  /** What the BODY line tells the Writer: word_targets × the size's calibration factor (A1). */
  writer_targets: number[];
  larger_than_suggested: boolean;
  numbered: NumberedPick | null;
  topic_triggers: string[];
}

export interface BlueprintResult {
  block: string;
  picks: BlueprintPicks;
  fingerprint: string;
  redraws: number;
  /** True when 5 redraws did not clear the history checks and the last draw was accepted. */
  accepted_after_max: boolean;
}

// ---------------------------------------------------------------- helpers

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, options: readonly T[]): T {
  return options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
}

function intIn(rng: () => number, [lo, hi]: [number, number]): number {
  return lo + Math.min(hi - lo, Math.floor(rng() * (hi - lo + 1)));
}

const rank = (s: PostSize) => SIZES.indexOf(s);
const roundTo10 = (n: number) => Math.round(n / 10) * 10;

export interface PoolElement {
  label: string;
  localOnly: boolean;
  suppliedOnly: boolean;
  sourcedOrSupplied: boolean;
}

/** The type piece's "Optional pool:" line, parsed. */
export function optionalPool(typePiece: string): PoolElement[] {
  const line = typePiece.split('\n').find((l) => l.startsWith('Optional pool:'));
  if (!line) return [];
  return line
    .slice('Optional pool:'.length)
    .replace(/\.\s*$/, '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => ({
      label: raw.replace(/\s*\((local only|supplied only|sourced or supplied only)\)\s*$/, '').trim(),
      localOnly: /\(local only\)$/.test(raw),
      suppliedOnly: /\(supplied only\)$/.test(raw),
      sourcedOrSupplied: /\(sourced or supplied only\)$/.test(raw),
    }));
}

/** Item kinds a typed title can promise ("7 signs …", "10 common mistakes …"); B6. */
export const ITEM_KINDS = [
  'ways', 'tips', 'signs', 'steps', 'reasons', 'mistakes', 'ideas', 'questions', 'things', 'examples', 'stages',
  'benefits', 'types', 'options', 'factors', 'causes', 'myths', 'facts', 'checks', 'rules', 'features', 'tricks',
  'hacks', 'secrets', 'habits', 'warnings', 'problems', 'issues', 'symptoms', 'alternatives', 'questions to ask',
] as const;
// "N [up to two words] <kind>", the number not followed by a unit ("24 hour plumber tips" is no list).
const TYPED_NUMBERED_RE = new RegExp(
  String.raw`\b(\d{1,2})\s+(?!(?:hours?|days?|weeks?|months?|years?|minutes?|seconds?|inch(?:es)?|feet|foot|ft|yards?|miles?|gallons?|liters?|litres?|percent|degrees?|mph|psi|amps?|volts?|watts?|kw|btu|sq|square)\b)(?:[a-z][a-z'-]*\s+){0,2}?(${ITEM_KINDS.filter((k) => !k.includes(' ')).join('|')})\b`,
  'i',
);

/**
 * Items in a numbered title: the number, the item kind, the minimum words (B6).
 * The Title step's form decides for its own titles: "numbered" uses its item count; any other
 * form is never numbered, whatever digits the title holds ("24 hour emergency plumber cost").
 * A typed title (no form) is numbered only when a number comes before a known item kind.
 */
export function numberedFromTitle(title: string, form?: string | null, items?: number | null): { items: number; kind: string; min_words: number } | null {
  const typed = TYPED_NUMBERED_RE.exec(title);
  let n: number | null = null;
  let kind = 'items';
  if (form) {
    if (form !== 'numbered') return null;
    const lead = /\b(\d{1,2})\s+([A-Za-z][A-Za-z'-]*)/.exec(title);
    n = items && items > 0 ? items : typed ? Number(typed[1]) : lead ? Number(lead[1]) : null;
    kind = (typed?.[2] ?? lead?.[2] ?? 'items').toLowerCase().replace(/[^a-z-]/g, '') || 'items';
  } else if (typed) {
    n = Number(typed[1]);
    kind = typed[2].toLowerCase();
  }
  if (!n || n < 1) return null;
  const t = title.toLowerCase();
  let min = 60;
  if (/\b(steps?|stages?)\b/.test(t)) min = 40;
  else if (/\b(ideas?|examples?|questions? to ask)\b/.test(t)) min = 35;
  return { items: Math.min(MAX_NUMBERED_ITEMS, n), kind, min_words: min };
}

/** Step 3l: shares per section by length pattern (anchor 2/1; front/back linear 1.5↔0.5; alternating 1.4/0.7). */
export function patternShares(pattern: LengthPattern, n: number): number[] {
  if (n <= 1) return [1];
  if (pattern === 'anchor') return Array.from({ length: n }, (_, i) => (i === 0 ? 2 : 1));
  if (pattern === 'alternating') return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1.4 : 0.7));
  const falling = Array.from({ length: n }, (_, i) => 1.4 - (0.7 * i) / (n - 1));
  return pattern === 'front_heavy' ? falling : falling.reverse();
}

export function wordTargets(bodyWords: number, pattern: LengthPattern, n: number): number[] {
  const shares = patternShares(pattern, n);
  const sum = shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => roundTo10((bodyWords * s) / sum));
}

/** Raise any section under MIN_SECTION_WORDS to it, taking the difference from the longest ones. */
export function liftToFloor(targets: number[]): number[] {
  const t = [...targets];
  let deficit = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < MIN_SECTION_WORDS) {
      deficit += MIN_SECTION_WORDS - t[i];
      t[i] = MIN_SECTION_WORDS;
    }
  }
  while (deficit > 0) {
    const i = t.indexOf(Math.max(...t));
    if (t[i] - 10 < MIN_SECTION_WORDS) break;
    t[i] -= 10;
    deficit -= 10;
  }
  return t;
}

/** B10: Auto = none on Small, included on Medium and Large. */
export function tocAuto(size: PostSize): boolean {
  return size !== 'small';
}

/** Step 3k: readiness → firmness, capped by the niche profile; soft when readiness is missing. */
export function firmnessFor(readiness: string | null | undefined, firmest: FirmnessLevel): FirmnessLevel {
  const map: Record<string, FirmnessLevel> = { researching: 'soft', comparing: 'medium', 'ready to hire': 'direct' };
  const want = map[String(readiness ?? '').toLowerCase()] ?? 'soft';
  const order: FirmnessLevel[] = ['soft', 'medium', 'direct'];
  return order[Math.min(order.indexOf(want), order.indexOf(firmest))];
}

/** Topic guide triggers found in the title (task / time / process). */
export function topicTriggers(title: string): string[] {
  const t = title.toLowerCase();
  const out: string[] = [];
  if (/\b(how to|steps?|prepare|set up|apply)\b/.test(t)) out.push('task');
  if (/\b(season|spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december|before|after)\b/.test(t)) out.push('time');
  if (/\b(what to expect|process|timeline|recovery|how long)\b/.test(t)) out.push('process');
  return out;
}

/** B12: the structure fingerprint — the structural picks, canonicalised and hashed. */
export function structureFingerprint(raw: Partial<BlueprintPicks>): string {
  // Tolerates partial picks (rows stored by an older build): missing fields count as null.
  const p = { optional_elements: [], numbered: null, ...raw } as BlueprintPicks;
  const canon = {
    t: p.article_type,
    s: p.summary_form,
    sp: p.takeaway_points,
    sl: p.takeaway_list,
    o: p.opening,
    n: p.sections,
    e: [...(Array.isArray(p.optional_elements) ? p.optional_elements : [])].sort(),
    l: p.length_pattern,
    a: p.accent,
    f: p.faq_count,
    r: p.order,
    c: p.closing_move,
    cf: p.closing_format,
    fi: p.firmness,
    toc: p.toc,
    num: p.numbered ? [p.numbered.items, p.numbered.grouping, p.numbered.order_by] : null,
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- draw

/** Steps 3l + 3m: the word target per body section; one section fewer while any is under 120. */
function sectionTargets(size: PostSize, larger: boolean, sections: number, pattern: LengthPattern): { sections: number; word_targets: number[] } {
  const aim = larger ? AIM_BOTTOM[size] : AIM_MIDDLE[size];
  const body = aim - FIXED_PARTS[size];
  const floor = SECTION_RANGE[size][0];
  let n = sections;
  let targets = wordTargets(body, pattern, n);
  while (n > floor && targets.some((w) => w < MIN_SECTION_WORDS)) {
    n -= 1;
    targets = wordTargets(body, pattern, n);
  }
  return { sections: n, word_targets: liftToFloor(targets) };
}

const SPREAD_DIMS = ['summary_form', 'opening', 'length_pattern', 'accent', 'order', 'closing_move', 'closing_format'] as const;
type SpreadDim = (typeof SPREAD_DIMS)[number];
/**
 * C8 (working value, flagged for the team lead): the 40% limit applies to dimensions with 3 or more
 * options. With two options one value is always in at least half of the last 20, so the rule could
 * never pass and every draw ended "accepted after 5 redraws".
 */
const SPREAD_OPTIONS: Record<SpreadDim, number> = {
  summary_form: 2,
  opening: OPENINGS.length,
  length_pattern: LENGTH_PATTERNS.length,
  accent: ACCENTS.length,
  order: 2,
  closing_move: CLOSING_MOVES.length,
  closing_format: CLOSING_FORMATS.length,
};

/** "Redraw that dimension": the offending dimensions take the fresh draw's values, the rest stay. */
function withRedrawn(picks: BlueprintPicks, fresh: BlueprintPicks, dims: SpreadDim[], input: BlueprintInput): BlueprintPicks {
  const out: BlueprintPicks = { ...picks };
  for (const dim of dims) {
    if (dim === 'summary_form') {
      out.summary_form = fresh.summary_form;
      out.takeaway_points = fresh.takeaway_points;
      out.takeaway_list = fresh.takeaway_list;
    } else {
      (out as unknown as Record<string, unknown>)[dim] = fresh[dim];
    }
  }
  if (dims.includes('length_pattern') && !out.numbered) {
    const larger = out.larger_than_suggested;
    const t = sectionTargets(input.postSize, larger, picks.sections, out.length_pattern);
    out.sections = t.sections;
    out.word_targets = t.word_targets;
    out.writer_targets = scaleTargets(t.word_targets, input.targetScale ?? 1);
  }
  return out;
}

interface DrawState {
  excluded: Partial<Record<SpreadDim, Set<string>>>;
}

function drawPicks(input: BlueprintInput, rng: () => number, pieces: Readonly<Record<string, string>>, state: DrawState): BlueprintPicks {
  const pins = input.pins ?? {};
  const type: ArticleType = pins.article_type ?? input.articleType;
  const size = input.postSize;
  const larger = !!input.suggestedSize && rank(size) > rank(input.suggestedSize);
  const history = input.history ?? [];
  const sameType = history.filter((h) => (h.article_type ?? h.picks.article_type) === type).slice(0, 2);
  const avoid = (dim: SpreadDim) => state.excluded[dim] ?? new Set<string>();
  const options = <T extends string>(dim: SpreadDim, all: readonly T[], extra: T[] = []): T[] => {
    const ex = avoid(dim);
    const left = all.filter((v) => !ex.has(v) && !extra.includes(v));
    return left.length ? left : [...all];
  };

  const numbered = numberedFromTitle(input.title, input.titleForm, input.titleItems);
  const priceKnown = input.priceAvailable;

  // a. Summary form.
  let summary_form: SummaryForm = pins.summary?.form ?? pick(rng, options('summary_form', ['quick_answer', 'takeaways'] as const));
  let takeaway_points: 3 | 4 | 5 | null = null;
  let takeaway_list: 'bullets' | 'numbered' | null = null;
  if (summary_form === 'takeaways') {
    takeaway_points = pins.summary?.points ?? pick(rng, [3, 4, 5] as const);
    takeaway_list = pins.summary?.list ?? pick(rng, ['bullets', 'numbered'] as const);
  }

  // b. Opening: not one used in the previous 2 posts of this type.
  const recentOpenings = sameType.map((h) => String(h.picks.opening ?? '')).filter(Boolean) as Opening[];
  const opening: Opening = pins.opening ?? pick(rng, options('opening', OPENINGS, recentOpenings));

  // c. Body section count (never pinned). Numbered: set by the items.
  let sections: number;
  let numberedPick: NumberedPick | null = null;
  if (numbered) {
    const grouping: NumberedPick['grouping'] = numbered.items >= 8 ? 'grouped_h3' : 'h2_items';
    const t = input.title.toLowerCase();
    const order_by: NumberedPick['order_by'] = /\b(steps?|stages?)\b/.test(t)
      ? 'sequence'
      : /\b(costs?|prices?|pricing|budget|cheap|cheaper|expensive|save|savings)\b/.test(t)
        ? 'cost'
        : topicTriggers(input.title).includes('time')
          ? 'season'
          : 'priority';
    numberedPick = { ...numbered, grouping, order_by };
    sections = grouping === 'h2_items' ? numbered.items : intIn(rng, [2, 3]);
  } else {
    // A draw within the size's range (3m: its top); capped after step d (C12).
    sections = larger ? SECTION_RANGE[size][1] : intIn(rng, SECTION_RANGE[size]);
  }

  // d. Optional elements: count by size, from the type's pool; none for a numbered title.
  const typePiece = pieces[TYPE_PIECE_KEYS[type]];
  const pool = optionalPool(typePiece).filter(
    (e) =>
      !(input.reach === 'nationwide' && e.localOnly) &&
      !(e.suppliedOnly && !input.businessSupplied) &&
      !(e.sourcedOrSupplied && !(priceKnown || input.businessSupplied)),
  );
  let optional_elements: string[] = [];
  if (!numbered) {
    if (pins.optional_elements) {
      optional_elements = pins.optional_elements.filter((l) => pool.some((p) => p.label === l));
    } else {
      const count = Math.min(pool.length, larger ? OPTIONAL_RANGE[size][1] : intIn(rng, OPTIONAL_RANGE[size]));
      const bag = [...pool];
      while (optional_elements.length < count && bag.length) {
        // Local: "local only" elements get a higher chance (weight 2).
        const weights = bag.map((e) => (input.reach === 'local' && e.localOnly ? 2 : 1));
        let r = rng() * weights.reduce((a, b) => a + b, 0);
        let i = 0;
        while (i < bag.length - 1 && r >= weights[i]) r -= weights[i++];
        optional_elements.push(bag[i].label);
        bag.splice(i, 1);
      }
    }
  }

  // c, continued (C12): never more sections than the body questions plus the optional elements to
  // cover — the doc's example has 4 sections over 3 questions + 2 elements — never below the minimum.
  if (!numbered && input.bodyQuestions.length) {
    sections = Math.max(SECTION_RANGE[size][0], Math.min(sections, input.bodyQuestions.length + optional_elements.length));
  }

  // e. Length pattern.
  const length_pattern: LengthPattern = pins.length_pattern ?? pick(rng, options('length_pattern', LENGTH_PATTERNS));

  // f. Format accent. Numbered: no extra list; a summary table only on Medium and Large.
  let accent: Accent;
  if (pins.accent) accent = pins.accent;
  else if (numbered) accent = size === 'small' ? 'prose_only' : pick(rng, options('accent', ['prose_only', 'one_table'] as const));
  else accent = pick(rng, options('accent', ACCENTS));

  // g. FAQ questions: the top 3 / 4 / 5 by size; fewer if fewer exist.
  const faq_count = Math.min(FAQ_COUNT[size], input.faqQuestions.length);

  // h. Order of the last two sections.
  const order: LastOrder = pins.order ?? pick(rng, options('order', ['faq_first', 'closing_first'] as const));

  // i. Closing move: not one used in the previous 2 posts of this type.
  const recentClosings = sameType.map((h) => String(h.picks.closing_move ?? '')).filter(Boolean) as ClosingMove[];
  const closing_move: ClosingMove = pins.closing_move ?? pick(rng, options('closing_move', CLOSING_MOVES, recentClosings));

  // j. Closing format.
  const closing_format: ClosingFormat = pins.closing_format ?? pick(rng, options('closing_format', CLOSING_FORMATS));

  // k. Firmness: from readiness, capped by the niche (never random).
  const firmness: FirmnessLevel = pins.firmness ?? firmnessFor(input.readiness, input.firmest);

  // l + m. Word targets (never random).
  let word_targets: number[] = [];
  if (!numbered) ({ sections, word_targets } = sectionTargets(size, larger, sections, length_pattern));

  return {
    article_type: type,
    no_figure: type === 'cost' && !priceKnown,
    summary_form,
    takeaway_points,
    takeaway_list,
    opening,
    sections,
    optional_elements,
    length_pattern,
    accent,
    faq_count,
    order,
    closing_move,
    closing_format,
    firmness,
    toc: pins.toc ?? tocAuto(size),
    word_targets,
    writer_targets: scaleTargets(word_targets, input.targetScale ?? 1),
    larger_than_suggested: larger,
    numbered: numberedPick,
    topic_triggers: type === 'topic' ? topicTriggers(input.title) : [],
  };
}

// ---------------------------------------------------------------- assemble

const TYPE_NAME: Record<ArticleType, string> = { cost: 'Cost guide', decision: 'Decision guide', question: 'Question guide', topic: 'Topic guide' };

/** The type piece as the Writer gets it: the optional pool line dropped (only picked elements are named, in BODY). */
function typePieceFor(p: BlueprintPicks, pieces: Readonly<Record<string, string>>): string {
  const base = pieces[TYPE_PIECE_KEYS[p.article_type]];
  let lines = base.split('\n').filter((l) => !l.startsWith('Optional pool:'));
  if (p.article_type === 'topic') {
    // Keep only the trigger lines found in the title; the "Add when code finds…" line is for code.
    const want = new Set(p.topic_triggers);
    lines = lines.filter((l) => {
      if (l.startsWith('Add when code finds the trigger')) return false;
      const m = /^- (Task|Time|Process) \(/.exec(l);
      return !m || want.has(m[1].toLowerCase());
    });
  }
  let text = lines.join('\n');
  if (p.no_figure) {
    // "Cost guide, no figure available": sent after the Cost guide piece; the header's developer
    // note in brackets is not part of what the Writer reads.
    const nf = pieces.cost_guide_no_figure.replace(/^(COST GUIDE, NO FIGURE AVAILABLE)\s*\([^)]*\)/, '$1');
    text = `${text}\n${nf}`;
  }
  return text;
}

function numberedPieceFor(n: NumberedPick, pieces: Readonly<Record<string, string>>): string {
  const grouping = n.grouping === 'h2_items' ? 'items as H2 sections' : 'items as H3s under 2 or 3 grouping H2s';
  return pieces.numbered
    .replace('[N] [items]', `${n.items} ${n.kind}`)
    .replace('[N]', String(n.items))
    .replace('[M]', String(n.min_words))
    .replace('[items as H2 sections / items as H3s under 2 or 3 grouping H2s]', grouping)
    .replace('[priority / sequence / cost / season]', n.order_by);
}

function summaryLine(p: BlueprintPicks): string {
  if (p.summary_form === 'quick_answer') {
    // The type piece is sent whole and always mentions takeaways ("Takeaways carry …"); in the
    // 14 Nov 10-keyword run the Writer then added a key takeaways list after every quick answer.
    // So this line says which summary it is and that there is no second one.
    return 'SUMMARY: a quick answer, directly after the introduction: one paragraph of 40 to 60 words. Its first sentence answers the title. This is the only summary: no key takeaways list.';
  }
  // The doc's example line, plus the same closing sentence: every type piece also says "Quick answer
  // states: …" (meant for the first point here), and in the 14 Nov run the Writer added a quick
  // answer after the takeaways (2 of 10).
  return `SUMMARY: key takeaways, directly after the introduction. ${p.takeaway_points} points, as a ${p.takeaway_list === 'numbered' ? 'numbered' : 'bulleted'} list. The first point answers the title. This is the only summary: no separate quick answer.`;
}

/** Targets × factor, rounded to 10 (the doc's rounding), never under 10. Factor 1 = unchanged. */
export function scaleTargets(targets: number[], factor: number): number[] {
  if (!(factor > 0) || factor === 1) return [...targets];
  return targets.map((t) => Math.max(10, Math.round((t * factor) / 10) * 10));
}

/**
 * The same picks with the Writer's targets scaled once more, re-assembled into a block: the second
 * Writer run after a too-short (or too-long) draft gets new numbers in the same sentence (A1).
 */
export function rescaledBlueprint(
  picks: BlueprintPicks,
  input: Pick<BlueprintInput, 'bodyQuestions' | 'faqQuestions'>,
  factor: number,
  pieces: Readonly<Record<string, string>> = BLUEPRINT_PIECES_V1,
): { picks: BlueprintPicks; block: string } {
  const base = picks.writer_targets?.length ? picks.writer_targets : picks.word_targets;
  const next = { ...picks, writer_targets: scaleTargets(base, factor) };
  return { picks: next, block: assembleBlueprint(next, input, pieces) };
}

function targetsSentence(p: BlueprintPicks): string {
  const t = p.writer_targets?.length ? p.writer_targets : p.word_targets;
  if (!t.length) return '';
  if (p.length_pattern === 'anchor' && t.length > 1) return `About ${t[0]} words for the main section, about ${t[1]} for each of the others.`;
  if (t.length === 1) return `About ${t[0]} words.`;
  return `About ${t.slice(0, -1).join(', ')} and ${t[t.length - 1]} words, in order.`;
}

function numberedList(items: string[]): string {
  return items.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

export function assembleBlueprint(p: BlueprintPicks, input: Pick<BlueprintInput, 'bodyQuestions' | 'faqQuestions'>, pieces: Readonly<Record<string, string>> = BLUEPRINT_PIECES_V1): string {
  const lines: string[] = [];
  lines.push(`ARTICLE TYPE: ${TYPE_NAME[p.article_type]}.\n${typePieceFor(p, pieces)}`);
  if (p.numbered) lines.push(`NUMBERED: ${numberedPieceFor(p.numbered, pieces)}`);
  lines.push(`OPENING: ${pieces[p.opening]}`);
  lines.push(summaryLine(p));
  if (p.numbered) {
    lines.push(`BODY: the ${p.numbered.items} ${p.numbered.kind}, at least ${p.numbered.min_words} words each.`);
  } else {
    const body = [`BODY: ${p.sections} sections. ${pieces[p.length_pattern]} ${targetsSentence(p)}`.trim()];
    if (p.optional_elements.length) body.push(`Also cover: ${p.optional_elements.join('; ')}.`);
    const qs = input.bodyQuestions.slice(0, p.sections);
    if (qs.length) body.push(`Body questions, most important first:\n${numberedList(qs)}`);
    lines.push(body.join('\n'));
  }
  lines.push(`FORMAT: ${pieces[p.accent]}`);
  const faq = input.faqQuestions.slice(0, p.faq_count);
  if (faq.length) {
    lines.push(`FAQ: these ${faq.length} questions, in this order:\n${numberedList(faq)}`);
    lines.push(`ORDER OF THE LAST TWO SECTIONS: ${p.order === 'faq_first' ? 'FAQ, then the closing.' : 'the closing, then the FAQ.'}`);
  } else {
    lines.push('FAQ: no FAQ section in this article.');
  }
  lines.push(`CLOSING: ${pieces[p.closing_move]} ${pieces[p.closing_format]} Firmness: ${pieces[p.firmness]}`);
  return `<blueprint>\n${lines.join('\n')}\n</blueprint>`;
}

// ---------------------------------------------------------------- the run

export function buildBlueprint(input: BlueprintInput, log: (line: string) => void = () => {}): BlueprintResult {
  const rng = input.rng ?? Math.random;
  const pieces = input.pieces ?? BLUEPRINT_PIECES_V1;
  // C9: the history is the site's posts of the same article type (one row per post).
  const type: ArticleType = input.pins?.article_type ?? input.articleType;
  const history = (input.history ?? []).filter((h) => (h.article_type ?? h.picks?.article_type) === type);
  const last10 = new Set(history.slice(0, 10).map((h) => h.fingerprint || (h.picks?.article_type ? structureFingerprint(h.picks as Partial<BlueprintPicks>) : '')).filter(Boolean));
  const last20 = history.slice(0, 20);
  const pinned = new Set(Object.keys(input.pins ?? {}));
  const pinOf: Record<SpreadDim, string> = { summary_form: 'summary', opening: 'opening', length_pattern: 'length_pattern', accent: 'accent', order: 'order', closing_move: 'closing_move', closing_format: 'closing_format' };
  const state: DrawState = { excluded: {} };

  let picks = drawPicks(input, rng, pieces, state);
  let redraws = 0;
  let accepted_after_max = false;
  for (;;) {
    const problems: string[] = [];
    const repeat = last10.has(structureFingerprint(picks));
    if (repeat) problems.push('exact_repeat');
    const over: SpreadDim[] = [];
    if (last20.length >= 5) {
      for (const dim of SPREAD_DIMS) {
        if (pinned.has(pinOf[dim])) continue;
        // C8: two-option dimensions (and a numbered title's accent: two at most) are not limited.
        if ((dim === 'accent' && picks.numbered ? 2 : SPREAD_OPTIONS[dim]) < 3) continue;
        const v = String(picks[dim]);
        const n = last20.filter((h) => String(h.picks[dim] ?? '') === v).length;
        if (n / last20.length > 0.4) over.push(dim);
      }
    }
    if (over.length) problems.push(`spread:${over.join(',')}`);
    if (!problems.length) break;
    if (redraws >= 5) {
      accepted_after_max = true;
      log(`[blueprint] accepted after 5 redraws (${problems.join(' ')}) fingerprint=${structureFingerprint(picks)}`);
      break;
    }
    redraws++;
    for (const dim of over) (state.excluded[dim] ||= new Set()).add(String(picks[dim]));
    const fresh = drawPicks(input, rng, pieces, state);
    // An exact repeat is redrawn whole; a spread problem redraws only that dimension (doc step 4).
    picks = repeat ? fresh : withRedrawn(picks, fresh, over, input);
  }

  return { block: assembleBlueprint(picks, input, pieces), picks, fingerprint: structureFingerprint(picks), redraws, accepted_after_max };
}

/** B9: <recent_headings> — the site's headings for the same article type from its last 20 posts. */
export function recentHeadingsBlock(history: Array<{ article_type?: string | null; headings?: string[] }>, type: ArticleType, max = 40): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of history.filter((x) => (x.article_type ?? '') === type).slice(0, 20)) {
    for (const heading of h.headings ?? []) {
      const k = heading.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(heading.trim());
      if (out.length >= max) break;
    }
  }
  if (!out.length) return '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<recent_headings>\n${out.map((h) => `  <heading>${esc(h)}</heading>`).join('\n')}\n</recent_headings>`;
}

/** B8: is a price available? A currency amount in the research facts or the Business details pricing. */
export function priceAvailable(texts: Array<string | null | undefined>): boolean {
  // A symbol or code before the amount ($300, € 90, USD 300), or a currency after it (300 €,
  // 300 dollars, 90 euros, 120 GBP). "pounds" is left out: "a 50 pounds bag" is a weight.
  const re = /(?:[$€£¥]\s?\d|\b(?:usd|eur|gbp|us\$)\s?\d|\d[\d,.]*\s?(?:[€£]|(?:dollars?|usd|eur|euros?|gbp)\b))/i;
  return texts.some((t) => !!t && re.test(t));
}
