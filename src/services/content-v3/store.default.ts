/**
 * Live wiring for the Content v3 store: the shared Postgres connection, the TTL from
 * config/content-v3.config.ts, and a lazy purge of expired rows at most once an hour (triggered by
 * session writes, so a server that never runs v3 never touches the tables).
 */
import { contentV3Config } from '../../config/content-v3.config.js';
import type { SqlLike } from '../keyword-data/keyword-data-cache.js';
import { createContentV3Store, createMemoryContentV3Store, type ContentV3Store } from './store.js';

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
