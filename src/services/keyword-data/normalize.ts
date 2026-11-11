/**
 * DataForSEO Labs item → contract item.
 *
 * The one rule: a value DataForSEO did not give becomes null. Never 0, never a guess. A real 0 from
 * the API is kept, because "zero searches" is information and "unknown" is not.
 */
import type {
  DfsKeywordData,
  DfsKeywordOverviewResult,
  DfsRelatedKeywordsResult,
} from './dataforseo.client.js';
import {
  KEYWORD_INTENTS,
  normalizeKeyword,
  type KeywordIntent,
  type KeywordMetricsItem,
} from './keyword-data.types.js';

export function normalizeVolume(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

/** Difficulty is documented as 0–100; a stray out-of-range value is clamped, a non-number is null. */
export function normalizeDifficulty(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, Math.round(v)));
}

export function normalizeIntent(v: unknown): KeywordIntent | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return (KEYWORD_INTENTS as readonly string[]).includes(s) ? (s as KeywordIntent) : null;
}

/** One Labs keyword_data object → one contract item. */
export function normalizeKeywordData(item: DfsKeywordData, fetchedAt: Date): KeywordMetricsItem {
  return {
    keyword: normalizeKeyword(item.keyword),
    search_volume: normalizeVolume(item.keyword_info?.search_volume),
    keyword_difficulty: normalizeDifficulty(item.keyword_properties?.keyword_difficulty),
    intent: normalizeIntent(item.search_intent_info?.main_intent),
    scope: 'national',
    fetched_at: fetchedAt.toISOString(),
  };
}

/** An item for a keyword DataForSEO returned nothing for. Cached too, so an unknown keyword is paid for once. */
export function emptyItem(keyword: string, fetchedAt: Date): KeywordMetricsItem {
  return {
    keyword: normalizeKeyword(keyword),
    search_volume: null,
    keyword_difficulty: null,
    intent: null,
    scope: 'national',
    fetched_at: fetchedAt.toISOString(),
  };
}

export function normalizeOverview(result: DfsKeywordOverviewResult[], fetchedAt: Date): KeywordMetricsItem[] {
  const out: KeywordMetricsItem[] = [];
  for (const r of result ?? []) {
    for (const item of r?.items ?? []) {
      if (item && typeof item.keyword === 'string' && item.keyword.trim()) out.push(normalizeKeywordData(item, fetchedAt));
    }
  }
  return out;
}

export function normalizeRelated(result: DfsRelatedKeywordsResult[], fetchedAt: Date): KeywordMetricsItem[] {
  const out: KeywordMetricsItem[] = [];
  for (const r of result ?? []) {
    for (const item of r?.items ?? []) {
      const kd = item?.keyword_data;
      if (kd && typeof kd.keyword === 'string' && kd.keyword.trim()) out.push(normalizeKeywordData(kd, fetchedAt));
    }
  }
  return out;
}
