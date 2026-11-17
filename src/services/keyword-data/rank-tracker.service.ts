/**
 * Rank tracker: did the keyword we recommended actually rank?
 *
 * The Keyword Finder's promise is "write this and you can rank". This is the only part of the
 * system that ever checks. One target is one keyword watched for one domain in one place; the
 * history is every position we have seen, because a position on its own says nothing — "14" only
 * means something next to "it was 31 a month ago".
 *
 * FINDING THE SITE IS THE HARD PART, AND IT IS NOT OBVIOUS.
 * DataForSEO returns every organic `url` as an obfuscated google.com/goto redirect and every
 * `domain` as "google.com" (verified live, 17 Nov 2026). Matching on either would silently report
 * "not ranking" for every site on earth, forever, and look like it was working. The real identity
 * is in `breadcrumb` and `website_name`, which is what extractSite() reads — shared with the SERP
 * check so the two can never drift apart.
 *
 * A position of null means "not found in the results we looked at". That is deliberately not the
 * same as a bad position, and it is never stored as 100 or 0.
 */
import sql from '../../data/db.js';
import { normalizeKeyword } from './keyword-data.types.js';
import { extractSite, type SerpSignal } from './serp-signal.service.js';

/** How deep we look before calling it "not ranking". Two pages. */
export const RANK_CHECK_DEPTH = 20;

export interface RankTarget {
  id: number;
  domain: string;
  keyword: string;
  location_code: number;
  language_code: string;
  label: string | null;
  active: boolean;
  created_at: string;
  last_checked_at: string | null;
}

export interface RankCheckResult {
  target_id: number;
  position: number | null;
  ranking_url: string | null;
  checked_at: string;
  cost_usd: number;
}

export interface RankRow extends RankTarget {
  position: number | null;
  previous_position: number | null;
  /** Negative is an improvement: position 8 from 14 is -6. Null when there is nothing to compare. */
  change: number | null;
  checked_at: string | null;
}

/**
 * Normalise a domain the way we will compare it: no scheme, no www, no path, lower case.
 * "https://www.Example.com/blog" and "example.com" must be the same target.
 */
export function normalizeDomain(raw: unknown): string {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0];
  s = s.split('?')[0];
  s = s.replace(/^www\./, '');
  return s;
}

/** Does this result belong to the tracked site? Subdomains count; look-alikes do not. */
export function siteMatchesDomain(site: string, domain: string): boolean {
  const s = normalizeDomain(site);
  const d = normalizeDomain(domain);
  if (!s || !d) return false;
  return s === d || s.endsWith('.' + d);
}

/**
 * Where does `domain` sit in this SERP?
 *
 * Takes the already-fetched signal rather than making its own call, so one SERP response can
 * serve both the finder's verdict and a rank check without paying twice.
 */
export function findPosition(signal: SerpSignal, domain: string): { position: number | null; site: string | null } {
  for (const row of signal.top) {
    if (row.site && siteMatchesDomain(row.site, domain)) {
      return { position: row.rank, site: row.site };
    }
  }
  return { position: null, site: null };
}

export interface RankTrackerDeps {
  serp: { check: (p: { keyword: string; location_code: number; language_code?: string; top?: number }) => Promise<{ signal: SerpSignal; cost_usd: number }> };
  db?: typeof sql;
  log?: (line: string) => void;
  now?: () => Date;
}

export function createRankTracker(deps: RankTrackerDeps) {
  const { serp, db = sql, log = (l: string) => console.log(l), now = () => new Date() } = deps;

  async function addTarget(input: { domain: string; keyword: string; location_code?: number; language_code?: string; label?: string | null }): Promise<RankTarget> {
    const domain = normalizeDomain(input.domain);
    const keyword = normalizeKeyword(input.keyword);
    if (!domain) throw new Error('domain is required');
    if (!keyword) throw new Error('keyword is required');

    const rows = await db<RankTarget[]>`
      INSERT INTO keyword_rank_targets (domain, keyword, location_code, language_code, label)
      VALUES (${domain}, ${keyword}, ${input.location_code ?? 2840}, ${input.language_code ?? 'en'}, ${input.label ?? null})
      ON CONFLICT (domain, keyword, location_code, language_code)
      DO UPDATE SET active = TRUE, label = COALESCE(EXCLUDED.label, keyword_rank_targets.label)
      RETURNING *
    `;
    return rows[0];
  }

  async function removeTarget(id: number): Promise<void> {
    await db`DELETE FROM keyword_rank_targets WHERE id = ${id}`;
  }

  /**
   * Every target with its latest position and the one before it.
   *
   * The two LATERALs are what make a change column possible at all: the newest check and the one
   * before it, per target, without pulling the whole history into the server.
   */
  async function listTargets(): Promise<RankRow[]> {
    const rows = await db<RankRow[]>`
      SELECT t.*,
             latest.position        AS position,
             latest.checked_at      AS checked_at,
             prev.position          AS previous_position,
             CASE WHEN latest.position IS NOT NULL AND prev.position IS NOT NULL
                  THEN latest.position - prev.position END AS change
      FROM keyword_rank_targets t
      LEFT JOIN LATERAL (
        SELECT h.position, h.checked_at FROM keyword_rank_history h
        WHERE h.target_id = t.id ORDER BY h.checked_at DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT h.position FROM keyword_rank_history h
        WHERE h.target_id = t.id ORDER BY h.checked_at DESC OFFSET 1 LIMIT 1
      ) prev ON TRUE
      ORDER BY t.domain, t.keyword
    `;
    return rows;
  }

  async function history(targetId: number, limit = 90) {
    return db`
      SELECT checked_at, position, ranking_url
      FROM keyword_rank_history
      WHERE target_id = ${targetId}
      ORDER BY checked_at DESC
      LIMIT ${limit}
    `;
  }

  /** One paid SERP call. Writes a history row whether or not the site was found. */
  async function checkTarget(target: RankTarget): Promise<RankCheckResult> {
    const { signal, cost_usd } = await serp.check({
      keyword: target.keyword,
      location_code: target.location_code,
      language_code: target.language_code,
      top: RANK_CHECK_DEPTH,
    });

    const { position, site } = findPosition(signal, target.domain);
    const checkedAt = now();

    await db`
      INSERT INTO keyword_rank_history
        (target_id, checked_at, position, ranking_url, serp_organic_count, shopping_units, ugc_results, cost_usd)
      VALUES (${target.id}, ${checkedAt}, ${position}, ${site}, ${signal.organic_count},
              ${signal.shopping_units}, ${signal.ugc_results}, ${cost_usd})
    `;
    await db`UPDATE keyword_rank_targets SET last_checked_at = ${checkedAt} WHERE id = ${target.id}`;

    log(
      `[rank-tracker] "${target.keyword}" for ${target.domain}: ` +
        (position === null ? 'not found in the top ' + RANK_CHECK_DEPTH : 'position ' + position) +
        ` cost=${cost_usd}`,
    );

    return { target_id: target.id, position, ranking_url: site, checked_at: checkedAt.toISOString(), cost_usd };
  }

  async function checkById(id: number): Promise<RankCheckResult> {
    const rows = await db<RankTarget[]>`SELECT * FROM keyword_rank_targets WHERE id = ${id}`;
    if (!rows[0]) throw new Error(`no rank target with id ${id}`);
    return checkTarget(rows[0]);
  }

  /**
   * Every active target not checked within `staleHours`, oldest first, capped.
   *
   * The cap is the cost control: a scheduler tick can never spend more than `max` SERP calls,
   * however many targets accumulate, and whatever it misses it picks up on the next tick.
   */
  async function runDue(opts: { staleHours?: number; max?: number } = {}): Promise<{ checked: number; cost_usd: number }> {
    const staleHours = opts.staleHours ?? 24 * 7;
    const max = opts.max ?? 50;

    const due = await db<RankTarget[]>`
      SELECT * FROM keyword_rank_targets
      WHERE active = TRUE
        AND (last_checked_at IS NULL OR last_checked_at < NOW() - (${staleHours} || ' hours')::interval)
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT ${max}
    `;

    let cost = 0;
    let checked = 0;
    for (const target of due) {
      try {
        const r = await checkTarget(target);
        cost += r.cost_usd;
        checked += 1;
      } catch (err) {
        // One bad target must not stop the run; it will be due again next tick.
        log(`[rank-tracker] check failed for target ${target.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (due.length) log(`[rank-tracker] run complete: ${checked}/${due.length} checked, cost_usd=${cost.toFixed(4)}`);
    return { checked, cost_usd: Number(cost.toFixed(6)) };
  }

  return { addTarget, removeTarget, listTargets, history, checkTarget, checkById, runDue };
}
