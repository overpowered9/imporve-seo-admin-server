/**
 * The keyword data contract shared by the metrics API, the cache and the v3 prompt blocks.
 *
 * `KeywordMetricsItem` is the wire shape the plugin is built against. Every missing value is null,
 * never 0: a 0 means DataForSEO reported zero demand, a null means it reported nothing.
 */

export type KeywordIntent = 'informational' | 'commercial' | 'transactional' | 'navigational';

export const KEYWORD_INTENTS: readonly KeywordIntent[] = Object.freeze([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);

export interface KeywordMetricsItem {
  /** Normalised: trimmed, whitespace collapsed, lower-cased. */
  keyword: string;
  search_volume: number | null;
  /** 0–100. */
  keyword_difficulty: number | null;
  intent: KeywordIntent | null;
  /** v1 is national data only. */
  scope: 'national';
  /** ISO timestamp of the DataForSEO fetch this item came from. */
  fetched_at: string;
}

export interface KeywordCacheKey {
  keyword: string;
  location_code: number;
  language_code: string;
}

/**
 * The cache key form of a keyword: trimmed, inner whitespace collapsed to one space, lower-cased.
 * Also what the metrics endpoint echoes back as `keyword`, so a caller can match its own input.
 */
export function normalizeKeyword(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeLanguageCode(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Make a value safe to place inside an XML-style data tag in a prompt. The tags are delimiters
 * the model is told to treat as data, so a keyword or title must not be able to close or open one.
 */
export function escapeTagText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
