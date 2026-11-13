/**
 * Towns for the search data lookup: resolve the post's Target town to a DataForSEO location (S3),
 * spot a town in the seed keyword (S10, W6), and take the town out of the keyword for the
 * country-level call (S5).
 *
 * Matching is accent- and case-insensitive ("Española" = "Espanola", DataForSEO's spelling) and
 * understands "Town, ST" and "Town, State". All of it runs on DataForSEO's free locations list
 * (locations.ts), so no geocoder and no extra provider.
 *
 * Detection is deliberately conservative, because hundreds of US towns are also ordinary words
 * ("Mobile", "Orange", "Price", "Hope"): a ONE-word town only counts when "in", "near" or "around"
 * comes before it or a state follows it; a town of two or more words ("Santa Fe", "Grand Rapids")
 * counts anywhere. The chosen Target town always counts. A miss only means the wizard does not show
 * its "check the town" line.
 */
import { TOWN_LOCATION_TYPES } from '../../config/search-data.config.js';
import type { DfsLocation } from '../keyword-data/dataforseo.client.js';

export const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

/** Lower-case, accents stripped, punctuation to spaces, single spaces. */
export function normalizePlace(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STATE_BY_NORM = new Map<string, string>();
for (const [abbr, name] of Object.entries(US_STATES)) {
  STATE_BY_NORM.set(abbr.toLowerCase(), name);
  STATE_BY_NORM.set(normalizePlace(name), name);
}

/** "NM" / "nm" / "New Mexico" → "New Mexico"; anything else → null. */
export function stateName(s: string | undefined | null): string | null {
  if (!s) return null;
  return STATE_BY_NORM.get(normalizePlace(s)) ?? null;
}

export interface TownEntry {
  location_code: number;
  location_name: string;
  /** Normalised town name, the first part of location_name. */
  name: string;
  /** The state part of location_name, or '' (normalised). */
  state: string;
  type: string;
}

export interface LocationIndex {
  country: string;
  byName: Map<string, TownEntry[]>;
  byFullName: Map<string, TownEntry>;
  /** Longest town name in tokens, to bound keyword n-grams. */
  maxTokens: number;
  size: number;
}

export function buildLocationIndex(locations: DfsLocation[], countryIso: string): LocationIndex {
  const byName = new Map<string, TownEntry[]>();
  const byFullName = new Map<string, TownEntry>();
  let maxTokens = 1;
  for (const loc of locations) {
    if (!loc || typeof loc.location_name !== 'string' || !Number.isInteger(loc.location_code)) continue;
    if (loc.country_iso_code && loc.country_iso_code.toLowerCase() !== countryIso.toLowerCase()) continue;
    const parts = loc.location_name.split(',');
    const entry: TownEntry = {
      location_code: loc.location_code,
      location_name: loc.location_name,
      name: normalizePlace(parts[0]),
      state: parts.length >= 3 ? normalizePlace(parts[parts.length - 2]) : '',
      type: loc.location_type ?? '',
    };
    byFullName.set(normalizePlace(loc.location_name), entry);
    if (!TOWN_LOCATION_TYPES.has(entry.type) || !entry.name) continue;
    const list = byName.get(entry.name);
    if (list) list.push(entry);
    else byName.set(entry.name, [entry]);
    maxTokens = Math.max(maxTokens, entry.name.split(' ').length);
  }
  return { country: countryIso.toLowerCase(), byName, byFullName, maxTokens: Math.min(maxTokens, 5), size: byFullName.size };
}

/** "Española, NM" → { town: "Española", state: "New Mexico" }. */
export function parseTown(text: string, stateHint?: string | null): { town: string; state: string | null } {
  const parts = String(text ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const town = parts[0] ?? '';
  const state = stateName(parts[1]) ?? stateName(stateHint);
  return { town, state };
}

export type TownResolution =
  | { status: 'listed' | 'alias'; location_code: number; location_name: string }
  | { status: 'coordinate'; location_coordinate: string }
  | { status: 'unresolved'; reason: 'not_listed' | 'ambiguous' | 'no_location_list' | 'empty' };

const COORD_RE = /^-?\d{1,2}(\.\d{1,7})?,-?\d{1,3}(\.\d{1,7})?,\d{3,6}$/;

export function resolveTown(
  text: string,
  index: LocationIndex | null,
  opts: { stateHint?: string | null; aliases?: Record<string, string>; coordinate?: string | null } = {},
): TownResolution {
  const { town, state } = parseTown(text, opts.stateHint);
  if (!town) return { status: 'unresolved', reason: 'empty' };

  if (index) {
    const candidates = (index.byName.get(normalizePlace(town)) ?? []).filter((e) => !state || e.state === normalizePlace(state));
    // A town with several entries in one state (City + Neighborhood): prefer the City.
    const cities = candidates.filter((e) => e.type === 'City');
    const pick = cities.length === 1 ? cities : candidates.length === 1 ? candidates : [];
    if (pick.length === 1) return { status: 'listed', location_code: pick[0].location_code, location_name: pick[0].location_name };

    const aliasKey = Object.keys(opts.aliases ?? {}).find((k) => {
      const a = parseTown(k);
      return normalizePlace(a.town) === normalizePlace(town) && (!a.state || !state || a.state === state);
    });
    if (aliasKey) {
      const target = index.byFullName.get(normalizePlace(opts.aliases![aliasKey]));
      if (target) return { status: 'alias', location_code: target.location_code, location_name: target.location_name };
    }
    if (opts.coordinate && COORD_RE.test(opts.coordinate)) return { status: 'coordinate', location_coordinate: opts.coordinate };
    return { status: 'unresolved', reason: candidates.length > 1 ? 'ambiguous' : 'not_listed' };
  }

  if (opts.coordinate && COORD_RE.test(opts.coordinate)) return { status: 'coordinate', location_coordinate: opts.coordinate };
  return { status: 'unresolved', reason: 'no_location_list' };
}

const PREPOSITIONS = new Set(['in', 'near', 'around']);

export interface KeywordTown {
  /** The words as they appear in the keyword. */
  text: string;
  /** Normalised. */
  name: string;
  isTarget: boolean;
}

/** Find a town in the seed keyword (S10). The longest match wins; see the header for the rules. */
export function detectTownInKeyword(keyword: string, index: LocationIndex | null, targetTown?: string | null): KeywordTown | null {
  const raw = String(keyword ?? '').split(/\s+/).filter(Boolean);
  const norm = raw.map((t) => normalizePlace(t));
  const target = targetTown ? normalizePlace(parseTown(targetTown).town) : '';
  const maxN = Math.max(index?.maxTokens ?? 1, target ? target.split(' ').length : 1);
  let best: KeywordTown | null = null;

  for (let n = Math.min(maxN, raw.length); n >= 1 && !best; n--) {
    for (let i = 0; i + n <= raw.length; i++) {
      const gram = norm.slice(i, i + n).join(' ').trim();
      if (!gram) continue;
      const text = raw.slice(i, i + n).join(' ').replace(/[,.;:!?]+$/, '');
      if (target && gram === target) {
        best = { text, name: gram, isTarget: true };
        break;
      }
      if (!index?.byName.has(gram)) continue;
      const before = i > 0 ? norm[i - 1] : '';
      const after = i + n < raw.length ? raw[i + n] : '';
      const stateAfter = !!stateName(after.replace(/[,.]/g, ''));
      if (n >= 2 || PREPOSITIONS.has(before) || stateAfter) {
        best = { text, name: gram, isTarget: false };
        break;
      }
    }
  }
  return best;
}

/**
 * The keyword without the town (S5): "water heater repair Española" → "water heater repair";
 * "water heater repair in Española, NM" → "water heater repair". Accent-insensitive; a preceding
 * "in/near/around" and a following state go with the town. Unchanged when the town is not there.
 */
export function stripTownFromKeyword(keyword: string, town: string): string {
  const raw = String(keyword ?? '').split(/\s+/).filter(Boolean);
  const target = normalizePlace(parseTown(town).town).split(' ').filter(Boolean);
  if (!target.length || !raw.length) return String(keyword ?? '').trim();
  const norm = raw.map((t) => normalizePlace(t));
  for (let i = 0; i + target.length <= norm.length; i++) {
    if (target.every((t, k) => norm[i + k] === t)) {
      let start = i;
      let end = i + target.length;
      if (start > 0 && PREPOSITIONS.has(norm[start - 1])) start -= 1;
      if (end < raw.length && stateName(raw[end].replace(/[,.]/g, ''))) end += 1;
      const kept = [...raw.slice(0, start), ...raw.slice(end)];
      const out = kept.join(' ').replace(/\s+,/g, ',').replace(/[,\s]+$/g, '').replace(/^[,\s]+/g, '').trim();
      return out || String(keyword ?? '').trim();
    }
  }
  return String(keyword ?? '').trim();
}
