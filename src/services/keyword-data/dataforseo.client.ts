/**
 * DataForSEO Labs client — the only module that talks to DataForSEO.
 *
 * SCOPE (decided for keyword data v1): Labs endpoints only — keyword overview, related keywords and
 * search intent. Nothing here may call the Google Ads / Keywords Data family, and `assertLabsPath`
 * refuses any path outside `/dataforseo_labs/` so that rule cannot be bent by a later edit. National
 * data only: a call carries one `location_code` (a country) and one `language_code`.
 *
 * CONTENT V3 ADDITION (search data lookup, decided 30 Oct): two Google SERP endpoints, listed by
 * exact path in SERP_ENDPOINTS — organic live/advanced (POST, with People Also Ask and related
 * searches) and the free locations list (GET, per country). `assertAllowedPath` admits Labs paths
 * and exactly those; the Google Ads / Keywords Data family is still refused.
 *
 * CREDENTIALS come from the caller (the config module reads DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD
 * from env). They are sent as HTTP Basic auth and never logged: the per-call log line carries the
 * endpoint, the HTTP status, DataForSEO's status code, the latency and the `cost` field only.
 *
 * TIMEOUT AND RETRY
 *  - Every call has an 8 s timeout by default (AbortController on global fetch).
 *  - One retry with a short backoff on a NETWORK error (DNS, reset, refused) or a SERVER error
 *    (HTTP 5xx, or DataForSEO status 5xxxx). Those are the failures where a second attempt can
 *    plausibly succeed.
 *  - A TIMEOUT is not retried. The Title and Planner steps run this client under an 8 s overall
 *    budget, and a retry after an 8 s wait would double it for no benefit; callers that want a
 *    second try can call again.
 *  - Auth, payment, rate-limit and bad-request errors are never retried.
 *
 * ERRORS are always a DataForSeoError with a `kind`, so callers branch on a closed set instead of
 * parsing messages. Task-level status codes (the `tasks[0].status_code` DataForSEO returns inside
 * a 200 response) are mapped the same way as HTTP statuses.
 *
 * Dependency-injected (`fetchImpl`, `sleep`, `log`, `now`) so the unit tests run with no network.
 */
import { runTag } from '../run-context.js';

// ---------- public types ----------

export type DataForSeoErrorKind =
  | 'auth'
  | 'payment'
  | 'rate_limit'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'task_error';

/** Where the failure was detected. `task` is DataForSEO's per-task status inside a 200 response. */
export type DataForSeoErrorLevel = 'http' | 'response' | 'task' | 'transport';

export class DataForSeoError extends Error {
  readonly kind: DataForSeoErrorKind;
  readonly level: DataForSeoErrorLevel;
  readonly endpoint: string;
  readonly httpStatus: number | null;
  /** DataForSEO's own status code (20000, 40100, 50000 …) when one was returned. */
  readonly statusCode: number | null;
  readonly retryable: boolean;

  constructor(init: {
    kind: DataForSeoErrorKind;
    level: DataForSeoErrorLevel;
    endpoint: string;
    message: string;
    httpStatus?: number | null;
    statusCode?: number | null;
    retryable?: boolean;
  }) {
    super(`[dataforseo] ${init.endpoint}: ${init.message}`);
    this.name = 'DataForSeoError';
    this.kind = init.kind;
    this.level = init.level;
    this.endpoint = init.endpoint;
    this.httpStatus = init.httpStatus ?? null;
    this.statusCode = init.statusCode ?? null;
    this.retryable = init.retryable ?? (init.kind === 'server' || init.kind === 'network');
  }
}

/** The envelope every DataForSEO v3 response uses. */
export interface DfsTask<R> {
  id: string;
  status_code: number;
  status_message: string;
  time?: string;
  cost?: number;
  result_count?: number;
  path?: string[];
  data?: unknown;
  result: R[] | null;
}

export interface DfsResponse<R> {
  version?: string;
  status_code: number;
  status_message?: string;
  time?: string;
  cost?: number;
  tasks_count?: number;
  tasks_error?: number;
  tasks?: DfsTask<R>[];
}

// Labs item shapes — the subset this product reads. Everything is optional/nullable on purpose:
// DataForSEO omits or nulls fields it has no data for, and normalisation (keyword-data/normalize.ts)
// turns every gap into a null, never a 0.
export interface DfsKeywordInfo {
  search_volume?: number | null;
  cpc?: number | null;
  competition?: number | null;
  competition_level?: string | null;
}

export interface DfsKeywordProperties {
  keyword_difficulty?: number | null;
  core_keyword?: string | null;
}

export interface DfsSearchIntentInfo {
  main_intent?: string | null;
  foreign_intent?: string[] | null;
}

export interface DfsKeywordData {
  keyword: string;
  location_code?: number | null;
  language_code?: string | null;
  keyword_info?: DfsKeywordInfo | null;
  keyword_properties?: DfsKeywordProperties | null;
  search_intent_info?: DfsSearchIntentInfo | null;
}

/** dataforseo_labs/google/keyword_overview/live → tasks[].result[] */
export interface DfsKeywordOverviewResult {
  se_type?: string;
  location_code?: number;
  language_code?: string;
  total_count?: number;
  items_count?: number;
  items: DfsKeywordData[] | null;
}

/** dataforseo_labs/google/related_keywords/live → tasks[].result[] */
export interface DfsRelatedKeywordsItem {
  se_type?: string;
  keyword_data: DfsKeywordData;
  depth?: number;
  related_keywords?: string[] | null;
}

export interface DfsRelatedKeywordsResult {
  se_type?: string;
  seed_keyword?: string;
  location_code?: number;
  language_code?: string;
  total_count?: number;
  items_count?: number;
  items: DfsRelatedKeywordsItem[] | null;
}

/** dataforseo_labs/google/search_intent/live → tasks[].result[] */
export interface DfsSearchIntentItem {
  keyword: string;
  keyword_intent?: { label?: string | null; probability?: number | null } | null;
  secondary_keyword_intents?: Array<{ label?: string | null; probability?: number | null }> | null;
}

export interface DfsSearchIntentResult {
  language_code?: string;
  items_count?: number;
  items: DfsSearchIntentItem[] | null;
}

export interface DataForSeoCallResult<R> {
  result: R[];
  /** The `cost` field DataForSEO returns for the call, in USD. 0 when absent. */
  cost: number;
  latencyMs: number;
  taskId: string | null;
  /** 1 on a first-try success, 2 when the retry succeeded. */
  attempts: number;
}

export interface KeywordOverviewParams {
  keywords: string[];
  location_code: number;
  language_code: string;
}

export interface RelatedKeywordsParams {
  keyword: string;
  location_code: number;
  language_code: string;
  /** Max keywords returned (DataForSEO caps at 1000). */
  limit?: number;
  /** Search depth 0–4. 1 returns up to 8 keywords, 2 up to 72. */
  depth?: number;
}

export interface SearchIntentParams {
  keywords: string[];
  language_code: string;
}

export interface DataForSeoClient {
  keywordOverview(params: KeywordOverviewParams): Promise<DataForSeoCallResult<DfsKeywordOverviewResult>>;
  relatedKeywords(params: RelatedKeywordsParams): Promise<DataForSeoCallResult<DfsRelatedKeywordsResult>>;
  searchIntent(params: SearchIntentParams): Promise<DataForSeoCallResult<DfsSearchIntentResult>>;
}

// ---------- Google SERP (Content v3 search data lookup) ----------

/** One SERP item. Only the fields the search data lookup reads; DataForSEO sends many more. */
export interface DfsSerpItem {
  type: string;
  rank_group?: number | null;
  rank_absolute?: number | null;
  /** organic */
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  /** people_also_ask → people_also_ask_element[] (each has `title`, the question); related_searches → string[] */
  items?: Array<DfsSerpItem | string> | null;
}

/** serp/google/organic/live/advanced → tasks[].result[] */
export interface DfsSerpResult {
  keyword?: string;
  location_code?: number | null;
  language_code?: string | null;
  items_count?: number;
  items: DfsSerpItem[] | null;
}

/** serp/google/locations/{country} → tasks[].result[] (free). */
export interface DfsLocation {
  location_code: number;
  location_name: string;
  location_code_parent?: number | null;
  country_iso_code?: string | null;
  location_type?: string | null;
}

export interface SerpOrganicParams {
  keyword: string;
  language_code: string;
  /** Exactly one of location_code / location_coordinate ("lat,lng,radius_mm"). */
  location_code?: number;
  location_coordinate?: string;
  /** Default 10 (decided 30 Oct). */
  depth?: number;
  /** Default 1 (decided 30 Oct). */
  people_also_ask_click_depth?: number;
  /** Per-call timeout; the Labs default of 8 s is too short for a SERP call with a PAA click. */
  timeoutMs?: number;
}

export interface DataForSeoSerpClient {
  serpOrganicAdvanced(params: SerpOrganicParams): Promise<DataForSeoCallResult<DfsSerpResult>>;
  /** ISO 3166-1 alpha-2, e.g. "us". */
  serpGoogleLocations(countryIso: string, opts?: { timeoutMs?: number }): Promise<DataForSeoCallResult<DfsLocation>>;
}

export interface DataForSeoClientOptions {
  login: string;
  password: string;
  /** Defaults to global fetch. Injected by tests. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout. Default 8000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt, for retryable failures only. Default 1. */
  maxRetries?: number;
  /** Backoff before a retry. Default 300 ms (multiplied by the attempt number). */
  retryBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  /** Default https://api.dataforseo.com/v3. Overridable for tests only. */
  baseUrl?: string;
}

// ---------- endpoints ----------

export const DATAFORSEO_BASE_URL = 'https://api.dataforseo.com/v3';

/** The complete list of paths this client can call. All Labs; see assertLabsPath. */
export const LABS_ENDPOINTS = Object.freeze({
  keyword_overview: '/dataforseo_labs/google/keyword_overview/live',
  related_keywords: '/dataforseo_labs/google/related_keywords/live',
  search_intent: '/dataforseo_labs/google/search_intent/live',
});

export type LabsEndpointKey = keyof typeof LABS_ENDPOINTS;

/** The Google SERP paths Content v3's search data lookup may call. Exact paths, nothing else. */
export const SERP_ENDPOINTS = Object.freeze({
  serp_organic_advanced: '/serp/google/organic/live/advanced',
  serp_google_locations: '/serp/google/locations',
});

export type SerpEndpointKey = keyof typeof SERP_ENDPOINTS;
type EndpointKey = LabsEndpointKey | SerpEndpointKey;

const LABS_PREFIX = '/dataforseo_labs/';

/** Refuse any path outside DataForSEO Labs. The Google Ads / Keywords Data family must never be called. */
export function assertLabsPath(path: string): void {
  if (!path.startsWith(LABS_PREFIX)) {
    throw new Error(`DataForSEO path "${path}" is outside ${LABS_PREFIX}; only Labs endpoints are allowed`);
  }
}

/**
 * Labs paths, or exactly the SERP organic live/advanced path, or the locations list for one
 * two-letter country. Everything else — above all /keywords_data/ (Google Ads) — is refused.
 */
export function assertAllowedPath(path: string): void {
  if (path.startsWith(LABS_PREFIX)) return;
  if (path === SERP_ENDPOINTS.serp_organic_advanced) return;
  if (/^\/serp\/google\/locations\/[a-z]{2}$/.test(path)) return;
  throw new Error(`DataForSEO path "${path}" is not allowed; only Labs and the Content v3 SERP endpoints are`);
}

/** DataForSEO-reported volumes of related keywords are capped per depth; depth 2 covers the Planner's 30. */
export const DEFAULT_RELATED_DEPTH = 2;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_RETRY_BACKOFF_MS = 300;

// ---------- status code mapping ----------

/**
 * DataForSEO status code → error kind. The codes come from the DataForSEO v3 errors reference:
 * 401xx authorisation, 402xx payment and quota, 40006/40202/40203/40503 rate and concurrency limits,
 * other 4xxxx request errors, 5xxxx server-side.
 */
export function kindForStatusCode(code: number): DataForSeoErrorKind {
  if (code >= 50000) return 'server';
  if (code === 40100 || code === 40101 || code === 40102) return 'auth';
  if (code === 40200 || code === 40201 || code === 40209 || code === 40210) return 'payment';
  if (code === 40006 || code === 40202 || code === 40203 || code === 40503) return 'rate_limit';
  if (code >= 40000) return 'bad_request';
  // Anything else that is not 20000 (e.g. 20100 "Task Created" on a live endpoint) is unexpected.
  return 'task_error';
}

export function kindForHttpStatus(status: number): DataForSeoErrorKind {
  if (status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'payment';
  if (status === 429) return 'rate_limit';
  return 'bad_request';
}

// ---------- client ----------

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
    return `${err.message}${causeMsg}`;
  }
  return String(err);
}

export function createDataForSeoClient(options: DataForSeoClientOptions): DataForSeoClient & DataForSeoSerpClient {
  const {
    login,
    password,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 1,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = (line) => console.log(line),
    now = () => Date.now(),
    baseUrl = DATAFORSEO_BASE_URL,
  } = options;

  if (!login || !password) {
    throw new Error('DataForSEO client needs a login and a password');
  }

  // Built once; never logged, never included in an error message.
  const authorization = `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;

  async function fetchWithTimeout(url: string, body: string | null, callTimeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeoutMs);
    try {
      return await fetchImpl(url, {
        method: body === null ? 'GET' : 'POST',
        headers: {
          Authorization: authorization,
          ...(body === null ? {} : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
        },
        ...(body === null ? {} : { body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function attemptOnce<R>(
    key: EndpointKey,
    url: string,
    body: string | null,
    callTimeoutMs: number,
  ): Promise<{ result: R[]; cost: number; taskId: string | null; httpStatus: number; statusCode: number }> {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, body, callTimeoutMs);
    } catch (err) {
      if (isAbortError(err)) {
        throw new DataForSeoError({
          kind: 'timeout',
          level: 'transport',
          endpoint: key,
          message: `timed out after ${callTimeoutMs} ms`,
          retryable: false,
        });
      }
      throw new DataForSeoError({
        kind: 'network',
        level: 'transport',
        endpoint: key,
        message: `network error: ${describe(err)}`,
        retryable: true,
      });
    }

    const httpStatus = response.status;
    let json: DfsResponse<R> | null = null;
    try {
      json = (await response.json()) as DfsResponse<R>;
    } catch {
      json = null;
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      const kind = kindForHttpStatus(httpStatus);
      throw new DataForSeoError({
        kind,
        level: 'http',
        endpoint: key,
        message: `HTTP ${httpStatus}${json?.status_message ? `: ${json.status_message}` : ''}`,
        httpStatus,
        statusCode: typeof json?.status_code === 'number' ? json.status_code : null,
      });
    }

    if (!json || typeof json.status_code !== 'number') {
      throw new DataForSeoError({
        kind: 'server',
        level: 'response',
        endpoint: key,
        message: 'malformed response body',
        httpStatus,
      });
    }

    if (json.status_code !== 20000) {
      throw new DataForSeoError({
        kind: kindForStatusCode(json.status_code),
        level: 'response',
        endpoint: key,
        message: `status ${json.status_code}: ${json.status_message ?? 'unknown'}`,
        httpStatus,
        statusCode: json.status_code,
      });
    }

    const task = json.tasks?.[0];
    if (!task) {
      throw new DataForSeoError({
        kind: 'task_error',
        level: 'task',
        endpoint: key,
        message: 'response carried no task',
        httpStatus,
        statusCode: json.status_code,
        retryable: false,
      });
    }

    if (task.status_code !== 20000) {
      throw new DataForSeoError({
        kind: kindForStatusCode(task.status_code),
        level: 'task',
        endpoint: key,
        message: `task status ${task.status_code}: ${task.status_message ?? 'unknown'}`,
        httpStatus,
        statusCode: task.status_code,
      });
    }

    const cost = Number(json.cost ?? task.cost ?? 0);
    return {
      result: Array.isArray(task.result) ? task.result : [],
      cost: Number.isFinite(cost) ? cost : 0,
      taskId: task.id ?? null,
      httpStatus,
      statusCode: task.status_code,
    };
  }

  async function call<R>(key: LabsEndpointKey, taskPayload: Record<string, unknown>): Promise<DataForSeoCallResult<R>> {
    const path = LABS_ENDPOINTS[key];
    assertLabsPath(path);
    // DataForSEO takes an ARRAY of tasks; live endpoints accept one.
    return request<R>(key, path, JSON.stringify([taskPayload]), timeoutMs);
  }

  /** The shared retry/log loop. `body` null = GET. */
  async function request<R>(key: EndpointKey, path: string, body: string | null, callTimeoutMs: number): Promise<DataForSeoCallResult<R>> {
    assertAllowedPath(path);
    const url = `${baseUrl}${path}`;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const started = now();
      try {
        const r = await attemptOnce<R>(key, url, body, callTimeoutMs);
        const latencyMs = now() - started;
        log(
          `[dataforseo]${runTag()} endpoint=${key} http=${r.httpStatus} status=${r.statusCode} ` +
            `latency_ms=${latencyMs} cost=${r.cost} attempt=${attempt}`,
        );
        return { result: r.result, cost: r.cost, latencyMs, taskId: r.taskId, attempts: attempt };
      } catch (err) {
        const latencyMs = now() - started;
        const dfsErr =
          err instanceof DataForSeoError
            ? err
            : new DataForSeoError({
                kind: 'network',
                level: 'transport',
                endpoint: key,
                message: describe(err),
                retryable: true,
              });
        const willRetry = dfsErr.retryable && attempt <= maxRetries;
        log(
          `[dataforseo]${runTag()} endpoint=${key} error kind=${dfsErr.kind} level=${dfsErr.level} ` +
            `http=${dfsErr.httpStatus ?? '-'} status=${dfsErr.statusCode ?? '-'} ` +
            `latency_ms=${latencyMs} attempt=${attempt} retry=${willRetry ? 'yes' : 'no'}`,
        );
        if (!willRetry) throw dfsErr;
        await sleep(retryBackoffMs * attempt);
      }
    }
  }

  return {
    keywordOverview(params) {
      return call<DfsKeywordOverviewResult>('keyword_overview', {
        keywords: params.keywords,
        location_code: params.location_code,
        language_code: params.language_code,
        include_serp_info: false,
        include_clickstream_data: false,
      });
    },
    relatedKeywords(params) {
      return call<DfsRelatedKeywordsResult>('related_keywords', {
        keyword: params.keyword,
        location_code: params.location_code,
        language_code: params.language_code,
        depth: params.depth ?? DEFAULT_RELATED_DEPTH,
        limit: params.limit ?? 30,
        include_seed_keyword: false,
        include_serp_info: false,
        include_clickstream_data: false,
        order_by: ['keyword_data.keyword_info.search_volume,desc'],
      });
    },
    searchIntent(params) {
      return call<DfsSearchIntentResult>('search_intent', {
        keywords: params.keywords,
        language_code: params.language_code,
      });
    },
    serpOrganicAdvanced(params) {
      const task: Record<string, unknown> = {
        keyword: params.keyword,
        language_code: params.language_code,
        depth: params.depth ?? 10,
        people_also_ask_click_depth: params.people_also_ask_click_depth ?? 1,
      };
      if (params.location_coordinate) task.location_coordinate = params.location_coordinate;
      else task.location_code = params.location_code;
      return request<DfsSerpResult>('serp_organic_advanced', SERP_ENDPOINTS.serp_organic_advanced, JSON.stringify([task]), params.timeoutMs ?? timeoutMs);
    },
    serpGoogleLocations(countryIso, opts) {
      const iso = String(countryIso || '').trim().toLowerCase();
      return request<DfsLocation>('serp_google_locations', `${SERP_ENDPOINTS.serp_google_locations}/${iso}`, null, opts?.timeoutMs ?? Math.max(timeoutMs, 20_000));
    },
  };
}
