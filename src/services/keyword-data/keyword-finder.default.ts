/**
 * The live Keyword Finder: real DataForSEO client from env, real geo ladder.
 *
 * Kept apart from the service modules so those stay import-pure and unit-testable without
 * credentials. Built lazily on first use, after index.ts has loaded dotenv.
 *
 * The client here gets a LONGER timeout than the keyword-data one. That 8 s budget exists because
 * the Title and Planner steps run inside an article's overall time budget; this is an interactive
 * search where the user is waiting on purpose, and a Labs depth-3 call plus a Google Ads task can
 * legitimately take longer than that.
 */
import { dataForSeoCredentials } from '../../config/keyword-data.config.js';
import { ADS_DEFAULT_TIMEOUT_MS, createDataForSeoClient } from './dataforseo.client.js';
import { createGeoService, type GeoService } from './keyword-geo.service.js';
import { createKeywordFinderService } from './keyword-finder.service.js';
import { createSerpSignalService } from './serp-signal.service.js';

const FINDER_TIMEOUT_MS = Math.max(ADS_DEFAULT_TIMEOUT_MS, 30_000);

let client: ReturnType<typeof createDataForSeoClient> | null = null;
let geoSingleton: GeoService | null = null;
let finderSingleton: ReturnType<typeof createKeywordFinderService> | null = null;

export function isKeywordFinderConfigured(): boolean {
  return dataForSeoCredentials() !== null;
}

function getClient() {
  if (client) return client;
  const creds = dataForSeoCredentials();
  if (!creds) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set');
  }
  client = createDataForSeoClient({ ...creds, timeoutMs: FINDER_TIMEOUT_MS });
  return client;
}

export function getGeoService(): GeoService {
  if (geoSingleton) return geoSingleton;
  geoSingleton = createGeoService({ client: getClient() });
  return geoSingleton;
}

export function getKeywordFinderService() {
  if (finderSingleton) return finderSingleton;
  finderSingleton = createKeywordFinderService({
    labs: getClient(),
    geo: getGeoService(),
    serp: createSerpSignalService({ client: getClient() }),
  });
  return finderSingleton;
}

/** Tests only: drop the shared instances so a different env can be exercised. */
export function __resetKeywordFinder(): void {
  client = null;
  geoSingleton = null;
  finderSingleton = null;
}
