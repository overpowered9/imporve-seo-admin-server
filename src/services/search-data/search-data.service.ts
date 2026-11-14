/**
 * Search data lookup (code, runs before PROMPT 1 · Title) — docs/content-v3-prompt-drafts.md,
 * "Search data lookup", decided settings 30 Oct 2026.
 *
 *   Nationwide business, or a post marked "Not about a specific location": ONE call, location =
 *   the country (S2).
 *   Local post: first call at the Target town (S3). Thin (fewer than SEARCH_DATA_THIN_THRESHOLD
 *   People Also Ask questions OR related searches, S4) → a second call at the country with the
 *   town taken out of the keyword (S5). No state-level call, ever (S8).
 *   Merge: local first, then national; duplicates removed; caps 10 / 8 / 8; every item scoped
 *   local or national (S6). Only LOCAL ranking domains are returned for the Research competitor
 *   filter (S7).
 *
 * Never throws and never blocks the title: a provider failure on the first call is treated like a
 * thin result (the country call still runs); if nothing comes back the block is null and the Title
 * prompt's own rule applies ("If <search_data> is missing, work from <seed_keyword>").
 *
 * One log line per lookup (S9): mode, location, whether the national call ran, the counts of each
 * call and the merged block, cost and time.
 */
import { MERGE_CAPS, SERP_DEPTH, SERP_PAA_CLICK_DEPTH, languageCodeFor, searchDataConfig, type SearchDataConfig } from '../../config/search-data.config.js';
import type { DataForSeoSerpClient, DfsSerpItem, DfsSerpResult } from '../keyword-data/dataforseo.client.js';
import type { ScopedItem, SearchDataInput } from '../content-v3-steps/types.js';
import type { LocationIndexProvider } from './locations.js';
import { detectTownInKeyword, parseTown, resolveTown, stripTownFromKeyword, type TownResolution } from './towns.js';
import { runTag } from '../run-context.js';

export interface SerpParsed {
  titles: Array<{ text: string; domain: string; url: string }>;
  questions: string[];
  related: string[];
}

function clean(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

/** DataForSEO SERP result → the three lists the block needs, in SERP order. */
export function parseSerp(results: DfsSerpResult[]): SerpParsed {
  const out: SerpParsed = { titles: [], questions: [], related: [] };
  for (const r of results ?? []) {
    for (const item of r?.items ?? []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'organic') {
        const text = clean(item.title);
        if (text) out.titles.push({ text, domain: clean(item.domain).toLowerCase().replace(/^www\./, ''), url: clean(item.url) });
      } else if (item.type === 'people_also_ask') {
        for (const el of item.items ?? []) {
          const q = typeof el === 'string' ? clean(el) : clean((el as DfsSerpItem).title);
          if (q) out.questions.push(q);
        }
      } else if (item.type === 'related_searches') {
        for (const el of item.items ?? []) {
          const q = typeof el === 'string' ? clean(el) : clean((el as DfsSerpItem).title);
          if (q) out.related.push(q);
        }
      }
    }
  }
  return out;
}

export function isThin(p: Pick<SerpParsed, 'questions' | 'related'>, threshold: number): boolean {
  return p.questions.length < threshold || p.related.length < threshold;
}

const dedupeKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Local first, then national; duplicates (case and punctuation insensitive) removed; capped. */
export function mergeScoped(local: string[], national: string[], cap: number): ScopedItem[] {
  const seen = new Set<string>();
  const out: ScopedItem[] = [];
  for (const [list, scope] of [[local, 'local'], [national, 'national']] as const) {
    for (const text of list) {
      const k = dedupeKey(text);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ text, scope });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export interface SearchDataRequest {
  seed_keyword: string;
  /** As the wizard sends it ("English") or a code. */
  language?: string;
  /** "local" or "nationwide" (Business details). */
  reach?: string;
  /** The post's Target town, as chosen in step 1. Empty for nationwide. */
  target_town?: string | null;
  /** The post was marked "Not about a specific location" (W5): one country-level call. */
  not_about_location?: boolean;
  /** State from Business details, used when the town is typed without one. */
  state_hint?: string | null;
  /** "lat,lng,radius_mm" for a town DataForSEO does not list, when the site has it. */
  town_coordinate?: string | null;
}

export interface SearchDataCall {
  scope: 'local' | 'national';
  keyword: string;
  location: string;
  ok: boolean;
  counts: { titles: number; questions: number; related: number };
  cost_usd: number;
  ms: number;
  error?: string;
}

export interface SearchDataMeta {
  mode: 'national' | 'local' | 'local_unresolved';
  location_used: string;
  national_fallback: boolean;
  town_resolution: TownResolution | { status: 'not_needed' };
  /** A town found in the seed keyword (S10). */
  keyword_town: string | null;
  /** W6: the keyword names a town other than the chosen Target town. */
  town_mismatch: { keyword_town: string; target_town: string } | null;
  calls: SearchDataCall[];
  counts: { titles: number; questions: number; related: number };
  /** Domains of the LOCAL ranking pages only (S7, R4). */
  local_domains: string[];
  cost_usd: number;
  ms: number;
}

export interface SearchDataResult {
  /** null when no call returned anything; the Title prompt then works from the keyword. */
  block: SearchDataInput | null;
  meta: SearchDataMeta;
}

export interface SearchDataDeps {
  client: DataForSeoSerpClient | null;
  locations: LocationIndexProvider;
  config?: SearchDataConfig;
  log?: (line: string) => void;
  now?: () => number;
}

/** True when the post is local and about a town (not nationwide, not "Not about a specific location"). */
export function isLocalPost(req: SearchDataRequest): boolean {
  const nationwide = String(req.reach ?? '').toLowerCase().startsWith('nation');
  return !nationwide && !req.not_about_location && !!String(req.target_town ?? '').trim();
}

export async function lookupSearchData(req: SearchDataRequest, deps: SearchDataDeps): Promise<SearchDataResult> {
  const cfg = deps.config ?? searchDataConfig();
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const language_code = languageCodeFor(req.language);
  const keyword = String(req.seed_keyword ?? '').replace(/\s+/g, ' ').trim();
  const target = String(req.target_town ?? '').trim();
  const local = isLocalPost(req);

  const index = await deps.locations.get(cfg.countryIso).catch(() => null);
  const kwTown = detectTownInKeyword(keyword, index, local ? target : null);
  const targetName = local ? parseTown(target, req.state_hint).town : '';
  const mismatch =
    local && kwTown && !kwTown.isTarget ? { keyword_town: kwTown.text, target_town: targetName } : null;

  const calls: SearchDataCall[] = [];
  const run = async (scope: 'local' | 'national', kw: string, where: { location_code?: number; location_coordinate?: string; label: string }): Promise<SerpParsed | null> => {
    const t0 = now();
    if (!deps.client) {
      calls.push({ scope, keyword: kw, location: where.label, ok: false, counts: { titles: 0, questions: 0, related: 0 }, cost_usd: 0, ms: 0, error: 'not_configured' });
      return null;
    }
    const params = {
      keyword: kw,
      language_code,
      location_code: where.location_code,
      location_coordinate: where.location_coordinate,
      depth: SERP_DEPTH,
      people_also_ask_click_depth: SERP_PAA_CLICK_DEPTH,
      timeoutMs: cfg.timeoutMs,
    };
    try {
      let r;
      try {
        r = await deps.client.serpOrganicAdvanced(params);
      } catch (first) {
        // A failure reported INSIDE a 200 response (task level) is usually transient on DataForSEO's
        // side — seen in QA as a one-off task status 40101 while the account was fine — and a
        // failed task is not charged. Retry once; transport, HTTP and timeout errors are not retried.
        if ((first as { level?: string })?.level !== 'task') throw first;
        r = await deps.client.serpOrganicAdvanced(params);
      }
      const p = parseSerp(r.result);
      calls.push({ scope, keyword: kw, location: where.label, ok: true, counts: { titles: p.titles.length, questions: p.questions.length, related: p.related.length }, cost_usd: r.cost, ms: now() - t0 });
      return p;
    } catch (err) {
      const kind = (err as { kind?: string })?.kind ?? 'error';
      calls.push({ scope, keyword: kw, location: where.label, ok: false, counts: { titles: 0, questions: 0, related: 0 }, cost_usd: 0, ms: now() - t0, error: kind });
      return null;
    }
  };

  const country = { location_code: cfg.countryCode, label: cfg.countryName };
  let resolution: SearchDataMeta['town_resolution'] = { status: 'not_needed' };
  let mode: SearchDataMeta['mode'] = 'national';
  let localParsed: SerpParsed | null = null;
  let nationalParsed: SerpParsed | null = null;
  let locationUsed = cfg.countryName;
  let nationalFallback = false;

  if (local) {
    resolution = resolveTown(target, index, { stateHint: req.state_hint, aliases: cfg.townAliases, coordinate: req.town_coordinate });
    if (resolution.status === 'listed' || resolution.status === 'alias' || resolution.status === 'coordinate') {
      mode = 'local';
      const where =
        resolution.status === 'coordinate'
          ? { location_coordinate: resolution.location_coordinate, label: target }
          : { location_code: resolution.location_code, label: resolution.location_name };
      locationUsed = target;
      localParsed = await run('local', keyword, where);
      if (!localParsed || isThin(localParsed, cfg.thinThreshold)) {
        nationalFallback = true;
        nationalParsed = await run('national', stripTownFromKeyword(keyword, target), country);
      }
    } else {
      // A town DataForSEO cannot place: one country-level call with the keyword as typed (working
      // value SEARCH_DATA_UNLISTED_TOWN=national). Its items are national, never local.
      mode = 'local_unresolved';
      nationalParsed = await run('national', keyword, country);
    }
  } else {
    nationalParsed = await run('national', keyword, country);
  }

  const lt = localParsed ?? { titles: [], questions: [], related: [] };
  const nt = nationalParsed ?? { titles: [], questions: [], related: [] };
  const ranking_titles = mergeScoped(lt.titles.map((t) => t.text), nt.titles.map((t) => t.text), MERGE_CAPS.titles);
  const people_also_ask = mergeScoped(lt.questions, nt.questions, MERGE_CAPS.questions);
  const related_searches = mergeScoped(lt.related, nt.related, MERGE_CAPS.related);
  const anything = ranking_titles.length + people_also_ask.length + related_searches.length > 0;

  const block: SearchDataInput | null = anything
    ? {
        location: locationUsed,
        // The attribute says whether the nationwide call was ADDED to a local one; a post that
        // was national from the start has no fallback.
        national_fallback: nationalFallback,
        ranking_titles,
        people_also_ask,
        related_searches,
      }
    : null;

  const local_domains = [...new Set(lt.titles.map((t) => t.domain).filter(Boolean))];
  const cost_usd = Math.round(calls.reduce((s, c) => s + (c.cost_usd || 0), 0) * 1_000_000) / 1_000_000;
  const meta: SearchDataMeta = {
    mode,
    location_used: locationUsed,
    national_fallback: nationalFallback,
    town_resolution: resolution,
    keyword_town: kwTown?.text ?? null,
    town_mismatch: mismatch,
    calls,
    counts: { titles: ranking_titles.length, questions: people_also_ask.length, related: related_searches.length },
    local_domains,
    cost_usd,
    ms: now() - started,
  };

  const callPart = calls
    .map((c) => `${c.scope}=${c.ok ? `t${c.counts.titles}/q${c.counts.questions}/r${c.counts.related}` : `failed(${c.error})`}`)
    .join(' ');
  log(
    `[search-data]${runTag()} seed="${keyword}" mode=${mode} location="${locationUsed}" national_fallback=${nationalFallback ? 'yes' : 'no'} ` +
      `${callPart} merged=t${meta.counts.titles}/q${meta.counts.questions}/r${meta.counts.related}` +
      `${resolution.status !== 'not_needed' ? ` town=${resolution.status}` : ''} cost_usd=${cost_usd} ms=${meta.ms}`,
  );

  return { block, meta };
}

/** The session cache key: same keyword + place + language reuses the stored result (S9, W12). */
export function searchDataCacheKey(req: SearchDataRequest): string {
  const place = isLocalPost(req) ? `town:${String(req.target_town).trim().toLowerCase()}` : 'country';
  return `${String(req.seed_keyword ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}|${place}|${languageCodeFor(req.language)}`;
}
