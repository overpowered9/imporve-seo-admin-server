/**
 * The live keyword data service: real DataForSEO client from env, real Postgres cache.
 *
 * Kept apart from the service and cache modules so those stay import-pure (no DATABASE_URL, no
 * credentials needed to unit-test them). Built lazily on first use, after index.ts has loaded
 * dotenv, and shared by every route.
 */
import sql from '../../data/db.js';
import { KEYWORD_DATA_DEFAULTS, dataForSeoCredentials } from '../../config/keyword-data.config.js';
import { createDataForSeoClient } from './dataforseo.client.js';
import { createKeywordDataCache } from './keyword-data-cache.js';
import { createKeywordDataService, type KeywordDataService } from './keyword-data.service.js';

let singleton: KeywordDataService | null = null;

export function getKeywordDataService(): KeywordDataService {
  if (singleton) return singleton;
  const creds = dataForSeoCredentials();
  if (!creds) {
    console.warn(
      'ℹ️ [keyword-data] DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set — keyword metrics answer 503 ' +
        'and the v3 Title/Planner steps run without keyword data.',
    );
  }
  const client = creds ? createDataForSeoClient({ ...creds, timeoutMs: KEYWORD_DATA_DEFAULTS.fetchBudgetMs }) : null;
  singleton = createKeywordDataService({ client, cache: createKeywordDataCache({ sql }) });
  return singleton;
}

/** Tests only: drop the shared instance so a different env can be exercised. */
export function __resetKeywordDataService(): void {
  singleton = null;
}
