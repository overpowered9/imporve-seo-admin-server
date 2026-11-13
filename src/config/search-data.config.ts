/**
 * Search data lookup (DataForSEO Google SERP) — the settings docs/content-v3-prompt-drafts.md
 * decided on 30 Oct, plus the working values it leaves open, as config (brief rule 4).
 *
 * Decided (fixed in code, not env): Google organic, Live mode, advanced results, depth 10,
 * people_also_ask_click_depth 1; merge caps 10 titles / 8 questions / 8 related searches; local
 * items first; no state-level call.
 *
 * Working values (env, listed in .env.example and docs/CONTENT_V3.md):
 *   SEARCH_DATA_THIN_THRESHOLD   3   a result is thin with fewer than this many People Also Ask
 *                                    questions OR related searches ("tune after the 10-keyword test")
 *   SEARCH_DATA_COUNTRY_CODE     2840 / SEARCH_DATA_COUNTRY_ISO us / SEARCH_DATA_COUNTRY_NAME
 *                                    United States — the country-level call
 *   SEARCH_DATA_TOWN_ALIASES_JSON  {} towns DataForSEO does not list, mapped to the nearest listed
 *                                    location (open question: "coordinates, or the nearest listed
 *                                    city"). Keys are "town, ST" as typed; values are DataForSEO
 *                                    location names, e.g. {"Chimayo, NM":"Espanola,New Mexico,United States"}.
 *   SEARCH_DATA_UNLISTED_TOWN    national   what to do when a town is neither listed, aliased nor
 *                                    given coordinates: "national" runs one country-level call
 *                                    (the town stays in the keyword) and logs it.
 */

export const SERP_DEPTH = 10;
export const SERP_PAA_CLICK_DEPTH = 1;
export const MERGE_CAPS = Object.freeze({ titles: 10, questions: 8, related: 8 });

/** DataForSEO location types that count as a town for resolution and keyword detection. */
export const TOWN_LOCATION_TYPES: ReadonlySet<string> = new Set(['City', 'Municipality', 'Neighborhood', 'Borough', 'Township', 'Town', 'Village']);

export interface SearchDataConfig {
  thinThreshold: number;
  countryCode: number;
  countryIso: string;
  countryName: string;
  townAliases: Record<string, string>;
  unlistedTown: 'national';
  timeoutMs: number;
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function aliasesFromEnv(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    return out;
  } catch {
    return {};
  }
}

export function searchDataConfig(env: NodeJS.ProcessEnv = process.env): SearchDataConfig {
  return {
    thinThreshold: intEnv(env.SEARCH_DATA_THIN_THRESHOLD, 3, 1, 8),
    countryCode: intEnv(env.SEARCH_DATA_COUNTRY_CODE, 2840, 1, 99_999_999),
    countryIso: (env.SEARCH_DATA_COUNTRY_ISO || 'us').trim().toLowerCase().slice(0, 2),
    countryName: (env.SEARCH_DATA_COUNTRY_NAME || 'United States').trim(),
    townAliases: aliasesFromEnv(env.SEARCH_DATA_TOWN_ALIASES_JSON),
    unlistedTown: 'national',
    timeoutMs: intEnv(env.CONTENT_V3_TIMEOUT_SEARCH_DATA_MS, 30_000, 1_000, 120_000),
  };
}

/** `<language>` as the wizard sends it ("English", "Spanish", or a code) → DataForSEO language_code. */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl',
  polish: 'pl', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', russian: 'ru', turkish: 'tr',
  arabic: 'ar', hindi: 'hi', urdu: 'ur', japanese: 'ja', korean: 'ko', chinese: 'zh-CN', vietnamese: 'vi',
  indonesian: 'id', greek: 'el', czech: 'cs', romanian: 'ro', hungarian: 'hu', hebrew: 'he', thai: 'th',
};

export function languageCodeFor(language: string | undefined): string {
  const raw = String(language ?? '').trim();
  if (!raw) return 'en';
  if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(raw)) return raw;
  const lower = raw.toLowerCase();
  if (LANGUAGE_CODES[lower]) return LANGUAGE_CODES[lower];
  // The wizard sends "US English", "UK English", "German": match the language word inside.
  const word = Object.keys(LANGUAGE_CODES).find((name) => new RegExp(`\\b${name}\\b`).test(lower));
  return word ? LANGUAGE_CODES[word] : 'en';
}
