/**
 * DataForSEO's Google locations list per country (free endpoint), held in memory and indexed for
 * town resolution and keyword detection (towns.ts). Fetched once per country per process and kept
 * for 7 days; concurrent first requests share one fetch. A failure returns null (the lookup then
 * treats every town as unresolved and runs the country-level call) and is retried after 10 minutes.
 */
import type { DataForSeoSerpClient } from '../keyword-data/dataforseo.client.js';
import { buildLocationIndex, type LocationIndex } from './towns.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

export interface LocationIndexProvider {
  get(countryIso: string): Promise<LocationIndex | null>;
}

export function createLocationIndexProvider(deps: {
  client: DataForSeoSerpClient | null;
  log?: (line: string) => void;
  now?: () => number;
}): LocationIndexProvider {
  const { log = (line) => console.log(line), now = () => Date.now() } = deps;
  const cache = new Map<string, { index: LocationIndex | null; at: number }>();
  const inflight = new Map<string, Promise<LocationIndex | null>>();

  return {
    async get(countryIso) {
      const iso = countryIso.toLowerCase();
      const hit = cache.get(iso);
      if (hit) {
        const age = now() - hit.at;
        if (hit.index && age < TTL_MS) return hit.index;
        if (!hit.index && age < RETRY_AFTER_FAILURE_MS) return null;
      }
      if (!deps.client) return null;
      const running = inflight.get(iso);
      if (running) return running;
      const p = (async () => {
        try {
          const r = await deps.client!.serpGoogleLocations(iso);
          const index = buildLocationIndex(r.result, iso);
          cache.set(iso, { index, at: now() });
          log(`[search-data] locations country=${iso} entries=${index.size} towns=${index.byName.size} ms=${r.latencyMs}`);
          return index;
        } catch (err) {
          cache.set(iso, { index: null, at: now() });
          log(`[search-data] locations country=${iso} unavailable: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        } finally {
          inflight.delete(iso);
        }
      })();
      inflight.set(iso, p);
      return p;
    },
  };
}

/** A fixed index (tests, or a site without network access). */
export function staticLocationIndexProvider(index: LocationIndex | null): LocationIndexProvider {
  return { get: async () => index };
}
