/**
 * Keyword data cache — the Postgres tables behind migration 022.
 *
 * Two facets, filled by different calls:
 *   keyword_metrics_cache   one row per (keyword, location_code, language_code): volume, difficulty, intent
 *   keyword_related_cache   one row per seed: the normalised related list, as JSONB
 *
 * TTL is `expires_at` (30 days by default, config/keyword-data.config.ts). Reads filter on it, so an
 * expired row is a miss; the next fetch upserts over it.
 *
 * FAILS OPEN. Every method catches its own errors, logs one `[keyword-data] cache unavailable`
 * line and behaves as a miss / no-op. The cache exists to save money, and a missing table (code
 * deployed before the migration) or a blip must never turn into a failed keyword lookup.
 *
 * `sql` is injected (SqlLike, the same shape services/billing use) so the queries run against
 * test/helpers/fake-sql.ts in unit tests. The live wiring is in keyword-data.default.ts.
 */
import { KEYWORD_DATA_DEFAULTS } from '../../config/keyword-data.config.js';
import { normalizeKeyword, normalizeLanguageCode, type KeywordMetricsItem } from './keyword-data.types.js';
import { normalizeDifficulty, normalizeIntent, normalizeVolume } from './normalize.js';

export type SqlLike = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  begin<T>(fn: (tx: any) => Promise<T>): Promise<T>;
};

export interface RelatedCacheEntry {
  related: KeywordMetricsItem[];
  fetched_at: string;
}

export interface KeywordDataCache {
  /** Live (unexpired) items for these normalised keywords, keyed by keyword. Missing = miss. */
  getMetrics(keywords: string[], location_code: number, language_code: string): Promise<Map<string, KeywordMetricsItem>>;
  putMetrics(items: KeywordMetricsItem[], location_code: number, language_code: string): Promise<void>;
  getRelated(seed: string, location_code: number, language_code: string): Promise<RelatedCacheEntry | null>;
  putRelated(
    seed: string,
    location_code: number,
    language_code: string,
    related: KeywordMetricsItem[],
    fetchedAt: string,
  ): Promise<void>;
}

export interface KeywordDataCacheDeps {
  sql: SqlLike;
  ttlDays?: number;
  log?: (line: string) => void;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** A cached row → contract item. Re-normalised, so a hand-edited row cannot leak a bad value. */
function rowToItem(row: Record<string, unknown>): KeywordMetricsItem {
  return {
    keyword: normalizeKeyword(row.keyword),
    search_volume: normalizeVolume(row.search_volume === null ? null : Number(row.search_volume)),
    keyword_difficulty: normalizeDifficulty(row.keyword_difficulty === null ? null : Number(row.keyword_difficulty)),
    intent: normalizeIntent(row.intent),
    scope: 'national',
    fetched_at: toIso(row.fetched_at),
  };
}

/** The JSONB related list → items. Accepts an already-parsed array or a JSON string. */
function parseRelated(raw: unknown): KeywordMetricsItem[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((x) => x && typeof x === 'object' && typeof (x as { keyword?: unknown }).keyword === 'string')
    .map((x) => rowToItem(x as Record<string, unknown>));
}

export function createKeywordDataCache(deps: KeywordDataCacheDeps): KeywordDataCache {
  const { sql, ttlDays = KEYWORD_DATA_DEFAULTS.cacheTtlDays, log = (line) => console.warn(line) } = deps;

  const unavailable = (op: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[keyword-data] cache unavailable (${op}): ${msg}`);
  };

  return {
    async getMetrics(keywords, location_code, language_code) {
      const out = new Map<string, KeywordMetricsItem>();
      const keys = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))];
      if (!keys.length) return out;
      const lang = normalizeLanguageCode(language_code);
      try {
        const rows = await sql`
          SELECT keyword, search_volume, keyword_difficulty, intent, fetched_at
          FROM keyword_metrics_cache
          WHERE location_code = ${location_code}
            AND language_code = ${lang}
            AND keyword = ANY(${keys})
            AND expires_at > NOW()
        `;
        for (const row of rows) {
          const item = rowToItem(row);
          if (item.keyword) out.set(item.keyword, item);
        }
      } catch (err) {
        unavailable('getMetrics', err);
      }
      return out;
    },

    async putMetrics(items, location_code, language_code) {
      if (!items.length) return;
      const lang = normalizeLanguageCode(language_code);
      try {
        await sql.begin(async (tx) => {
          for (const item of items) {
            const keyword = normalizeKeyword(item.keyword);
            if (!keyword) continue;
            await tx`
              INSERT INTO keyword_metrics_cache
                (keyword, location_code, language_code, search_volume, keyword_difficulty, intent, fetched_at, expires_at)
              VALUES (
                ${keyword}, ${location_code}, ${lang},
                ${item.search_volume}, ${item.keyword_difficulty}, ${item.intent},
                ${item.fetched_at}::timestamptz,
                ${item.fetched_at}::timestamptz + make_interval(days => ${ttlDays})
              )
              ON CONFLICT (keyword, location_code, language_code) DO UPDATE
                SET search_volume = EXCLUDED.search_volume,
                    keyword_difficulty = EXCLUDED.keyword_difficulty,
                    intent = EXCLUDED.intent,
                    fetched_at = EXCLUDED.fetched_at,
                    expires_at = EXCLUDED.expires_at
            `;
          }
        });
      } catch (err) {
        unavailable('putMetrics', err);
      }
    },

    async getRelated(seed, location_code, language_code) {
      const key = normalizeKeyword(seed);
      if (!key) return null;
      const lang = normalizeLanguageCode(language_code);
      try {
        const rows = await sql`
          SELECT related, fetched_at
          FROM keyword_related_cache
          WHERE seed = ${key}
            AND location_code = ${location_code}
            AND language_code = ${lang}
            AND expires_at > NOW()
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return { related: parseRelated(row.related), fetched_at: toIso(row.fetched_at) };
      } catch (err) {
        unavailable('getRelated', err);
        return null;
      }
    },

    async putRelated(seed, location_code, language_code, related, fetchedAt) {
      const key = normalizeKeyword(seed);
      if (!key) return;
      const lang = normalizeLanguageCode(language_code);
      try {
        await sql`
          INSERT INTO keyword_related_cache (seed, location_code, language_code, related, fetched_at, expires_at)
          VALUES (
            ${key}, ${location_code}, ${lang},
            ${JSON.stringify(related)}::jsonb,
            ${fetchedAt}::timestamptz,
            ${fetchedAt}::timestamptz + make_interval(days => ${ttlDays})
          )
          ON CONFLICT (seed, location_code, language_code) DO UPDATE
            SET related = EXCLUDED.related,
                fetched_at = EXCLUDED.fetched_at,
                expires_at = EXCLUDED.expires_at
        `;
      } catch (err) {
        unavailable('putRelated', err);
      }
    },
  };
}

/** An in-memory cache with the same contract. For tests and for the A/B harness's dry runs. */
export function createMemoryKeywordDataCache(now: () => Date = () => new Date(), ttlDays = KEYWORD_DATA_DEFAULTS.cacheTtlDays): KeywordDataCache & {
  metrics: Map<string, { item: KeywordMetricsItem; expiresAt: number }>;
  related: Map<string, { entry: RelatedCacheEntry; expiresAt: number }>;
} {
  const metrics = new Map<string, { item: KeywordMetricsItem; expiresAt: number }>();
  const related = new Map<string, { entry: RelatedCacheEntry; expiresAt: number }>();
  const k = (keyword: string, loc: number, lang: string) => `${normalizeKeyword(keyword)}|${loc}|${normalizeLanguageCode(lang)}`;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  return {
    metrics,
    related,
    async getMetrics(keywords, loc, lang) {
      const out = new Map<string, KeywordMetricsItem>();
      for (const raw of keywords) {
        const key = normalizeKeyword(raw);
        const hit = metrics.get(k(key, loc, lang));
        if (hit && hit.expiresAt > now().getTime()) out.set(key, hit.item);
      }
      return out;
    },
    async putMetrics(items, loc, lang) {
      for (const item of items) {
        metrics.set(k(item.keyword, loc, lang), { item, expiresAt: new Date(item.fetched_at).getTime() + ttlMs });
      }
    },
    async getRelated(seed, loc, lang) {
      const hit = related.get(k(seed, loc, lang));
      return hit && hit.expiresAt > now().getTime() ? hit.entry : null;
    },
    async putRelated(seed, loc, lang, list, fetchedAt) {
      related.set(k(seed, loc, lang), { entry: { related: list, fetched_at: fetchedAt }, expiresAt: new Date(fetchedAt).getTime() + ttlMs });
    },
  };
}
