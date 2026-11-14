/**
 * Up to N attempts at a model call whose output code must be able to parse and validate.
 *
 * The design doc's rule for both steps: a failed call, unreadable JSON or an output that fails
 * the code check counts as a failed attempt; up to 3 attempts in all (same inputs each time).
 * Every attempt is recorded — the Planner and Title routes return the list so a tester can see
 * why a run needed a retry.
 */
import type { ClaudeUsage } from '../claude.service.js';

export interface AttemptRecord {
  attempt: number;
  ok: boolean;
  /** Why the attempt was rejected: call_failed | unreadable_json | <validation reason>. */
  reason: string | null;
  ms: number;
  raw_length: number;
}

export class StepFailedError extends Error {
  /** R7: what the failed attempts cost (set by runModelCall; null when a price was unknown). */
  cost_usd?: number | null;
  constructor(
    readonly step: string,
    readonly attempts: AttemptRecord[],
  ) {
    super(`${step}: no valid output after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'} (${attempts.map((a) => a.reason).join('; ')})`);
    this.name = 'StepFailedError';
  }
}

export interface AttemptsOptions<T> {
  step: string;
  /** Default 3. */
  maxAttempts?: number;
  call: (attempt: number) => Promise<{ text: string; usage: ClaudeUsage }>;
  /** May throw; a throw is "unreadable_json". */
  parse: (text: string) => T;
  /** null when the value is acceptable, else a short reason. */
  validate: (value: T) => string | null;
  log?: (line: string) => void;
  now?: () => number;
  /**
   * Called once per attempt, after it is recorded, with that attempt's usage (null when the call
   * itself failed). model-call.ts uses it for the structured per-attempt log line and cost.
   */
  onAttempt?: (info: { record: AttemptRecord; usage: ClaudeUsage | null }) => void;
  /** No attempt starts at or after this time (epoch ms): the request's deadline (B-3). */
  deadlineAt?: number;
  /** Wait before retrying a failed CALL (B-6). Default: exponential from CONTENT_V3_RETRY_BASE_MS. */
  backoff?: { baseMs: number; maxMs: number };
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * B-6: is a failed call worth another attempt? Timeouts, network errors, 408, 409, 429 and 5xx
 * (including Anthropic's 529 "overloaded") are; any other 4xx is a request the provider will
 * refuse again (bad key, bad request), so retrying only spends time.
 */
export function isRetryableCallError(err: unknown): boolean {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = Number(e?.status ?? e?.statusCode);
  if (!Number.isFinite(status) || status <= 0) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Seconds from a Retry-After header on the error (Anthropic SDK and fetch-style errors), if any. */
function retryAfterMs(err: unknown): number | null {
  const h = (err as { headers?: unknown } | null)?.headers as Record<string, unknown> | { get?: (k: string) => unknown } | undefined;
  if (!h) return null;
  const raw = typeof (h as { get?: unknown }).get === 'function' ? (h as { get: (k: string) => unknown }).get('retry-after') : (h as Record<string, unknown>)['retry-after'];
  const s = Number(raw);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

/** Base delay for retries; CONTENT_V3_RETRY_BASE_MS=0 turns waiting off (the test runner does). */
export function defaultBackoff(env: NodeJS.ProcessEnv = process.env): { baseMs: number; maxMs: number } {
  const raw = Number(env.CONTENT_V3_RETRY_BASE_MS);
  const baseMs = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30_000) : 1000;
  return { baseMs, maxMs: baseMs * 8 };
}

/** Exponential with jitter (0.5–1.5×): base, 2×base, 4×base…, capped; Retry-After wins, capped at 4× max. */
export function retryDelayMs(err: unknown, attempt: number, backoff: { baseMs: number; maxMs: number }, random: () => number = Math.random): number {
  if (backoff.baseMs <= 0) return 0;
  const after = retryAfterMs(err);
  if (after !== null) return Math.min(after, backoff.maxMs * 4);
  const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + random()));
}

export interface AttemptsResult<T> {
  value: T;
  attempts: AttemptRecord[];
  /** Usage of every attempt, in order, so cost is never under-reported. */
  usage: ClaudeUsage[];
  raw: string;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

export async function runWithAttempts<T>(opts: AttemptsOptions<T>): Promise<AttemptsResult<T>> {
  const { step, maxAttempts = DEFAULT_MAX_ATTEMPTS, log = (line) => console.log(line), now = () => Date.now() } = opts;
  const backoff = opts.backoff ?? defaultBackoff();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: AttemptRecord[] = [];
  const usage: ClaudeUsage[] = [];
  const record = (rec: AttemptRecord, u: ClaudeUsage | null) => {
    attempts.push(rec);
    try {
      opts.onAttempt?.({ record: rec, usage: u });
    } catch {
      // Logging must never change the outcome of a call.
    }
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) {
      record({ attempt, ok: false, reason: 'deadline: no time left for another attempt', ms: 0, raw_length: 0 }, null);
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} not started: past the request deadline`);
      break;
    }
    const started = now();
    let text = '';
    let callUsage: ClaudeUsage | null = null;
    try {
      const r = await opts.call(attempt);
      text = r.text ?? '';
      if (r.usage) {
        usage.push(r.usage);
        callUsage = r.usage;
      }
    } catch (err) {
      const reason = `call_failed: ${err instanceof Error ? err.message : String(err)}`;
      record({ attempt, ok: false, reason, ms: now() - started, raw_length: 0 }, null);
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} failed: ${reason}`);
      if (!isRetryableCallError(err)) {
        log(`[v3-step] ${step} not retried: the provider refused the request itself`);
        break;
      }
      if (attempt < maxAttempts) {
        const wait = retryDelayMs(err, attempt, backoff, opts.random);
        if (opts.deadlineAt !== undefined && now() + wait >= opts.deadlineAt) {
          log(`[v3-step] ${step} not retried: the wait would pass the request deadline`);
          break;
        }
        if (wait > 0) await sleep(wait);
      }
      continue;
    }

    let value: T;
    try {
      value = opts.parse(text);
    } catch (err) {
      const reason = `unreadable_json: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
      record({ attempt, ok: false, reason, ms: now() - started, raw_length: text.length }, callUsage);
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} rejected: ${reason}`);
      continue;
    }

    const problem = opts.validate(value);
    if (problem) {
      record({ attempt, ok: false, reason: problem, ms: now() - started, raw_length: text.length }, callUsage);
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} rejected: ${problem}`);
      continue;
    }

    record({ attempt, ok: true, reason: null, ms: now() - started, raw_length: text.length }, callUsage);
    return { value, attempts, usage, raw: text };
  }

  throw new StepFailedError(step, attempts);
}
