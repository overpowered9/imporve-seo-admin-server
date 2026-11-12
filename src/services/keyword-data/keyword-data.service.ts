/**
 * Keyword data service — cache first, DataForSEO second, never the browser.
 *
 * This is the one place keyword numbers come from. The metrics endpoint, the v3 prefetch and the
 * Title/Planner steps all read through here, so a number the plugin sends in a request body can
 * never reach a prompt or a response: the service only ever returns what the cache or DataForSEO
 * said.
 *
 *   getMetrics            Option A. Dedupe, look up the cache, ONE batched Labs call for the
 *                         misses, upsert, answer in request order.
 *   getSeedWithRelated    Prefetch and the v3 steps. Seed metrics + up to 30 related keywords,
 *                         under an overall time budget. On a miss both Labs calls run in parallel.
 *                         If the budget runs out the fetch keeps going in the background and
 *                         still fills the cache, so the next request is a hit.
 *   tryGetForPrompt       The v3 steps' entry point. Returns the rendered <keyword_data> block, or
 *                         null — never throws — and logs `[keyword-data] fallback` so a missing
 *                         block can be traced in the logs.
 *
 * Budget vs client timeout: the client's own 8 s timeout bounds ONE HTTP call; `budgetMs` bounds
 * the whole lookup (two calls in parallel plus cache I/O). Both default to 8 s.
 */
import { KEYWORD_DATA_DEFAULTS } from '../../config/keyword-data.config.js';
import { DataForSeoError, type DataForSeoClient } from './dataforseo.client.js';
import type { KeywordDataCache } from './keyword-data-cache.js';
import { buildKeywordDataBlock, selectRelated } from './keyword-data-block.js';
import { normalizeKeyword, normalizeLanguageCode, type KeywordMetricsItem } from './keyword-data.types.js';
import { emptyItem, normalizeOverview, normalizeRelated } from './normalize.js';

export class KeywordDataNotConfiguredError extends Error {
  readonly kind = 'not_configured' as const;
  constructor() {
    super('Keyword data is not configured on this server (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).');
    this.name = 'KeywordDataNotConfiguredError';
  }
}

export class KeywordDataBudgetError extends Error {
  readonly kind = 'budget' as const;
  constructor(readonly budgetMs: number) {
    super(`keyword data lookup exceeded its ${budgetMs} ms budget`);
    this.name = 'KeywordDataBudgetError';
  }
}

export interface MetricsResult {
  items: KeywordMetricsItem[];
  cached_count: number;
  cost_usd: number;
}

export type KeywordDataSource = 'cache' | 'dataforseo' | 'none';

export interface SeedWithRelated {
  status: 'ready' | 'unavailable';
  seed: KeywordMetricsItem | null;
  related: KeywordMetricsItem[];
  cost_usd: number;
  source: KeywordDataSource;
  /** Why it is unavailable: not_configured | budget | <DataForSeoError kind> | error. */
  reason?: string;
}

export interface PromptKeywordData {
  block: string;
  seed: KeywordMetricsItem;
  /** The related items the block shows, after sorting, de-duplication and the limit. */
  related: KeywordMetricsItem[];
  source: KeywordDataSource;
}

export interface KeywordDataService {
  readonly configured: boolean;
  getMetrics(keywords: string[], location_code?: number, language_code?: string): Promise<MetricsResult>;
  getSeedWithRelated(
    seed: string,
    location_code?: number,
    language_code?: string,
    options?: { budgetMs?: number },
  ): Promise<SeedWithRelated>;
  tryGetForPrompt(
    seed: string,
    location_code: number | undefined,
    language_code: string | undefined,
    limit: number,
    budgetMs?: number,
  ): Promise<PromptKeywordData | null>;
}

export interface KeywordDataServiceDeps {
  /** null when DATAFORSEO_* are not set. Cache hits still work; misses are "not configured". */
  client: DataForSeoClient | null;
  cache: KeywordDataCache;
  now?: () => Date;
  log?: (line: string) => void;
  /** Related keywords fetched and cached per seed. The Planner's 30 covers the Title's 10. */
  relatedFetchLimit?: number;
}

/** Reject after `ms` while letting `promise` run on; its own errors are swallowed once it has lost. */
export function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // Not unref()'d: the timer is cleared the moment the race settles, so it never outlives the
  // budget, and an unref'd timer would let a quiet event loop (tests, scripts) exit before it fires.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KeywordDataBudgetError(ms)), ms);
  });
  // If the budget wins, nothing awaits `promise` any more; keep its eventual rejection from
  // surfacing as an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function reasonOf(err: unknown): string {
  if (err instanceof KeywordDataBudgetError) return 'budget';
  if (err instanceof KeywordDataNotConfiguredError) return 'not_configured';
  if (err instanceof DataForSeoError) return err.kind;
  return 'error';
}

function isEmpty(item: KeywordMetricsItem): boolean {
  return item.search_volume === null && item.keyword_difficulty === null && item.intent === null;
}

export function createKeywordDataService(deps: KeywordDataServiceDeps): KeywordDataService {
  const {
    client,
    cache,
    now = () => new Date(),
    log = (line) => console.log(line),
    relatedFetchLimit = KEYWORD_DATA_DEFAULTS.plannerRelatedLimit,
  } = deps;

  const resolveLoc = (loc?: number) => (Number.isInteger(loc) && (loc as number) > 0 ? (loc as number) : KEYWORD_DATA_DEFAULTS.locationCode);
  const resolveLang = (lang?: string) => normalizeLanguageCode(lang) || KEYWORD_DATA_DEFAULTS.languageCode;

  async function getMetrics(keywords: string[], location_code?: number, language_code?: string): Promise<MetricsResult> {
    const loc = resolveLoc(location_code);
    const lang = resolveLang(language_code);

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of keywords) {
      const k = normalizeKeyword(raw);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      unique.push(k);
    }
    if (!unique.length) return { items: [], cached_count: 0, cost_usd: 0 };

    const cached = await cache.getMetrics(unique, loc, lang);
    const misses = unique.filter((k) => !cached.has(k));
    const fetched = new Map<string, KeywordMetricsItem>();
    let cost = 0;

    if (misses.length) {
      if (!client) throw new KeywordDataNotConfiguredError();
      const fetchedAt = now();
      const r = await client.keywordOverview({ keywords: misses, location_code: loc, language_code: lang });
      cost = r.cost;
      for (const item of normalizeOverview(r.result, fetchedAt)) {
        if (!fetched.has(item.keyword)) fetched.set(item.keyword, item);
      }
      // A keyword DataForSEO returned nothing for is cached as all-null, so it is paid for once.
      for (const k of misses) if (!fetched.has(k)) fetched.set(k, emptyItem(k, fetchedAt));
      await cache.putMetrics([...fetched.values()], loc, lang);
    }

    const items = unique.map((k) => cached.get(k) ?? (fetched.get(k) as KeywordMetricsItem));
    return { items, cached_count: cached.size, cost_usd: cost };
  }

  async function getSeedWithRelated(
    seed: string,
    location_code?: number,
    language_code?: string,
    options: { budgetMs?: number } = {},
  ): Promise<SeedWithRelated> {
    const loc = resolveLoc(location_code);
    const lang = resolveLang(language_code);
    const budgetMs = options.budgetMs ?? KEYWORD_DATA_DEFAULTS.fetchBudgetMs;
    const key = normalizeKeyword(seed);
    if (!key) return { status: 'unavailable', seed: null, related: [], cost_usd: 0, source: 'none', reason: 'empty_seed' };

    const lookup = (async () => {
      const [cachedMetrics, cachedRelated] = await Promise.all([
        cache.getMetrics([key], loc, lang),
        cache.getRelated(key, loc, lang),
      ]);
      return { seedHit: cachedMetrics.get(key) ?? null, relatedHit: cachedRelated };
    })();

    let seedHit: KeywordMetricsItem | null = null;
    let relatedHit: { related: KeywordMetricsItem[] } | null = null;
    try {
      ({ seedHit, relatedHit } = await withBudget(lookup, budgetMs));
    } catch (err) {
      log(`[keyword-data] fallback step=cache seed="${key}" reason=${reasonOf(err)}`);
      return { status: 'unavailable', seed: null, related: [], cost_usd: 0, source: 'none', reason: reasonOf(err) };
    }

    if (seedHit && relatedHit) {
      return { status: 'ready', seed: seedHit, related: relatedHit.related, cost_usd: 0, source: 'cache' };
    }

    const partial = (reason: string): SeedWithRelated => ({
      status: 'unavailable',
      seed: seedHit,
      related: relatedHit?.related ?? [],
      cost_usd: 0,
      source: seedHit || relatedHit ? 'cache' : 'none',
      reason,
    });

    if (!client) return partial('not_configured');

    const fetchedAt = now();
    const startedAt = fetchedAt.getTime();
    // Set when the caller stops waiting (budget exceeded or the fetch failed fast). "Late" is
    // decided by this flag, not by comparing elapsed time with budgetMs: Node timers can fire
    // a millisecond early by Date.now(), so a clock comparison sometimes missed a late answer.
    let callerGaveUp = false;
    // The fetch continues past the budget on purpose: a late answer still fills the cache.
    const work = (async (): Promise<SeedWithRelated> => {
      const [ov, rel] = await Promise.all([
        seedHit ? null : client.keywordOverview({ keywords: [key], location_code: loc, language_code: lang }),
        relatedHit ? null : client.relatedKeywords({ keyword: key, location_code: loc, language_code: lang, limit: relatedFetchLimit }),
      ]);
      const seedItem =
        seedHit ??
        normalizeOverview(ov?.result ?? [], fetchedAt).find((i) => i.keyword === key) ??
        normalizeOverview(ov?.result ?? [], fetchedAt)[0] ??
        emptyItem(key, fetchedAt);
      const related = relatedHit?.related ?? normalizeRelated(rel?.result ?? [], fetchedAt);
      const cost = (ov?.cost ?? 0) + (rel?.cost ?? 0);

      const toCache: KeywordMetricsItem[] = [];
      if (!seedHit) toCache.push(seedItem);
      if (!relatedHit) toCache.push(...related);
      await Promise.all([
        toCache.length ? cache.putMetrics(toCache, loc, lang) : Promise.resolve(),
        relatedHit ? Promise.resolve() : cache.putRelated(key, loc, lang, related, fetchedAt.toISOString()),
      ]);
      if (callerGaveUp) {
        log(`[keyword-data] late fetch cached seed="${key}" after_ms=${now().getTime() - startedAt}`);
      }
      return { status: 'ready', seed: seedItem, related, cost_usd: cost, source: 'dataforseo' };
    })();

    try {
      return await withBudget(work, Math.max(0, budgetMs - (now().getTime() - startedAt)));
    } catch (err) {
      callerGaveUp = true;
      const reason = reasonOf(err);
      log(`[keyword-data] fallback step=fetch seed="${key}" reason=${reason}`);
      return partial(reason);
    }
  }

  async function tryGetForPrompt(
    seed: string,
    location_code: number | undefined,
    language_code: string | undefined,
    limit: number,
    budgetMs: number = KEYWORD_DATA_DEFAULTS.fetchBudgetMs,
  ): Promise<PromptKeywordData | null> {
    const key = normalizeKeyword(seed);
    try {
      const r = await getSeedWithRelated(seed, location_code, language_code, { budgetMs });
      if (r.status !== 'ready' || !r.seed) {
        log(`[keyword-data] fallback step=prompt seed="${key}" reason=${r.reason ?? 'unavailable'}`);
        return null;
      }
      const related = selectRelated(r.seed, r.related, limit);
      if (!related.length && isEmpty(r.seed)) {
        log(`[keyword-data] fallback step=prompt seed="${key}" reason=no_data`);
        return null;
      }
      return {
        block: buildKeywordDataBlock(r.seed, r.related, limit, { location_code: resolveLoc(location_code) }),
        seed: r.seed,
        related,
        source: r.source,
      };
    } catch (err) {
      log(`[keyword-data] fallback step=prompt seed="${key}" reason=${reasonOf(err)}`);
      return null;
    }
  }

  return { configured: client !== null, getMetrics, getSeedWithRelated, tryGetForPrompt };
}
