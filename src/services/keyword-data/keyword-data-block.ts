/**
 * The <keyword_data> block the Title and Planner steps receive in their USER message.
 *
 * Shape (fixed by the plugin/server contract):
 *
 *   <keyword_data scope="national" location="United States">
 *   seed: water heater repair cost | volume 2400 | difficulty 18 | intent commercial
 *   related:
 *   - water heater replacement cost | volume 1900 | difficulty 22 | intent commercial
 *   </keyword_data>
 *
 * Rules: related keywords sorted by volume descending (unknown volume last), exact duplicates of
 * the seed removed, duplicate related keywords removed, missing fields omitted from a line, and
 * `limit` applied after sorting and de-duplication (10 for Title, 30 for Planner).
 *
 * The Writer never receives this block; see the Writer isolation tests.
 */
import { KEYWORD_DATA_DEFAULTS } from '../../config/keyword-data.config.js';
import { escapeTagText, type KeywordMetricsItem } from './keyword-data.types.js';

/** DataForSEO location codes this product is likely to see. Anything else falls back to the code. */
export const LOCATION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  2840: 'United States',
  2826: 'United Kingdom',
  2124: 'Canada',
  2036: 'Australia',
  2554: 'New Zealand',
  2372: 'Ireland',
  2710: 'South Africa',
  2276: 'Germany',
  2250: 'France',
  2724: 'Spain',
  2380: 'Italy',
  2528: 'Netherlands',
  2356: 'India',
});

export function locationName(locationCode: number): string {
  return LOCATION_NAMES[locationCode] ?? `location_code ${locationCode}`;
}

/** `keyword | volume N | difficulty N | intent x`, with every missing field left out. */
export function formatKeywordLine(item: KeywordMetricsItem): string {
  const parts = [escapeTagText(item.keyword)];
  if (item.search_volume !== null) parts.push(`volume ${item.search_volume}`);
  if (item.keyword_difficulty !== null) parts.push(`difficulty ${item.keyword_difficulty}`);
  if (item.intent !== null) parts.push(`intent ${item.intent}`);
  return parts.join(' | ');
}

/** Sort by volume descending with unknown volumes last; stable, so ties keep DataForSEO's order. */
export function sortByVolumeDesc(items: KeywordMetricsItem[]): KeywordMetricsItem[] {
  return [...items].sort((a, b) => {
    if (a.search_volume === null && b.search_volume === null) return 0;
    if (a.search_volume === null) return 1;
    if (b.search_volume === null) return -1;
    return b.search_volume - a.search_volume;
  });
}

/** The related list as the block shows it: sorted, seed removed, de-duplicated, capped. */
export function selectRelated(seed: KeywordMetricsItem, related: KeywordMetricsItem[], limit: number): KeywordMetricsItem[] {
  const seen = new Set<string>([seed.keyword]);
  const out: KeywordMetricsItem[] = [];
  for (const item of sortByVolumeDesc(related)) {
    if (!item.keyword || seen.has(item.keyword)) continue;
    seen.add(item.keyword);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function buildKeywordDataBlock(
  seed: KeywordMetricsItem,
  related: KeywordMetricsItem[],
  limit: number,
  options: { location_code?: number } = {},
): string {
  const location = locationName(options.location_code ?? KEYWORD_DATA_DEFAULTS.locationCode);
  const chosen = selectRelated(seed, related, Math.max(0, Math.floor(limit)));
  const lines = [
    `<keyword_data scope="national" location="${escapeTagText(location)}">`,
    `seed: ${formatKeywordLine(seed)}`,
  ];
  if (chosen.length) {
    lines.push('related:');
    for (const item of chosen) lines.push(`- ${formatKeywordLine(item)}`);
  }
  lines.push('</keyword_data>');
  return lines.join('\n');
}
