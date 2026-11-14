/**
 * D: the wizard session key ("run") of the request being served, carried through its async calls
 * (AsyncLocalStorage), so shared clients (DataForSEO, search data, keyword data) can put
 * `run=<key>` on their log lines without the id being threaded through every call.
 *
 *   router.use(runContext)           sets it from body.session_key (only a valid key)
 *   runTag()                         " run=<key>" inside a run, "" outside
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

const als = new AsyncLocalStorage<string>();
const RUN_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function runWith<T>(runId: string | null | undefined, fn: () => T): T {
  return runId && RUN_RE.test(runId) ? als.run(runId, fn) : fn();
}

export function currentRun(): string | undefined {
  return als.getStore();
}

export function runTag(): string {
  const r = als.getStore();
  return r ? ` run=${r}` : '';
}

/** Express: the rest of this request runs inside its wizard session key, when the body has one. */
export const runContext: RequestHandler = (req, _res, next) => {
  const key = typeof req.body?.session_key === 'string' ? req.body.session_key.trim() : null;
  runWith(key, next);
};
