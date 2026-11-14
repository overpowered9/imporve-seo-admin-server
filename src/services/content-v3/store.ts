/**
 * Content v3 storage — the tables behind migration 023.
 *
 * SESSIONS (content_v3_sessions). What one wizard session produced before Submit, so Regenerate
 * title / Regenerate Content / Change Image reuse it (W12, W14, S9, R8). The row is keyed by
 * (user, website, session_key): the plugin's per-wizard #iseo_target_key, or a per-task key in
 * bulk. A site can only ever reach its own rows because user and website come from plugin auth,
 * never from the request body. merge() is a JSONB `||` upsert, so each step adds its own part
 * without reading first; every write pushes expires_at out by the TTL.
 *
 * POSTS (content_v3_posts). One row per generated v3 article: blueprint picks, fingerprint,
 * headings, type, proof level, validator report (B4, B9, B12, G6, V11).
 *
 * FAILS OPEN, like the keyword data cache: a missing table or a blip logs one
 * `[content-v3] store unavailable` line and behaves as a miss / no-op. Never logs the data.
 */
import type { SqlLike } from '../keyword-data/keyword-data-cache.js';

/** The plugin mints iseo_tk_<32 hex>; bulk uses iseo_bulk_…. Anything else is rejected. */
export const SESSION_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** A session row is a cache of paid work, not an archive: refuse anything implausibly large. */
export const MAX_SESSION_BYTES = 512 * 1024;

export type SessionData = Record<string, unknown>;

export interface ContentV3PostRecord {
  user_id: number;
  website_id: number;
  session_key?: string | null;
  bulk_batch?: string | null;
  article_type?: string | null;
  post_size?: string | null;
  proof_level?: string | null;
  picks: Record<string, unknown>;
  fingerprint?: string | null;
  headings: string[];
  validator?: Record<string, unknown> | null;
}

export interface ContentV3PostRow extends ContentV3PostRecord {
  created_at: string;
}

export interface ContentV3Store {
  getSession(userId: number, websiteId: number, sessionKey: string): Promise<SessionData | null>;
  /** Shallow-merges `patch` into the session (creating it). false when skipped or failed. */
  mergeSession(userId: number, websiteId: number, sessionKey: string, patch: SessionData): Promise<boolean>;
  deleteSession(userId: number, websiteId: number, sessionKey: string): Promise<boolean>;
  recordPost(rec: ContentV3PostRecord): Promise<boolean>;
  /** Leave (W10): the post history row of an unsubmitted wizard session goes with it. */
  deletePosts(userId: number, websiteId: number, sessionKey: string): Promise<boolean>;
  /** The site's newest posts first. */
  recentPosts(userId: number, websiteId: number, limit: number): Promise<ContentV3PostRow[]>;
  /** Deletes expired sessions and post rows older than the post retention. Returns rows removed. */
  purge(): Promise<number>;
}

export interface ContentV3StoreDeps {
  sql: SqlLike;
  ttlDays: number;
  postRetentionDays?: number;
  log?: (line: string) => void;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

export function createContentV3Store(deps: ContentV3StoreDeps): ContentV3Store {
  const { sql, ttlDays, postRetentionDays = 365, log = (line) => console.warn(line) } = deps;
  const unavailable = (op: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[content-v3] store unavailable (${op}): ${msg.slice(0, 200)}`);
  };
  const validKey = (k: string) => typeof k === 'string' && SESSION_KEY_RE.test(k);
  const validIds = (u: number, w: number) => Number.isInteger(u) && u > 0 && Number.isInteger(w) && w > 0;

  return {
    async getSession(userId, websiteId, sessionKey) {
      if (!validIds(userId, websiteId) || !validKey(sessionKey)) return null;
      try {
        const rows = await sql`
          SELECT data FROM content_v3_sessions
          WHERE user_id = ${userId} AND website_id = ${websiteId} AND session_key = ${sessionKey}
            AND expires_at > NOW()
          LIMIT 1
        `;
        if (!rows.length) return null;
        const data = parseJson<SessionData>(rows[0].data, {});
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
      } catch (err) {
        unavailable('getSession', err);
        return null;
      }
    },

    async mergeSession(userId, websiteId, sessionKey, patch) {
      if (!validIds(userId, websiteId) || !validKey(sessionKey)) return false;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
      const json = JSON.stringify(patch);
      if (Buffer.byteLength(json, 'utf8') > MAX_SESSION_BYTES) {
        log(`[content-v3] session patch skipped: ${Buffer.byteLength(json, 'utf8')} bytes over the ${MAX_SESSION_BYTES} limit`);
        return false;
      }
      try {
        await sql`
          INSERT INTO content_v3_sessions (user_id, website_id, session_key, data, expires_at)
          VALUES (${userId}, ${websiteId}, ${sessionKey}, ${json}::text::jsonb, NOW() + make_interval(days => ${ttlDays}))
          ON CONFLICT (user_id, website_id, session_key) DO UPDATE SET
            data = CASE WHEN content_v3_sessions.expires_at > NOW()
                        THEN content_v3_sessions.data || EXCLUDED.data
                        ELSE EXCLUDED.data END,
            updated_at = NOW(),
            expires_at = EXCLUDED.expires_at
        `;
        return true;
      } catch (err) {
        unavailable('mergeSession', err);
        return false;
      }
    },

    async deleteSession(userId, websiteId, sessionKey) {
      if (!validIds(userId, websiteId) || !validKey(sessionKey)) return false;
      try {
        await sql`
          DELETE FROM content_v3_sessions
          WHERE user_id = ${userId} AND website_id = ${websiteId} AND session_key = ${sessionKey}
        `;
        return true;
      } catch (err) {
        unavailable('deleteSession', err);
        return false;
      }
    },

    async deletePosts(userId, websiteId, sessionKey) {
      if (!validIds(userId, websiteId) || !validKey(sessionKey)) return false;
      try {
        await sql`
          DELETE FROM content_v3_posts
          WHERE user_id = ${userId} AND website_id = ${websiteId} AND session_key = ${sessionKey}
        `;
        return true;
      } catch (err) {
        unavailable('deletePosts', err);
        return false;
      }
    },

    async recordPost(rec) {
      if (!validIds(rec.user_id, rec.website_id)) return false;
      try {
        // C9: one row per post; a regeneration of the same wizard session replaces its row.
        if (rec.session_key) {
          await sql`
            DELETE FROM content_v3_posts
            WHERE user_id = ${rec.user_id} AND website_id = ${rec.website_id} AND session_key = ${rec.session_key}
          `;
        }
        await sql`
          INSERT INTO content_v3_posts
            (user_id, website_id, session_key, bulk_batch, article_type, post_size, proof_level, picks, fingerprint, headings, validator)
          VALUES (
            ${rec.user_id}, ${rec.website_id}, ${rec.session_key ?? null}, ${rec.bulk_batch ?? null},
            ${rec.article_type ?? null}, ${rec.post_size ?? null}, ${rec.proof_level ?? null},
            ${JSON.stringify(rec.picks ?? {})}::text::jsonb, ${rec.fingerprint ?? null},
            ${JSON.stringify(rec.headings ?? [])}::text::jsonb,
            ${rec.validator ? JSON.stringify(rec.validator) : null}::text::jsonb
          )
        `;
        return true;
      } catch (err) {
        unavailable('recordPost', err);
        return false;
      }
    },

    async recentPosts(userId, websiteId, limit) {
      if (!validIds(userId, websiteId)) return [];
      const n = Math.max(1, Math.min(100, Math.round(limit)));
      try {
        const rows = await sql`
          SELECT user_id, website_id, session_key, bulk_batch, article_type, post_size, proof_level,
                 picks, fingerprint, headings, validator, created_at
          FROM content_v3_posts
          WHERE user_id = ${userId} AND website_id = ${websiteId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${n}
        `;
        return rows.map((r) => ({
          user_id: Number(r.user_id),
          website_id: Number(r.website_id),
          session_key: r.session_key ?? null,
          bulk_batch: r.bulk_batch ?? null,
          article_type: r.article_type ?? null,
          post_size: r.post_size ?? null,
          proof_level: r.proof_level ?? null,
          picks: parseJson<Record<string, unknown>>(r.picks, {}),
          fingerprint: r.fingerprint ?? null,
          headings: parseJson<string[]>(r.headings, []),
          validator: parseJson<Record<string, unknown> | null>(r.validator, null),
          created_at: toIso(r.created_at),
        }));
      } catch (err) {
        unavailable('recentPosts', err);
        return [];
      }
    },

    async purge() {
      let removed = 0;
      try {
        const a = await sql`DELETE FROM content_v3_sessions WHERE expires_at <= NOW() RETURNING 1`;
        removed += a.length;
        const b = await sql`
          DELETE FROM content_v3_posts WHERE created_at < NOW() - make_interval(days => ${postRetentionDays}) RETURNING 1
        `;
        removed += b.length;
      } catch (err) {
        unavailable('purge', err);
      }
      return removed;
    },
  };
}

/** In-memory store for tests and for running without a database. Same semantics, no TTL clock. */
export function createMemoryContentV3Store(): ContentV3Store & { sessions: Map<string, SessionData>; posts: ContentV3PostRow[] } {
  const sessions = new Map<string, SessionData>();
  const posts: ContentV3PostRow[] = [];
  const k = (u: number, w: number, s: string) => `${u}:${w}:${s}`;
  return {
    sessions,
    posts,
    async getSession(u, w, s) {
      return SESSION_KEY_RE.test(s) ? structuredClone(sessions.get(k(u, w, s)) ?? null) : null;
    },
    async mergeSession(u, w, s, patch) {
      if (!SESSION_KEY_RE.test(s)) return false;
      sessions.set(k(u, w, s), { ...(sessions.get(k(u, w, s)) ?? {}), ...structuredClone(patch) });
      return true;
    },
    async deleteSession(u, w, s) {
      sessions.delete(k(u, w, s));
      return true;
    },
    async deletePosts(u, w, s) {
      for (let i = posts.length - 1; i >= 0; i--) {
        if (posts[i].user_id === u && posts[i].website_id === w && posts[i].session_key === s) posts.splice(i, 1);
      }
      return true;
    },
    async recordPost(rec) {
      // C9: one row per post; a regeneration of the same wizard session replaces it.
      if (rec.session_key) {
        for (let i = posts.length - 1; i >= 0; i--) {
          if (posts[i].user_id === rec.user_id && posts[i].website_id === rec.website_id && posts[i].session_key === rec.session_key) posts.splice(i, 1);
        }
      }
      posts.unshift({ ...structuredClone(rec), created_at: new Date().toISOString() });
      return true;
    },
    async recentPosts(u, w, limit) {
      return posts.filter((p) => p.user_id === u && p.website_id === w).slice(0, limit).map((p) => structuredClone(p));
    },
    async purge() {
      return 0;
    },
  };
}
