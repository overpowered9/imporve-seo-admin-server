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
