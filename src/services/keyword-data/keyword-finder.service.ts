/**
 * The Keyword Finder: one seed in, a ranked, scored, honestly-labelled keyword list out.
 *
 * WHY THIS REPLACES THE AI KEYWORD GENERATOR
 * The plugin's current tool asks gpt-4o to invent keyword strings, then looks up metrics for them.
 * On a real pull ("Leather Wallets") 14 of the 30 rows came back with no data in any column,
 * because a language model produces plausible English, not phrases people actually type. Discovery
 * here starts from DataForSEO's keyword database instead, so every row has numbers by construction
 * and "no data" becomes the rare exception rather than half the screen.
 *
 * WHAT COMES FROM WHERE, AND WHY IT CANNOT BE OTHERWISE
 *   difficulty  Labs only. Derived from the link profiles of the top 10 ORGANIC results.
 *   intent      Labs only. National classification.
 *   volume      Labs nationally; Google Ads when the user picked a town or state, because Labs
 *               supports countries only. Ad-auction fields on the Ads response are ignored.
 *
 * TWO MODES, one pipeline:
 *   list       — a bulk list to pick many from and hand to a bulk content project.
 *   recommend  — a short shortlist for one post, each row carrying the sentence that explains it.
 */
import type { DataForSeoClient } from './dataforseo.client.js';
import { normalizeKeyword, normalizeLanguageCode, type KeywordIntent } from './keyword-data.types.js';
import { normalizeDifficulty, normalizeIntent, normalizeVolume } from './normalize.js';
import {
  SCORING_DEFAULTS,
  TRAFFIC_LIGHT_LABELS,
  evaluateScoreAndLight,
  type ScoringRules,
  type TrafficLight,
  type VolumeScope,
} from './keyword-scoring.js';
import type { GeoService, GeoStep } from './keyword-geo.service.js';

export type FinderMode = 'list' | 'recommend';

/**
 * A reported difficulty of exactly 0 is not evidence that a keyword is easy.
 *
 * Measured on live data (17 Nov 2026), two seeds, Labs related_keywords:
 *   "leather wallets"     23 of 37 rows scored exactly 0, including the head term itself at
 *                         27,100 searches/month. Every one of the 8 high-volume zeros was
 *                         transactional.
 *   "water heater repair" 11 of 32 rows scored 0, but only 1 above 1,000 searches. By intent:
 *                         transactional 83% zero, commercial 33%, informational 30%,
 *                         navigational 0%.
 *
 * The distribution is not a clean sentinel — genuine 1s, 2s and 3s exist alongside the zeros — so
 * 0 cannot simply be read as "missing". But it cannot be read as "trivial" either: "leather
 * wallets" (27,100) scored 0 while "best leather wallets" (1,600) scored 3, and a head term is
 * never easier than its own modifier. The pattern tracks shopping-dominated SERPs, where a score
 * derived from the link profiles of the top 10 organic pages has little organic material left to
 * work with.
 *
 * So 0 is treated as UNKNOWN for scoring. The consequence is deliberate: such a row can never be
 * coloured green off the back of a 0. It becomes a yellow when volume and intent are good, which
 * is the honest answer — there is demand, and we cannot tell you how hard it is. The paid SERP
 * check is what resolves exactly these rows.
 *
 * The reported value is kept on the item as difficulty_reported so nothing is hidden and the
 * rule can be revisited against more data.
 */
export function usableDifficulty(reported: number | null): number | null {
  return reported === 0 ? null : reported;
}

export const FINDER_DEFAULTS = Object.freeze({
  /** Rows returned. The Ads ladder prices per request, so a bigger list costs no more to localise. */
  limit: Object.freeze({ list: 100, recommend: 25 } satisfies Record<FinderMode, number>),
  /** Labs related_keywords depth: 1 returns up to 8, 2 up to 72, 3 up to 584. */
  depthForLimit: (limit: number) => (limit <= 60 ? 2 : 3),
  /**
   * Hard ceiling for both modes. 100 is a product decision, not a provider one: Labs would serve
   * far more, but a list nobody will read through is not worth paying for, and the Google Ads
   * ladder prices per request either way. The caller chooses anything from 1 to this.
   */
  maxLimit: 100,
});

export interface FinderItem {
  keyword: string;
  /** True for the seed itself, which is always included even if Labs did not relate it to itself. */
  is_seed: boolean;
  /** Labs, always national. */
  national_volume: number | null;
  /** Google Ads at the level actually used. Null when no local level was asked for or none worked. */
  local_volume: number | null;
  /** The figure the score and the light were computed from. */
  volume_used: number | null;
  volume_scope: VolumeScope;
  /** What the score and the light were computed from. Null when unknown OR reported as 0. */
  keyword_difficulty: number | null;
  /** Exactly what DataForSEO said, including a 0 we decline to trust. */
  difficulty_reported: number | null;
  intent: KeywordIntent | null;
  opportunity_score: number | null;
  light: TrafficLight;
  light_label: string;
  /** One sentence a non-technical owner can act on. */
  reason: string;
}

export interface FinderResult {
  seed: string;
  mode: FinderMode;
  items: FinderItem[];
  /** The rung the volumes came from, or null when the figures are national. */
  level_used: GeoStep | null;
  country_location_code: number;
  /** Set when the level asked for was not the level used, or when local data failed entirely. */
  notice: string | null;
  /** What Google Ads was asked, rung by rung. Empty when no local level was requested. */
  geo_ladder: unknown[];
  keywords_without_data: number;
  cost_usd: number;
  rules: ScoringRules;
}

export interface FinderDeps {
  labs: DataForSeoClient;
  /** Only needed when a non-country location is asked for. */
  geo?: GeoService;
  log?: (line: string) => void;
}

export interface DiscoverParams {
  seed: string;
  /** ISO 3166-1 alpha-2 of the country, e.g. "us". */
  country_iso: string;
  /** The country's own Google location code, e.g. 2840. */
  country_location_code: number;
  /** A town or state code to localise volume to. Omit, or pass the country code, for national. */
  location_code?: number;
  language_code?: string;
  mode?: FinderMode;
  limit?: number;
  rules?: ScoringRules;
}

/** The sentence under the traffic light. Plain words, no jargon, never implies data we lack. */
export function reasonFor(item: Omit<FinderItem, 'reason' | 'light_label'>, levelName: string | null): string {
  const where = item.volume_scope === 'local' && levelName ? ` in ${levelName}` : '';
  const vol = item.volume_used;
  const kd = item.keyword_difficulty;
  // A reported 0 is not "unknown because nothing came back"; it is a number we decline to trust.
  const unmeasurable = kd === null && item.difficulty_reported === 0;

  if (vol === null && kd === null && !unmeasurable) {
    return 'No search data for this phrase, so there is nothing to judge it on.';
  }
  if (vol === 0) {
    return `Nobody appears to search this${where}.`;
  }
  const volPart = vol === null ? 'Search volume unknown' : `About ${vol.toLocaleString('en-US')} searches a month${where}`;
  if (unmeasurable) {
    return `${volPart}. How hard it is to rank for could not be measured — the first page is mostly shop listings, so check it before committing.`;
  }
  if (kd === null) {
    return `${volPart}, but how hard it is to rank for is unknown.`;
  }
  if (kd <= SCORING_DEFAULTS.easyDifficulty) {
    return `${volPart}, and the pages ranking for it are weak enough to beat.`;
  }
  if (kd <= SCORING_DEFAULTS.hardDifficulty) {
    return `${volPart}, with established pages to get past. Worth it with a strong article.`;
  }
  return `${volPart}, but the first page is dominated by strong sites.`;
}

export function createKeywordFinderService(deps: FinderDeps) {
  const { labs, geo, log = (l: string) => console.log(l) } = deps;

  async function discover(params: DiscoverParams): Promise<FinderResult> {
    const mode: FinderMode = params.mode ?? 'list';
    const rules = params.rules ?? SCORING_DEFAULTS;
    const language = normalizeLanguageCode(params.language_code) || 'en';
    const seed = normalizeKeyword(params.seed);
    if (!seed) throw new Error('seed is required');

    const limit = Math.min(
      FINDER_DEFAULTS.maxLimit,
      Math.max(1, params.limit ?? FINDER_DEFAULTS.limit[mode]),
    );
    const country = params.country_location_code;

    // ---- 1. Discovery and the seed itself, nationally. Labs cannot do better than a country. ----
    let cost = 0;
    const [related, overview] = await Promise.all([
      labs.relatedKeywords({
        keyword: seed,
        location_code: country,
        language_code: language,
        limit,
        depth: FINDER_DEFAULTS.depthForLimit(limit),
      }),
      labs.keywordOverview({ keywords: [seed], location_code: country, language_code: language }),
    ]);
    cost += related.cost + overview.cost;

    const national = new Map<string, { volume: number | null; difficulty: number | null; intent: KeywordIntent | null }>();
    const order: string[] = [];

    const absorb = (keyword: unknown, kwData: { keyword_info?: unknown; keyword_properties?: unknown; search_intent_info?: unknown } | null) => {
      const k = normalizeKeyword(keyword);
      if (!k) return;
      const info = (kwData?.keyword_info ?? null) as { search_volume?: unknown } | null;
      const props = (kwData?.keyword_properties ?? null) as { keyword_difficulty?: unknown } | null;
      const intentInfo = (kwData?.search_intent_info ?? null) as { main_intent?: unknown } | null;
      if (!national.has(k)) order.push(k);
      national.set(k, {
        volume: normalizeVolume(info?.search_volume),
        difficulty: normalizeDifficulty(props?.keyword_difficulty),
        intent: normalizeIntent(intentInfo?.main_intent),
      });
    };

    for (const r of overview.result ?? []) {
      for (const item of r?.items ?? []) absorb(item?.keyword, item);
    }
    for (const r of related.result ?? []) {
      for (const item of r?.items ?? []) absorb(item?.keyword_data?.keyword, item?.keyword_data ?? null);
    }

    // The seed always appears, even when Labs knows nothing about it: its absence would read as a
    // bug to the user who just typed it.
    if (!national.has(seed)) {
      order.unshift(seed);
      national.set(seed, { volume: null, difficulty: null, intent: null });
    }

    const keywords = order.slice(0, limit);

    // ---- 2. Local volume, when a town or state was asked for. ----
    let levelUsed: GeoStep | null = null;
    let notice: string | null = null;
    let ladder: unknown[] = [];
    const localVolumes = new Map<string, number | null>();

    const wantsLocal = params.location_code !== undefined && params.location_code !== country;
    if (wantsLocal) {
      if (!geo) throw new Error('a location_code below country level needs the geo service');
      const local = await geo.localVolumes({
        keywords,
        country_iso: params.country_iso,
        location_code: params.location_code!,
        language_code: language,
      });
      cost += local.cost_usd;
      levelUsed = local.level_used;
      notice = local.notice;
      ladder = local.ladder as unknown[];
      for (const item of local.items) localVolumes.set(item.keyword, item.search_volume);
      if (local.skipped_keywords.length) {
        log(`[keyword-finder] ${local.skipped_keywords.length} keyword(s) could not be priced locally by Google Ads`);
      }
    }

    // A local level was asked for and produced usable figures: the list is judged locally.
    const scope: VolumeScope = levelUsed && !isCountry(levelUsed, country) ? 'local' : 'national';
    const levelName = levelUsed ? levelUsed.location_name.split(',')[0] : null;

    // ---- 3. Score, light, sort. ----
    const items: FinderItem[] = keywords.map((keyword) => {
      const nat = national.get(keyword) ?? { volume: null, difficulty: null, intent: null };
      const local = localVolumes.get(keyword) ?? null;
      const volumeUsed = scope === 'local' ? local : nat.volume;

      const usable = usableDifficulty(nat.difficulty);
      const scored = evaluateScoreAndLight(
        {
          search_volume: volumeUsed,
          keyword_difficulty: usable,
          intent: nat.intent,
          volume_scope: scope,
        },
        rules,
      );

      const partial = {
        keyword,
        is_seed: keyword === seed,
        national_volume: nat.volume,
        local_volume: local,
        volume_used: volumeUsed,
        volume_scope: scope,
        keyword_difficulty: usable,
        difficulty_reported: nat.difficulty,
        intent: nat.intent,
        opportunity_score: scored.score,
        light: scored.light,
      };

      return { ...partial, light_label: TRAFFIC_LIGHT_LABELS[scored.light], reason: reasonFor(partial, levelName) };
    });

    // Best opportunity first; anything we could not score goes last, never in the middle where it
    // would read as mediocre rather than unmeasured.
    items.sort((a, b) => {
      if (a.opportunity_score === null && b.opportunity_score === null) return 0;
      if (a.opportunity_score === null) return 1;
      if (b.opportunity_score === null) return -1;
      return b.opportunity_score - a.opportunity_score;
    });

    const withoutData = items.filter((i) => i.opportunity_score === null).length;
    log(
      `[keyword-finder] seed="${seed}" mode=${mode} returned=${items.length} no_data=${withoutData} ` +
        `scope=${scope} level=${levelUsed?.location_name ?? 'national'} cost_usd=${cost.toFixed(4)}`,
    );

    return {
      seed,
      mode,
      items,
      level_used: scope === 'local' ? levelUsed : null,
      country_location_code: country,
      notice,
      geo_ladder: ladder,
      keywords_without_data: withoutData,
      cost_usd: Number(cost.toFixed(6)),
      rules,
    };
  }

  return { discover };
}

function isCountry(step: GeoStep, countryCode: number): boolean {
  return step.location_code === countryCode;
}
