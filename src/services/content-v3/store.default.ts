/**
 * Live wiring for the Content v3 store: the shared Postgres connection, the TTL from
 * config/content-v3.config.ts, and a lazy purge of expired rows at most once an hour (triggered by
 * session writes, so a server that never runs v3 never touches the tables).
 */
import { contentV3Config } from '../../config/content-v3.config.js';
import type { SqlLike } from '../keyword-data/keyword-data-cache.js';
import { createContentV3Store, createMemoryContentV3Store, type ContentV3Store } from './store.js';
import { createMemoryRunsStore, createPostgresRunsStore, retryPendingRefunds, type RunsStore } from './runs.js';
import { createMemoryQuotaStore, createPostgresQuotaStore, type QuotaStore } from './quota.js';

const PURGE_EVERY_MS = 60 * 60 * 1000;

let store: ContentV3Store | null = null;
let lastPurge = 0;

export async function getContentV3Store(): Promise<ContentV3Store> {
  if (store) return store;
  // Local development only: CONTENT_V3_STORE=memory keeps sessions and post history in this
  // process (lost on restart), so the wizard can be exercised against a database where migration
  // 023 has not been applied. Never set it on Render: a restart would drop every open session.
  if (process.env.CONTENT_V3_STORE === 'memory') {
    console.warn('⚠️ [content-v3] CONTENT_V3_STORE=memory — sessions live in this process only (local development).');
    store = createMemoryContentV3Store();
    return store;
  }
  const { default: sql } = await import('../../data/db.js');
  const inner = createContentV3Store({ sql: sql as unknown as SqlLike, ttlDays: contentV3Config().sessionTtlDays });
  store = {
    ...inner,
    async mergeSession(u, w, k, patch) {
      const ok = await inner.mergeSession(u, w, k, patch);
      const now = Date.now();
      if (now - lastPurge > PURGE_EVERY_MS) {
        lastPurge = now;
        void inner.purge().then((n) => {
          if (n > 0) console.log(`[content-v3] purged ${n} expired session/post rows`);
        });
      }
      return ok;
    },
  };
  return store;
}

/** Tests replace the live store. */
export function setContentV3StoreForTests(s: ContentV3Store | null): void {
  store = s;
}

let runs: RunsStore | null = null;

/** B-3: the run ledger (migration 024); in-process for CONTENT_V3_STORE=memory (local only). */
export async function getContentV3Runs(): Promise<RunsStore> {
  if (runs) return runs;
  if (process.env.CONTENT_V3_STORE === 'memory') {
    runs = createMemoryRunsStore();
    return runs;
  }
  const { default: sql } = await import('../../data/db.js');
  runs = createPostgresRunsStore(sql as unknown as SqlLike);
  return runs;
}

let quota: QuotaStore | null = null;

/** B-5: the daily counters (migration 024); in-process for CONTENT_V3_STORE=memory (local only). */
export async function getContentV3Quota(): Promise<QuotaStore> {
  if (quota) return quota;
  if (process.env.CONTENT_V3_STORE === 'memory') {
    quota = createMemoryQuotaStore();
    return quota;
  }
  const { default: sql } = await import('../../data/db.js');
  quota = createPostgresQuotaStore(sql as unknown as SqlLike);
  return quota;
}

let refundTimer: ReturnType<typeof setInterval> | null = null;

/**
 * B-3 / H2: the run ledger's housekeeping. Runs on every instance whether v3 is on or not, so
 * charges left behind by a stopped process are refunded even after v3 is switched off:
 *   - every 10 minutes (and once a minute after boot): running rows untouched for longer than
 *     the article deadline plus grace belong to a process that died (a deploy, a crash), so they
 *     are swept (charged → refund_pending, else failed); then refund_pending rows are refunded;
 *   - once a day: run rows older than 90 days and daily counters (B-5) older than 30 are purged,
 *     and rows stuck in `refunding` for over an hour are reported (their refund may or may not
 *     have gone through, so a person checks the credit ledger instead of the code guessing).
 * Without the table (migration 024 not applied) it logs once and stays idle. Timers are unref'd.
 */
export function startRunsHousekeeping(
  refund: (userId: number, cost: number, reason: string, websiteId?: number) => Promise<void>,
  opts: { staleAfterMs: number; log?: (line: string) => void },
): void {
  if (refundTimer) return;
  const log = opts.log ?? ((l: string) => console.log(l));
  let lastDaily = 0;
  let warned = false;
  const tick = async () => {
    const r = await getContentV3Runs();
    let swept = 0;
    try {
      swept = await r.sweepStale(opts.staleAfterMs);
    } catch (err) {
      if (!warned) {
        warned = true;
        log(`[content-v3] runs ledger unavailable — housekeeping idle until it is: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
      return;
    }
    warned = false;
    if (swept > 0) log(`[content-v3] swept ${swept} run(s) whose process stopped before answering (charged ones are refunded next)`);
    await retryPendingRefunds(r, refund, log);
    if (Date.now() - lastDaily > 24 * 60 * 60 * 1000) {
      lastDaily = Date.now();
      const n = await r.purge(90).catch(() => 0);
      if (n > 0) log(`[content-v3] purged ${n} run ledger rows older than 90 days`);
      const q = await (await getContentV3Quota()).purge(30).catch(() => 0);
      if (q > 0) log(`[content-v3] purged ${q} daily counter rows older than 30 days`);
      for (const s of await r.stuckRefunding(60 * 60 * 1000).catch(() => [])) {
        log(
          `[content-v3] REFUND STATE UNKNOWN run=${s.session_key} id=${s.id} user=${s.user_id} amount=${s.cost} — ` +
            'check the credit ledger, then set the row to refunded (credits returned) or refund_pending (not returned)',
        );
      }
    }
  };
  const run = () => void tick().catch((err) => log(`[content-v3] runs housekeeping failed: ${err instanceof Error ? err.message : String(err)}`));
  setTimeout(run, 60 * 1000).unref?.();
  refundTimer = setInterval(run, 10 * 60 * 1000);
  refundTimer.unref?.();
}
