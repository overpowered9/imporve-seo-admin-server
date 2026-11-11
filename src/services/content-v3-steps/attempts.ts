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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = now();
    let text = '';
    try {
      const r = await opts.call(attempt);
      text = r.text ?? '';
      if (r.usage) usage.push(r.usage);
    } catch (err) {
      const reason = `call_failed: ${err instanceof Error ? err.message : String(err)}`;
      attempts.push({ attempt, ok: false, reason, ms: now() - started, raw_length: 0 });
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} failed: ${reason}`);
      continue;
    }

    let value: T;
    try {
      value = opts.parse(text);
    } catch (err) {
      const reason = `unreadable_json: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
      attempts.push({ attempt, ok: false, reason, ms: now() - started, raw_length: text.length });
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} rejected: ${reason}`);
      continue;
    }

    const problem = opts.validate(value);
    if (problem) {
      attempts.push({ attempt, ok: false, reason: problem, ms: now() - started, raw_length: text.length });
      log(`[v3-step] ${step} attempt ${attempt}/${maxAttempts} rejected: ${problem}`);
      continue;
    }

    attempts.push({ attempt, ok: true, reason: null, ms: now() - started, raw_length: text.length });
    return { value, attempts, usage, raw: text };
  }

  throw new StepFailedError(step, attempts);
}
