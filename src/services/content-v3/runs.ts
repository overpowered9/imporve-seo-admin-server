/**
 * Content v3 run ledger (B-3, migration 024): one row per article request, so credits are charged
 * exactly once even across server instances, a lost response can be replayed, and a failed refund
 * is retried instead of only logged.
 *
 *   claim      before any charge. The row is unique per (user, request_id) and at most one row per
 *              (user, session) may be `running` (a partial unique index), so:
 *                - a new request_id                      → claimed (running)
 *                - the same request_id, already finished → replay: the stored response, no charge
 *                - the same request_id, failed/refunded  → claimed again (a retry of that click)
 *                - another run of this session running   → busy (409)
 *              A `running` row older than `stale_after_ms` (its process died) is closed first:
 *              refund_pending when it had been charged, failed otherwise.
 *   charged    after the reserve succeeded (cost, action, variant).
 *   succeeded  with the generation id, the response sent, step costs and timings (the admin trail).
 *   failed     with the error; refund_pending when the refund itself failed.
 *   takePendingRefunds / refundDone   the retry loop (refund_pending → refunding → refunded, or back).
 *
 * The plugin sends `request_id` per click and keeps it until an article reaches the browser, so a
 * retry after a timeout replays the finished article instead of buying it twice.
 */
import type { SqlLike } from '../keyword-data/keyword-data-cache.js';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'refund_pending' | 'refunding' | 'refunded';

export interface RunRow {
  id: number;
  user_id: number;
  website_id: number | null;
  session_key: string;
  request_id: string;
  status: RunStatus;
  cost: number;
  action: string | null;
  variant: string | null;
  generation_id: number | null;
  response: unknown;
  step_costs: Record<string, number>;
  timings: Record<string, number>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type ClaimResult = { kind: 'claimed'; id: number } | { kind: 'replay'; id: number; response: unknown } | { kind: 'busy' };

export interface ClaimInput {
  user_id: number;
  website_id: number | null;
  session_key: string;
  request_id: string;
  stale_after_ms: number;
}

export interface RunsStore {
  claim(p: ClaimInput): Promise<ClaimResult>;
  charged(id: number, p: { cost: number; action: string; variant: string }): Promise<void>;
  succeeded(id: number, p: { generation_id: number | null; response: unknown; step_costs: Record<string, number>; timings: Record<string, number> }): Promise<void>;
  failed(id: number, p: { error: string; refund_pending: boolean }): Promise<void>;
  /** Moves up to `limit` refund_pending rows to `refunding` and returns them. */
  takePendingRefunds(limit: number): Promise<RunRow[]>;
  /** ok: refunding → refunded; not ok: back to refund_pending for the next pass. */
  refundDone(id: number, ok: boolean): Promise<void>;
  /** Every run of one session key, newest first (admin trail). */
  bySession(session_key: string, limit?: number): Promise<RunRow[]>;
  /** Deletes runs older than this many days; returns how many. */
  purge(olderThanDays: number): Promise<number>;
}

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;

// ------------------------------------------------------------------ memory (tests, local dev)

export function createMemoryRunsStore(now: () => number = () => Date.now()): RunsStore & { rows: RunRow[] } {
  const rows: RunRow[] = [];
  let next = 1;
  const iso = () => new Date(now()).toISOString();
  const touch = (r: RunRow, patch: Partial<RunRow>) => Object.assign(r, patch, { updated_at: iso() });
  const runningFor = (u: number, s: string) => rows.find((r) => r.user_id === u && r.session_key === s && r.status === 'running');
  return {
    rows,
    async claim(p) {
      for (const r of rows) {
        if (r.user_id === p.user_id && r.session_key === p.session_key && r.status === 'running' && now() - Date.parse(r.updated_at) > p.stale_after_ms) {
          touch(r, { status: r.cost > 0 ? 'refund_pending' : 'failed', error: 'stale: no answer before the deadline' });
        }
      }
      const same = rows.find((r) => r.user_id === p.user_id && r.request_id === p.request_id);
      if (same) {
        if (same.status === 'succeeded') return { kind: 'replay', id: same.id, response: structuredClone(same.response) };
        if ((same.status === 'failed' || same.status === 'refunded') && !runningFor(p.user_id, p.session_key)) {
          touch(same, { status: 'running', error: null, cost: 0, action: null, variant: null });
          return { kind: 'claimed', id: same.id };
        }
        return { kind: 'busy' };
      }
      if (runningFor(p.user_id, p.session_key)) return { kind: 'busy' };
      const row: RunRow = {
        id: next++,
        user_id: p.user_id,
        website_id: p.website_id,
        session_key: p.session_key,
        request_id: p.request_id,
        status: 'running',
        cost: 0,
        action: null,
        variant: null,
        generation_id: null,
        response: null,
        step_costs: {},
        timings: {},
        error: null,
        created_at: iso(),
        updated_at: iso(),
      };
      rows.push(row);
      return { kind: 'claimed', id: row.id };
    },
    async charged(id, p) {
      const r = rows.find((x) => x.id === id);
      if (r) touch(r, { cost: p.cost, action: p.action, variant: p.variant });
    },
    async succeeded(id, p) {
      const r = rows.find((x) => x.id === id);
      if (r) touch(r, { status: 'succeeded', generation_id: p.generation_id, response: structuredClone(p.response), step_costs: { ...p.step_costs }, timings: { ...p.timings } });
    },
    async failed(id, p) {
      const r = rows.find((x) => x.id === id);
      if (r) touch(r, { status: p.refund_pending ? 'refund_pending' : r.cost > 0 ? 'refunded' : 'failed', error: p.error.slice(0, 500) });
    },
    async takePendingRefunds(limit) {
      const out = rows.filter((r) => r.status === 'refund_pending').slice(0, limit);
      for (const r of out) touch(r, { status: 'refunding' });
      return out.map((r) => structuredClone(r));
    },
    async refundDone(id, ok) {
      const r = rows.find((x) => x.id === id);
      if (r && r.status === 'refunding') touch(r, { status: ok ? 'refunded' : 'refund_pending' });
    },
    async bySession(session_key, limit = 20) {
      return rows.filter((r) => r.session_key === session_key).slice().reverse().slice(0, limit).map((r) => structuredClone(r));
    },
    async purge(olderThanDays) {
      const cutoff = now() - olderThanDays * 86_400_000;
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (Date.parse(rows[i].created_at) < cutoff && rows[i].status !== 'running' && rows[i].status !== 'refund_pending' && rows[i].status !== 'refunding') {
          rows.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}

// ------------------------------------------------------------------ Postgres (migration 024)

const UNIQUE_VIOLATION = '23505';

function toRow(r: Record<string, unknown>): RunRow {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    website_id: r.website_id === null || r.website_id === undefined ? null : Number(r.website_id),
    session_key: String(r.session_key),
    request_id: String(r.request_id),
    status: r.status as RunStatus,
    cost: Number(r.cost ?? 0),
    action: (r.action as string | null) ?? null,
    variant: (r.variant as string | null) ?? null,
    generation_id: r.generation_id === null || r.generation_id === undefined ? null : Number(r.generation_id),
    response: r.response ?? null,
    step_costs: (r.step_costs as Record<string, number>) ?? {},
    timings: (r.timings as Record<string, number>) ?? {},
    error: (r.error as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function createPostgresRunsStore(sql: SqlLike): RunsStore {
  return {
    async claim(p) {
      const staleSeconds = Math.max(1, Math.round(p.stale_after_ms / 1000));
      await sql`
        UPDATE content_v3_runs
           SET status = CASE WHEN cost > 0 THEN 'refund_pending' ELSE 'failed' END,
               error = 'stale: no answer before the deadline', updated_at = NOW()
         WHERE user_id = ${p.user_id} AND session_key = ${p.session_key} AND status = 'running'
           AND updated_at < NOW() - make_interval(secs => ${staleSeconds})
      `;
      const inserted = await sql`
        INSERT INTO content_v3_runs (user_id, website_id, session_key, request_id, status)
        VALUES (${p.user_id}, ${p.website_id}, ${p.session_key}, ${p.request_id}, 'running')
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (inserted[0]?.id !== undefined) return { kind: 'claimed', id: Number(inserted[0].id) };

      const same = await sql`SELECT id, status, response FROM content_v3_runs WHERE user_id = ${p.user_id} AND request_id = ${p.request_id}`;
      const row = same[0];
      if (!row) return { kind: 'busy' }; // another run of this session is running
      if (row.status === 'succeeded') return { kind: 'replay', id: Number(row.id), response: row.response };
      if (row.status === 'failed' || row.status === 'refunded') {
        try {
          const again = await sql`
            UPDATE content_v3_runs SET status = 'running', error = NULL, cost = 0, action = NULL, variant = NULL, updated_at = NOW()
             WHERE id = ${row.id} AND status IN ('failed', 'refunded')
            RETURNING id
          `;
          if (again[0]?.id !== undefined) return { kind: 'claimed', id: Number(again[0].id) };
        } catch (err) {
          if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
        }
      }
      return { kind: 'busy' };
    },
    async charged(id, p) {
      await sql`UPDATE content_v3_runs SET cost = ${p.cost}, action = ${p.action}, variant = ${p.variant}, updated_at = NOW() WHERE id = ${id}`;
    },
    async succeeded(id, p) {
      await sql`
        UPDATE content_v3_runs
           SET status = 'succeeded', generation_id = ${p.generation_id}, response = ${JSON.stringify(p.response)}::jsonb,
               step_costs = ${JSON.stringify(p.step_costs)}::jsonb, timings = ${JSON.stringify(p.timings)}::jsonb, updated_at = NOW()
         WHERE id = ${id}
      `;
    },
    async failed(id, p) {
      await sql`
        UPDATE content_v3_runs
           SET status = CASE WHEN ${p.refund_pending} THEN 'refund_pending' WHEN cost > 0 THEN 'refunded' ELSE 'failed' END,
               error = ${p.error.slice(0, 500)}, updated_at = NOW()
         WHERE id = ${id}
      `;
    },
    async takePendingRefunds(limit) {
      const rows = await sql`
        UPDATE content_v3_runs SET status = 'refunding', updated_at = NOW()
         WHERE id IN (SELECT id FROM content_v3_runs WHERE status = 'refund_pending' ORDER BY updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING *
      `;
      return rows.map(toRow);
    },
    async refundDone(id, ok) {
      await sql`UPDATE content_v3_runs SET status = ${ok ? 'refunded' : 'refund_pending'}, updated_at = NOW() WHERE id = ${id} AND status = 'refunding'`;
    },
    async bySession(session_key, limit = 20) {
      const rows = await sql`SELECT * FROM content_v3_runs WHERE session_key = ${session_key} ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map(toRow);
    },
    async purge(olderThanDays) {
      const rows = await sql`
        DELETE FROM content_v3_runs
         WHERE created_at < NOW() - make_interval(days => ${olderThanDays})
           AND status NOT IN ('running', 'refund_pending', 'refunding')
        RETURNING 1
      `;
      return rows.length;
    },
  };
}

/**
 * The refund retry loop (B-3): every refund_pending row is refunded again; success marks it
 * refunded, failure puts it back. Never throws; each failure is logged with the user and amount.
 */
export async function retryPendingRefunds(
  runs: RunsStore,
  refund: (userId: number, cost: number, reason: string, websiteId?: number) => Promise<void>,
  log: (line: string) => void = (l) => console.log(l),
  limit = 20,
): Promise<{ refunded: number; failed: number }> {
  let refunded = 0;
  let failed = 0;
  let rows: RunRow[] = [];
  try {
    rows = await runs.takePendingRefunds(limit);
  } catch (err) {
    log(`[content-v3] refund retry: ledger unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { refunded, failed };
  }
  for (const r of rows) {
    try {
      await refund(r.user_id, r.cost, `Refund (retried) — content v3 generation failed: run ${r.id}`, r.website_id ?? undefined);
      await runs.refundDone(r.id, true);
      refunded++;
      log(`[content-v3] refund retried ok run=${r.session_key} id=${r.id} user=${r.user_id} amount=${r.cost}`);
    } catch (err) {
      await runs.refundDone(r.id, false).catch(() => {});
      failed++;
      log(`[content-v3] REFUND FAILED (will retry) id=${r.id} user=${r.user_id} amount=${r.cost}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { refunded, failed };
}
