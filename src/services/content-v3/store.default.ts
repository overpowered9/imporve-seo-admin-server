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
 * B-3: every 10 minutes, retry refunds that failed (refund_pending); once a day, purge run rows
 * older than 90 days and daily counters (B-5) older than 30. Started by the routes only while CONTENT_V3_ENABLED is on; unref'd, so it
 * never keeps the process alive.
 */
export function startRunsHousekeeping(refund: (userId: number, cost: number, reason: string, websiteId?: number) => Promise<void>): void {
  if (refundTimer) return;
  let lastRunsPurge = 0;
  refundTimer = setInterval(() => {
    void (async () => {
      const r = await getContentV3Runs();
      await retryPendingRefunds(r, refund);
      if (Date.now() - lastRunsPurge > 24 * 60 * 60 * 1000) {
        lastRunsPurge = Date.now();
        const n = await r.purge(90).catch(() => 0);
        if (n > 0) console.log(`[content-v3] purged ${n} run ledger rows older than 90 days`);
        const q = await (await getContentV3Quota()).purge(30).catch(() => 0);
        if (q > 0) console.log(`[content-v3] purged ${q} daily counter rows older than 30 days`);
      }
    })().catch((err) => console.log(`[content-v3] runs housekeeping failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 10 * 60 * 1000);
  refundTimer.unref?.();
}
