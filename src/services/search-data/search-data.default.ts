/**
 * Live wiring for the search data lookup: the shared DataForSEO client (same credentials as the
 * keyword data work, S11), the in-memory locations index, and the per-session cache (S9, W12).
 */
import { dataForSeoCredentials } from '../../config/keyword-data.config.js';
import { searchDataConfig } from '../../config/search-data.config.js';
import { createDataForSeoClient, type DataForSeoSerpClient } from '../keyword-data/dataforseo.client.js';
import type { ContentV3Store } from '../content-v3/store.js';
import { createLocationIndexProvider, type LocationIndexProvider } from './locations.js';
import { lookupSearchData, searchDataCacheKey, type SearchDataDeps, type SearchDataRequest, type SearchDataResult } from './search-data.service.js';

let deps: SearchDataDeps | null = null;

export function liveSearchDataDeps(): SearchDataDeps {
  if (deps) return deps;
  const creds = dataForSeoCredentials();
  const cfg = searchDataConfig();
  const client: DataForSeoSerpClient | null = creds ? createDataForSeoClient({ ...creds, timeoutMs: cfg.timeoutMs }) : null;
  if (!client) console.warn('ℹ️ [search-data] DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set — the v3 title runs without search data.');
  const locations: LocationIndexProvider = createLocationIndexProvider({ client });
  deps = { client, locations, config: cfg };
  return deps;
}

/** Tests only. */
export function __resetSearchDataDeps(): void {
  deps = null;
}

export interface CachedSearchData extends SearchDataResult {
  cached: boolean;
}

/**
 * The lookup through the wizard session: the same keyword + place + language in the same session
 * reuses the stored result (Regenerate title, Approve title after a typed title), so DataForSEO is
 * paid once per session. A lookup where every call failed is not stored, so the next click retries.
 */
export async function sessionSearchData(
  store: ContentV3Store,
  ids: { userId: number; websiteId: number; sessionKey: string | null },
  req: SearchDataRequest,
  d: SearchDataDeps = liveSearchDataDeps(),
): Promise<CachedSearchData> {
  const key = searchDataCacheKey(req);
  if (ids.sessionKey) {
    const session = await store.getSession(ids.userId, ids.websiteId, ids.sessionKey);
    const hit = session?.search_data as { key?: string; result?: SearchDataResult } | undefined;
    if (hit?.key === key && hit.result) {
      console.log(`[search-data] session hit run=${ids.sessionKey} seed="${req.seed_keyword}" key="${key}"`);
      return { ...hit.result, cached: true };
    }
  }
  const result = await lookupSearchData(req, d);
  if (ids.sessionKey && result.meta.calls.some((c) => c.ok)) {
    await store.mergeSession(ids.userId, ids.websiteId, ids.sessionKey, { search_data: { key, result } });
  }
  return { ...result, cached: false };
}
