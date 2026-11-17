/**
 * Opportunity score and traffic light. Pure functions, no I/O, so thresholds can be re-tuned
 * against a fetched list without paying for the fetch again.
 *
 * WHERE THIS DEPARTS FROM THE ORIGINAL SPEC, AND WHY
 *
 * 1. The spec's intent weights were transactional 1.4, informational 1.0, commercial 0.6. The
 *    commercial weight is backwards for a content tool. "best leather wallets for men" is a
 *    commercial-investigation query: the searcher has their wallet out and is choosing between
 *    options, which is the single most valuable thing a small business can rank an article for.
 *    Informational is how you build the topical authority that makes the commercial pages rank at
 *    all, so it is not far behind. Navigational is someone looking for a named brand; unless that
 *    brand is yours, it is close to worthless, and the spec gave it the same 0.8 as "unknown".
 *
 * 2. The spec's fourth gate ("a page-1 result with domain_rank < 30") needs a live SERP call per
 *    keyword. On a 100-keyword list that is 100 paid calls to compute a filter. It is kept out of
 *    the free path and offered as a paid add-on instead; `serp_weakness` is the slot it fills.
 *
 * 3. The spec has no honest answer for a keyword DataForSEO knows nothing about, and would colour
 *    it red ("tough fight"). That is a lie: we do not know that it is hard, we know nothing at all.
 *    Hence the `unknown` tier. On the real pull that started this work, 14 of 30 keywords were in
 *    exactly that state.
 *
 * 4. Difficulty is Labs-only. Google Ads `competition` and `cpc` are ad-auction signals and are
 *    never read here — a keyword can be fiercely bid on and trivial to rank for, and the reverse.
 */
import type { KeywordIntent } from './keyword-data.types.js';

export type TrafficLight = 'green' | 'yellow' | 'red' | 'unknown';

/** Whether the volume being scored is a local figure or a national one. Changes the volume bar. */
export type VolumeScope = 'local' | 'national';

export const SCORING_DEFAULTS = Object.freeze({
  intentWeights: Object.freeze({
    transactional: 1.3,
    commercial: 1.2,
    informational: 1.0,
    navigational: 0.4,
  } satisfies Record<KeywordIntent, number>),
  /** Applied when DataForSEO gave us no intent at all. Below informational, above navigational. */
  unknownIntentWeight: 0.9,
  /** Difficulty at or below this is an easy win, all else being equal. */
  easyDifficulty: 30,
  /** Above this, a keyword is a hard fight regardless of volume. */
  hardDifficulty: 50,
  /**
   * The volume floor worth writing for. A town of 15,000 people will never produce 150 searches a
   * month for a service term, so holding local figures to a national bar would paint every genuine
   * local opportunity red.
   */
  minVolume: Object.freeze({ local: 20, national: 100 } satisfies Record<VolumeScope, number>),
  /** Divisor that maps the raw product onto roughly 0-100. See rawToScore. */
  scoreDivisor: 6.5,
});

export type ScoringRules = typeof SCORING_DEFAULTS;

export function intentWeight(intent: KeywordIntent | null, rules: ScoringRules = SCORING_DEFAULTS): number {
  if (!intent) return rules.unknownIntentWeight;
  return rules.intentWeights[intent] ?? rules.unknownIntentWeight;
}

/**
 * Opportunity score, 0-100.
 *
 * `(100 - difficulty)` is how much room there is to rank; `log10(1 + volume)` is how much traffic
 * is on offer, compressed so a 100,000-search head term does not drown out every realistic target
 * (10 -> 1.0, 1k -> 3.0, 100k -> 5.0); intent is how much a visitor is worth when they arrive.
 *
 * Returns null when difficulty or volume is unknown. A score computed from a guess would be worse
 * than no score, because the whole list is sorted by it.
 */
export function opportunityScore(
  input: { search_volume: number | null; keyword_difficulty: number | null; intent: KeywordIntent | null },
  rules: ScoringRules = SCORING_DEFAULTS,
): number | null {
  const { search_volume: volume, keyword_difficulty: difficulty } = input;
  if (volume === null || difficulty === null) return null;
  if (!Number.isFinite(volume) || !Number.isFinite(difficulty)) return null;

  const room = 100 - Math.min(100, Math.max(0, difficulty));
  const traffic = Math.log10(1 + Math.max(0, volume));
  const raw = room * traffic * intentWeight(input.intent, rules);
  return Math.max(0, Math.min(100, Math.round(raw / rules.scoreDivisor)));
}

export interface GateResult {
  /** Reachable: difficulty is low enough to be worth trying. */
  difficulty_ok: boolean | null;
  /** Worth it: enough people search it at the level we measured. */
  volume_ok: boolean | null;
  /** Useful: not someone hunting for a brand that is not yours. */
  intent_ok: boolean | null;
  /** Beatable: a weak page-1 competitor exists. Null unless the paid SERP check ran. */
  serp_weakness: boolean | null;
}

export function evaluateGates(
  input: {
    search_volume: number | null;
    keyword_difficulty: number | null;
    intent: KeywordIntent | null;
    volume_scope: VolumeScope;
    serp_weakness?: boolean | null;
  },
  rules: ScoringRules = SCORING_DEFAULTS,
): GateResult {
  return {
    difficulty_ok: input.keyword_difficulty === null ? null : input.keyword_difficulty <= rules.easyDifficulty,
    volume_ok: input.search_volume === null ? null : input.search_volume >= rules.minVolume[input.volume_scope],
    intent_ok: input.intent === null ? null : input.intent !== 'navigational',
    serp_weakness: input.serp_weakness ?? null,
  };
}

/**
 * The traffic light a non-technical owner actually reads.
 *
 *   green   — go: reachable difficulty, real demand, useful intent.
 *   yellow  — worth it: one of those is soft, but it is still a sensible target.
 *   red     — tough fight: difficulty is genuinely high, or there is no demand to win.
 *   unknown — we have no data. Not a judgement, an absence of one.
 *
 * The paid SERP check can only ever PROMOTE: finding a weak page-1 competitor turns a yellow
 * green. It never demotes, because "no weak competitor found" is weak evidence on a 10-result
 * sample, and a user who paid for extra information should not be punished by it.
 */
export function trafficLight(
  input: {
    search_volume: number | null;
    keyword_difficulty: number | null;
    intent: KeywordIntent | null;
    volume_scope: VolumeScope;
    serp_weakness?: boolean | null;
  },
  rules: ScoringRules = SCORING_DEFAULTS,
): TrafficLight {
  const { keyword_difficulty: difficulty, search_volume: volume } = input;

  // Nothing to judge on. Never call this red: we do not know that it is hard.
  if (difficulty === null && volume === null) return 'unknown';

  const gates = evaluateGates(input, rules);

  // A definite no: too hard to reach, or nobody is searching.
  if (difficulty !== null && difficulty > rules.hardDifficulty) return 'red';
  if (volume !== null && volume === 0) return 'red';
  if (gates.intent_ok === false) return 'red';

  const difficultyEasy = gates.difficulty_ok === true;
  const volumeEnough = gates.volume_ok === true;

  // intent_ok === false already returned red above, so it cannot block a green here.
    if (difficultyEasy && volumeEnough) return 'green';
  if (gates.serp_weakness === true && volumeEnough) return 'green';

  // One side unknown and the other good is a yellow, not a green: we are guessing on half of it.
  if (difficultyEasy || volumeEnough) return 'yellow';
  if (difficulty === null || volume === null) return 'unknown';

  return 'yellow';
}


/**
 * Score and light together, so a caller cannot accidentally compute one from a different set of
 * inputs than the other — the two must always describe the same row.
 */
export function evaluateScoreAndLight(
  input: {
    search_volume: number | null;
    keyword_difficulty: number | null;
    intent: KeywordIntent | null;
    volume_scope: VolumeScope;
    serp_weakness?: boolean | null;
  },
  rules: ScoringRules = SCORING_DEFAULTS,
): { score: number | null; light: TrafficLight } {
  return { score: opportunityScore(input, rules), light: trafficLight(input, rules) };
}

/** The label shown beside the light. Kept here so the server and the panel cannot drift apart. */
export const TRAFFIC_LIGHT_LABELS: Readonly<Record<TrafficLight, string>> = Object.freeze({
  green: 'Easy win',
  yellow: 'Worth it',
  red: 'Tough fight',
  unknown: 'No data',
});
