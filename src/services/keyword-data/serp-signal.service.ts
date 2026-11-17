/**
 * The optional SERP check: what the first page of Google actually looks like for a keyword.
 *
 * WHY THIS IS NOT THE SPEC'S GATE
 * The original spec's fourth gate was "at least one page-1 result with domain_rank < 30".
 * Verified against the live endpoint (17 Nov 2026): `/serp/google/organic/live/advanced` returns
 * no `domain_rank` field at all. The gate as written is unimplementable from the endpoint we are
 * allowed to call, and no amount of wishing changes that.
 *
 * WHAT THE PAGE ACTUALLY TELLS US, measured on two live SERPs:
 *
 *   "leather wallets for women"  ai_overview, 6 popular_products (shopping) units, organic.
 *                                Google has decided this is a buy query. An article cannot win it.
 *                                This is also the keyword DataForSEO scored difficulty 0.
 *   "water heater repair cost"   ai_overview, 18 organic, no shopping. Five of the top ten were
 *                                Reddit and Facebook threads.
 *
 * Those are the two signals worth paying for, and both are directly observable:
 *
 *   1. SHOPPING UNITS — Google showing product carousels means it reads the query as buying
 *      intent. Writing an article against that is wasted money, whatever the difficulty score.
 *   2. USER-GENERATED RESULTS — when Reddit, Facebook and Quora threads hold half of page one,
 *      a competent article genuinely can displace them. This is the real "weak SERP" signal.
 *
 * A NOTE ON URLS. DataForSEO returns organic `url` as an obfuscated Google redirect
 * (https://google.com/goto?url=CAES...) and `domain` as "google.com" for every result, so neither
 * is usable for identifying who ranks. The real identity is in `breadcrumb` (which carries the
 * display URL) and `website_name`. extractSite() reads those, and the rank tracker depends on it
 * too, which is why it lives here rather than inside the finder.
 */
import type { DataForSeoSerpClient, DfsSerpItem } from './dataforseo.client.js';
import { normalizeKeyword } from './keyword-data.types.js';

/** Hosts whose presence on page one means a good article has room to compete. */
const UGC_HOSTS = [
  'reddit.com',
  'facebook.com',
  'quora.com',
  'youtube.com',
  'pinterest.com',
  'tiktok.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tumblr.com',
  'nextdoor.com',
];

/** The same places, as DataForSEO writes them in `website_name` ("Reddit · r/homeowners"). */
const UGC_NAMES = ['reddit', 'facebook', 'quora', 'youtube', 'pinterest', 'tiktok', 'instagram', 'twitter', 'x', 'tumblr', 'nextdoor'];

/** SERP item types that mean Google is selling, not answering. */
const SHOPPING_TYPES = ['popular_products', 'shopping', 'google_shopping', 'commercial_units', 'product_considerations'];

export interface SerpSite {
  rank: number;
  /** A host like "michaelandson.com", or a platform name like "reddit" when that is all we get. */
  site: string;
  title: string | null;
  is_ugc: boolean;
}

export interface SerpSignal {
  keyword: string;
  /** True organic results found on page one. */
  organic_count: number;
  /** Product carousels and the like. Above zero means Google reads this as a buying query. */
  shopping_units: number;
  has_ai_overview: boolean;
  /** Reddit / Facebook / Quora / YouTube results inside the top ten. */
  ugc_results: number;
  /**
   * Whether an article stands a chance here at all. False when Google is showing shopping units:
   * that is a decision about the query, not a measure of competition, and no article outranks it.
   */
  article_viable: boolean;
  /** The top ten, for display. Who actually holds the page. */
  top: SerpSite[];
}

/**
 * Who is this result, really?
 *
 * `domain` is "google.com" on every row and `url` is a /goto? redirect, so both are useless.
 * `breadcrumb` carries the display URL ("https://michaelandson.com › blog › how-much-..."), and
 * for social results it carries engagement text instead, where `website_name` has the platform.
 */
export function extractSite(item: { breadcrumb?: string | null; website_name?: string | null; domain?: string | null }): string {
  const crumb = String(item.breadcrumb ?? '').trim();
  const fromCrumb = /^https?:\/\/([^\s/›]+)/i.exec(crumb);
  if (fromCrumb) return fromCrumb[1].replace(/^www\./i, '').toLowerCase();

  const name = String(item.website_name ?? '').trim();
  if (name) {
    // "Reddit · r/homeowners" -> "reddit"; "h2oprofessionalservices.com" -> itself.
    const head = name.split('·')[0].trim().toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z]{2,})+$/i.test(head)) return head.replace(/^www\./i, '');
    return head;
  }

  const domain = String(item.domain ?? '').trim().toLowerCase();
  // Never report google.com as the ranking site; it is the redirect, not the result.
  return domain && domain !== 'google.com' ? domain.replace(/^www\./i, '') : '';
}

export function isUgcSite(site: string): boolean {
  const s = site.toLowerCase();
  return UGC_HOSTS.some((h) => s === h || s.endsWith('.' + h)) || UGC_NAMES.includes(s);
}

export interface SerpCheckDeps {
  client: DataForSeoSerpClient;
  log?: (line: string) => void;
}

export interface SerpCheckParams {
  keyword: string;
  location_code: number;
  language_code?: string;
  /** How many organic results to judge on. Page one. */
  top?: number;
}

export function createSerpSignalService(deps: SerpCheckDeps) {
  const { client, log = (l: string) => console.log(l) } = deps;

  async function check(params: SerpCheckParams): Promise<{ signal: SerpSignal; cost_usd: number }> {
    const keyword = normalizeKeyword(params.keyword);
    const top = Math.max(1, params.top ?? 10);

    const res = await client.serpOrganicAdvanced({
      keyword,
      location_code: params.location_code,
      language_code: params.language_code ?? 'en',
      // 20 so a page padded with features still yields a full ten organic results to judge.
      depth: 20,
    });

    const result = res.result?.[0];
    const items: DfsSerpItem[] = (result?.items ?? []) as DfsSerpItem[];

    let shopping = 0;
    let aiOverview = false;
    const organic: SerpSite[] = [];

    for (const item of items) {
      const type = String(item?.type ?? '');
      if (SHOPPING_TYPES.includes(type)) shopping += 1;
      if (type === 'ai_overview') aiOverview = true;
      if (type !== 'organic') continue;
      if (organic.length >= top) continue;

      const site = extractSite(item as unknown as { breadcrumb?: string; website_name?: string; domain?: string });
      organic.push({
        rank: typeof item.rank_group === 'number' ? item.rank_group : organic.length + 1,
        site,
        title: item.title ?? null,
        is_ugc: site ? isUgcSite(site) : false,
      });
    }

    const signal: SerpSignal = {
      keyword,
      organic_count: organic.length,
      shopping_units: shopping,
      has_ai_overview: aiOverview,
      ugc_results: organic.filter((o) => o.is_ugc).length,
      article_viable: shopping === 0,
      top: organic,
    };

    log(
      `[serp-check] "${keyword}" organic=${signal.organic_count} shopping=${signal.shopping_units} ` +
        `ugc=${signal.ugc_results} ai_overview=${signal.has_ai_overview} viable=${signal.article_viable} cost=${res.cost}`,
    );

    return { signal, cost_usd: res.cost };
  }

  return { check };
}
