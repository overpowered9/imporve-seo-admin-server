/**
 * Local search volume, and the city -> state -> country ladder.
 *
 * WHY THIS EXISTS
 * DataForSEO Labs supports countries only (their own help centre says so: cities were excluded
 * deliberately, for database size). So difficulty and intent are national facts and always will be.
 * Only VOLUME can be made local, and only through Google Ads, which prices per REQUEST for up to
 * 1000 keywords. That single fact is what makes this affordable: one request per level for a whole
 * list, so the full ladder costs at most three requests no matter how many keywords are on it.
 *
 * WHAT A LEVEL MEANS
 * The ladder is not built from Google's location-type names ("City", "State", "Municipality",
 * "DMA Region", "Union Territory"...) because that taxonomy is large, country-specific and not
 * fully documented. It is built by walking `location_code_parent` from the location the user chose
 * up to the country. Whatever Google calls each step, the chain is the ladder, and each step is
 * labelled with the name Google itself gives it so the UI never has to invent a word for it.
 *
 * THE RULE THAT MATTERS
 * A figure is only ever labelled with the level it was actually measured at. A national number is
 * never presented as a local one. When a level has too little data we say so and name the level we
 * fell back to — we do not silently widen the geography under the user's feet. This mirrors the
 * scope rule the Content v3 prompts already enforce.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * `competition`, `competition_index` and `cpc` come back on the same wire item and are ignored
 * here. They describe the ad auction, not organic difficulty. Difficulty stays Labs-only.
 */
import {
  ADS_MAX_KEYWORDS_PER_TASK,
  isAdsKeywordAcceptable,
  type DataForSeoAdsClient,
  type DfsLocation,
} from './dataforseo.client.js';
import { normalizeKeyword, normalizeLanguageCode } from './keyword-data.types.js';

/** One rung of the ladder, named as Google names it. */
export interface GeoStep {
  location_code: number;
  /** Google's own full name, e.g. "Austin,Texas,United States". */
  location_name: string;
  /** Google's own type, e.g. "City". Null when Google did not say. */
  location_type: string | null;
  parent_code: number | null;
  /** 0 = the location the user chose, rising towards the country. */
  depth: number;
}

/** What happened at one rung: did we ask, and was the answer usable. */
export interface GeoLadderAttempt {
  step: GeoStep;
  attempted: boolean;
  /** Keywords that came back with a volume above zero. */
  covered: number;
  /** Keywords we were able to ask about at all. */
  eligible: number;
  /** Whether `covered` cleared the bar; null when we did not ask. */
  sufficient: boolean | null;
}

export interface LocalVolumeItem {
  keyword: string;
  /** Null means Google returned nothing for it at the level used; 0 means it reported zero demand. */
  search_volume: number | null;
}

export interface LocalVolumeResult {
  /** The rung whose numbers `items` carry. Null when no rung produced usable data. */
  level_used: GeoStep | null;
  /** Every rung, in order, with what it returned. The panel renders this as the explanation. */
  ladder: GeoLadderAttempt[];
  items: LocalVolumeItem[];
  /** A sentence for the user when we did not use the level they picked. Null when we did. */
  notice: string | null;
  /** Google Ads requests actually made. Each one is billed. */
  requests: number;
  cost_usd: number;
  /** Keywords Google Ads will not accept (too long, too many words, emoji). Never silently dropped. */
  skipped_keywords: string[];
}

/**
 * When is a level's data "enough"?
 *
 * The question a local business owner is really asking is "which of these should I write about
 * first?". If only two keywords in a thirty-keyword list have a local number, the local data
 * cannot answer that, and a wider level that can is more useful than a narrower one that cannot.
 * So the bar scales with the list but has a floor: a five-keyword list is not held to the same
 * absolute count as a hundred-keyword one.
 *
 * Both numbers are deliberately conservative and deliberately visible in the response, because
 * they are product judgements to be tuned against real pulls, not laws.
 */
export const GEO_SUFFICIENCY = Object.freeze({
  minCovered: 5,
  minCoverageRatio: 0.2,
  /** Cost ceiling: at most this many rungs are ever asked, even on a deeper chain. */
  maxLevels: 3,
});

export function requiredCoverage(eligible: number, rules = GEO_SUFFICIENCY): number {
  if (eligible <= 0) return 0;
  return Math.max(Math.min(rules.minCovered, eligible), Math.ceil(rules.minCoverageRatio * eligible));
}

export interface GeoServiceDeps {
  client: DataForSeoAdsClient;
  log?: (line: string) => void;
  /** How long the free per-country location list is held in memory. Default 24 h. */
  locationsTtlMs?: number;
}

export interface LocalVolumeParams {
  keywords: string[];
  /** ISO 3166-1 alpha-2 of the country the chosen location sits in. */
  country_iso: string;
  /** The Google Ads location code the user chose. */
  location_code: number;
  language_code?: string;
  rules?: typeof GEO_SUFFICIENCY;
}

export interface GeoService {
  /** Free, cached. Substring match on Google's own location names. */
  searchLocations(countryIso: string, query: string, limit?: number): Promise<GeoStep[]>;
  /** The country row itself (parent null). Needed because Labs takes a country code. */
  countryLocationCode(countryIso: string): Promise<number>;
  /** The chain from a chosen location up to its country, nearest first. */
  resolveLadder(countryIso: string, locationCode: number): Promise<GeoStep[]>;
  localVolumes(params: LocalVolumeParams): Promise<LocalVolumeResult>;
}

function toStep(loc: DfsLocation, depth: number): GeoStep {
  return {
    location_code: loc.location_code,
    location_name: loc.location_name,
    location_type: loc.location_type ?? null,
    parent_code: loc.location_code_parent ?? null,
    depth,
  };
}

/** "Austin,Texas,United States" -> "Austin, Texas" : what a person would actually call the place. */
export function friendlyLocationName(step: GeoStep): string {
  const parts = String(step.location_name ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  // Drop the country for anything below country level; it is implied by the picker.
  return parts.slice(0, Math.max(1, parts.length - 1)).join(', ');
}

export function createGeoService(deps: GeoServiceDeps): GeoService {
  const { client, log = (l: string) => console.log(l), locationsTtlMs = 24 * 60 * 60 * 1000 } = deps;

  const locationCache = new Map<string, { at: number; byCode: Map<number, DfsLocation>; all: DfsLocation[] }>();

  async function loadLocations(countryIso: string) {
    const iso = String(countryIso || '').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(iso)) throw new Error(`country_iso must be two letters, got "${countryIso}"`);
    const hit = locationCache.get(iso);
    if (hit && Date.now() - hit.at < locationsTtlMs) return hit;

    const res = await client.adsLocations(iso);
    const all = (res.result ?? []).filter((l): l is DfsLocation => !!l && typeof l.location_code === 'number');
    const byCode = new Map<number, DfsLocation>();
    for (const l of all) byCode.set(l.location_code, l);
    const entry = { at: Date.now(), byCode, all };
    locationCache.set(iso, entry);
    log(`[keyword-geo] locations loaded iso=${iso} count=${all.length} cost=${res.cost}`);
    return entry;
  }

  async function resolveLadder(countryIso: string, locationCode: number): Promise<GeoStep[]> {
    const { byCode } = await loadLocations(countryIso);
    const start = byCode.get(locationCode);
    if (!start) throw new Error(`location_code ${locationCode} is not a Google Ads location in "${countryIso}"`);

    const ladder: GeoStep[] = [];
    const seen = new Set<number>();
    let cur: DfsLocation | undefined = start;
    let depth = 0;
    // Walk to the country. `seen` guards against a cyclic parent chain in the provider's data.
    while (cur && !seen.has(cur.location_code)) {
      seen.add(cur.location_code);
      ladder.push(toStep(cur, depth));
      const parent = cur.location_code_parent;
      if (parent === null || parent === undefined) break;
      cur = byCode.get(parent);
      depth += 1;
    }
    return ladder;
  }

  async function countryLocationCode(countryIso: string): Promise<number> {
    const { all } = await loadLocations(countryIso);
    const iso = String(countryIso || '').trim().toUpperCase();
    // The country is the row with no parent. Match the ISO too: a per-country list should only
    // contain one such row, but trusting that silently would pick a wrong code if it ever did not.
    const country = all.find((l) => (l.location_code_parent ?? null) === null && String(l.country_iso_code ?? '').toUpperCase() === iso);
    if (!country) throw new Error(`no country row for "${countryIso}" in the Google Ads location list`);
    return country.location_code;
  }

  async function searchLocations(countryIso: string, query: string, limit = 20): Promise<GeoStep[]> {
    const { all } = await loadLocations(countryIso);
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const matches = all.filter((l) => String(l.location_name ?? '').toLowerCase().includes(q));
    // A name that starts with the query beats one that merely contains it ("Austin, Texas" before
    // "Port Austin, Michigan"), then shorter names, which are the larger, likelier places.
    matches.sort((a, b) => {
      const an = String(a.location_name ?? '').toLowerCase();
      const bn = String(b.location_name ?? '').toLowerCase();
      const as = an.startsWith(q) ? 0 : 1;
      const bs = bn.startsWith(q) ? 0 : 1;
      if (as !== bs) return as - bs;
      if (an.length !== bn.length) return an.length - bn.length;
      return an.localeCompare(bn);
    });
    return matches.slice(0, Math.max(1, limit)).map((l) => toStep(l, 0));
  }

  /** One Google Ads request per chunk. Returns volumes keyed by normalised keyword. */
  async function volumesAt(
    keywords: string[],
    locationCode: number,
    languageCode: string,
  ): Promise<{ volumes: Map<string, number | null>; requests: number; cost: number }> {
    const volumes = new Map<string, number | null>();
    let requests = 0;
    let cost = 0;
    for (let i = 0; i < keywords.length; i += ADS_MAX_KEYWORDS_PER_TASK) {
      const chunk = keywords.slice(i, i + ADS_MAX_KEYWORDS_PER_TASK);
      const res = await client.adsSearchVolume({
        keywords: chunk,
        location_code: locationCode,
        language_code: languageCode,
      });
      requests += 1;
      cost += res.cost;
      for (const item of res.result ?? []) {
        if (!item || typeof item.keyword !== 'string') continue;
        const v = item.search_volume;
        volumes.set(normalizeKeyword(item.keyword), typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
      }
    }
    return { volumes, requests, cost };
  }

  async function localVolumes(params: LocalVolumeParams): Promise<LocalVolumeResult> {
    const rules = params.rules ?? GEO_SUFFICIENCY;
    const language = normalizeLanguageCode(params.language_code) || 'en';

    // Normalise and de-duplicate, keeping the caller's order for the response.
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const raw of params.keywords ?? []) {
      const k = normalizeKeyword(raw);
      if (k && !seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }

    const eligible = ordered.filter((k) => isAdsKeywordAcceptable(k));
    const skipped = ordered.filter((k) => !isAdsKeywordAcceptable(k));

    const fullLadder = await resolveLadder(params.country_iso, params.location_code);
    const rungs = fullLadder.slice(0, Math.max(1, rules.maxLevels));

    const attempts: GeoLadderAttempt[] = fullLadder.map((step) => ({
      step,
      attempted: false,
      covered: 0,
      eligible: eligible.length,
      sufficient: null,
    }));

    let requests = 0;
    let cost = 0;
    let used: { step: GeoStep; volumes: Map<string, number | null> } | null = null;
    let best: { step: GeoStep; volumes: Map<string, number | null>; covered: number } | null = null;

    if (eligible.length > 0) {
      const need = requiredCoverage(eligible.length, rules);
      for (let i = 0; i < rungs.length; i += 1) {
        const step = rungs[i];
        const r = await volumesAt(eligible, step.location_code, language);
        requests += r.requests;
        cost += r.cost;

        let covered = 0;
        for (const v of r.volumes.values()) if (v !== null && v > 0) covered += 1;

        const attempt = attempts[i];
        attempt.attempted = true;
        attempt.covered = covered;
        attempt.sufficient = covered >= need;

        log(
          `[keyword-geo] level=${step.location_name} code=${step.location_code} ` +
            `covered=${covered}/${eligible.length} need=${need} sufficient=${attempt.sufficient} cost=${r.cost}`,
        );

        if (!best || covered > best.covered) best = { step, volumes: r.volumes, covered };
        if (attempt.sufficient) {
          used = { step, volumes: r.volumes };
          break;
        }
      }
      // Nothing cleared the bar: use the rung that knew the most rather than nothing at all, and
      // say so. Falling back to the widest rung by default would hide a city that did have SOME
      // data behind a country figure.
      if (!used && best && best.covered > 0) used = { step: best.step, volumes: best.volumes };
    }

    const items: LocalVolumeItem[] = ordered.map((keyword) => ({
      keyword,
      search_volume: used ? (used.volumes.get(keyword) ?? null) : null,
    }));

    const chosen = fullLadder[0];
    let notice: string | null = null;
    if (!used) {
      notice = chosen
        ? `No local search data came back for ${friendlyLocationName(chosen)}. The figures shown are national.`
        : 'No local search data came back.';
    } else if (chosen && used.step.location_code !== chosen.location_code) {
      const usedAttempt = attempts.find((a) => a.step.location_code === used!.step.location_code);
      const chosenAttempt = attempts[0];
      notice =
        `Not enough search data for ${friendlyLocationName(chosen)}` +
        (chosenAttempt?.attempted ? ` (${chosenAttempt.covered} of ${eligible.length} keywords had figures)` : '') +
        `. Showing ${friendlyLocationName(used.step)} figures instead` +
        (usedAttempt ? ` (${usedAttempt.covered} of ${eligible.length}).` : '.');
    }

    return {
      level_used: used ? used.step : null,
      ladder: attempts,
      items,
      notice,
      requests,
      cost_usd: Number(cost.toFixed(6)),
      skipped_keywords: skipped,
    };
  }

  return { searchLocations, resolveLadder, localVolumes, countryLocationCode };
}

