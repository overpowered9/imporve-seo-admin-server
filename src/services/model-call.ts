/**
 * The one wrapper every Content v3 model call goes through (brief rule 5, OPS3, OPS4).
 *
 * Per call it gives:
 *   - a hard wall-clock timeout per attempt (the HTTP request is aborted, not just abandoned);
 *   - up to N attempts (default 3, the doc's rule), where a failed call, unreadable output or an
 *     output that fails the step's own check is a failed attempt (attempts.ts);
 *   - parsing and validation supplied by the step (zod schemas where the output is JSON);
 *   - ONE structured log line per attempt:
 *       [model-call] step=title model=claude-sonnet-5 prompt=content_v3_title@v3#d0881236
 *         attempt=1/3 outcome=ok in=812 out=96 cache_read=1490 cache_write=0 cost_usd=0.001234
 *         ms=2345 run=iseo_tk_…
 *     Token counts, cost, timing and outcome only: never the prompt, the data or the output, so no
 *     user content reaches the logs at info level.
 *
 * Model calls have no side effects, so retrying one is idempotent. Credits are never touched here;
 * the paid route reserves once and refunds once (content-v3-article route).
 *
 * The provider call is injectable (`call`), so the steps' unit tests script it and Research can
 * plug the Perplexity client into the same wrapper.
 */
import { createHash } from 'node:crypto';
import { getAnthropic, type ClaudeUsage } from './claude.service.js';
import { modelCostUsd, usageTokens } from './model-pricing.js';
import { DEFAULT_MAX_ATTEMPTS, runWithAttempts, type AttemptRecord, type AttemptsResult } from './content-v3-steps/attempts.js';

export class ModelCallTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = 'ModelCallTimeoutError';
  }
}

export interface ProviderCallOptions {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  /** Aborted when the attempt's timeout fires. */
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ProviderCallResult {
  text: string;
  usage: ClaudeUsage;
  stop_reason?: string | null;
  /** A provider that reports its own cost (Perplexity) sets this; otherwise the price table is used. */
  cost_usd?: number | null;
}

export type ProviderCall = (opts: ProviderCallOptions) => Promise<ProviderCallResult>;

/**
 * Live Anthropic call: system block cached (cache_control ephemeral), streamed to avoid HTTP
 * timeouts on long outputs, `thinking` omitted (the same request shape claudeText sends with
 * thinking: false). SDK-level retries are capped at 1 because this wrapper owns the attempts.
 */
export const anthropicProviderCall: ProviderCall = async ({ system, user, model, maxTokens, signal, timeoutMs }) => {
  const anthropic = getAnthropic();
  const stream = anthropic.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    },
    { signal, timeout: timeoutMs, maxRetries: 1 },
  );
  const message = await stream.finalMessage();
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (message.stop_reason === 'refusal') throw new Error('model_refusal');
  return { text, usage: message.usage as ClaudeUsage, stop_reason: message.stop_reason };
};

/** Run `fn` with an AbortSignal that fires after `ms`; the returned promise rejects with ModelCallTimeoutError then. */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelCallTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** "content_v3_title@v3#d0881236" (DB version 3) or "content_v3_title@code#d0881236" (in-code fallback). */
export function promptVersionLabel(p: { templateType: string; source: 'db' | 'fallback'; dbVersion?: number | null; text: string }): string {
  const sha = createHash('sha256').update(p.text, 'utf8').digest('hex').slice(0, 8);
  const where = p.source === 'db' ? `v${p.dbVersion ?? '?'}` : 'code';
  return `${p.templateType}@${where}#${sha}`;
}

export interface ModelCallLogFields {
  step: string;
  model: string;
  prompt: string;
  attempt: number;
  max_attempts: number;
  outcome: 'ok' | 'rejected' | 'call_failed' | 'timeout';
  reason?: string | null;
  usage: ClaudeUsage | null;
  cost_usd: number | null;
  ms: number;
  stop_reason?: string | null;
  run_id?: string;
}

export function formatModelCallLog(f: ModelCallLogFields): string {
  const t = usageTokens(f.usage);
  const parts = [
    `step=${f.step}`,
    `model=${f.model}`,
    `prompt=${f.prompt}`,
    `attempt=${f.attempt}/${f.max_attempts}`,
    `outcome=${f.outcome}`,
    `in=${t.input}`,
    `out=${t.output}`,
    `cache_read=${t.cache_read}`,
    `cache_write=${t.cache_write}`,
    `cost_usd=${f.cost_usd === null ? 'null' : f.cost_usd.toFixed(6)}`,
    `ms=${f.ms}`,
  ];
  if (f.stop_reason && f.stop_reason !== 'end_turn') parts.push(`stop=${f.stop_reason}`);
  if (f.reason) parts.push(`reason=${JSON.stringify(f.reason.slice(0, 160))}`);
  if (f.run_id) parts.push(`run=${f.run_id}`);
  return `[model-call] ${parts.join(' ')}`;
}

export interface ModelCallSpec<T> {
  step: string;
  model: string;
  /** promptVersionLabel(...) of the system prompt actually sent. */
  promptVersion: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  maxAttempts?: number;
  /** Throws when the text cannot be read (counts as unreadable_json / unreadable_output). */
  parse: (text: string) => T;
  /** null when acceptable, else a short reason. */
  validate?: (value: T) => string | null;
  call?: ProviderCall;
  runId?: string;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface ModelCallResult<T> extends AttemptsResult<T> {
  /** Sum over every attempt; null when any attempt's cost is unknown. */
  cost_usd: number | null;
  prompt_version: string;
  model: string;
}

function outcomeOf(rec: AttemptRecord): ModelCallLogFields['outcome'] {
  if (rec.ok) return 'ok';
  if (rec.reason?.startsWith('call_failed')) return rec.reason.includes('timed out after') ? 'timeout' : 'call_failed';
  return 'rejected';
}

export async function runModelCall<T>(spec: ModelCallSpec<T>): Promise<ModelCallResult<T>> {
  const {
    step,
    model,
    promptVersion,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    call = anthropicProviderCall,
    log = (line) => console.log(line),
    now = () => Date.now(),
    env = process.env,
  } = spec;

  let costTotal: number | null = 0;
  const stopReasons = new Map<number, string | null | undefined>();
  const reportedCost = new Map<number, number | null | undefined>();

  const r = await runWithAttempts<T>({
    step,
    maxAttempts,
    // The [v3-step] lines stay quiet here; the [model-call] line below carries the same facts.
    log: () => {},
    now,
    call: async (attempt) => {
      const res = await withTimeout(spec.timeoutMs, (signal) =>
        call({ system: spec.system, user: spec.user, model, maxTokens: spec.maxTokens, signal, timeoutMs: spec.timeoutMs }),
      );
      stopReasons.set(attempt, res.stop_reason);
      reportedCost.set(attempt, res.cost_usd);
      return { text: res.text, usage: res.usage };
    },
    parse: spec.parse,
    validate: spec.validate ?? (() => null),
    onAttempt: ({ record, usage }) => {
      const reported = reportedCost.get(record.attempt);
      const cost = usage ? (typeof reported === 'number' ? reported : modelCostUsd(model, usage, env)) : 0;
      costTotal = costTotal === null || cost === null ? null : costTotal + cost;
      log(
        formatModelCallLog({
          step,
          model,
          prompt: promptVersion,
          attempt: record.attempt,
          max_attempts: maxAttempts,
          outcome: outcomeOf(record),
          reason: record.reason,
          usage,
          cost_usd: cost,
          ms: record.ms,
          stop_reason: stopReasons.get(record.attempt),
          run_id: spec.runId,
        }),
      );
    },
  });

  return { ...r, cost_usd: costTotal === null ? null : Math.round((costTotal as number) * 1_000_000) / 1_000_000, prompt_version: promptVersion, model };
}

/**
 * Per-article cost summary (OPS3): each step adds its cost and tokens; summary() is logged once at
 * the end of the run as
 *   [content-v3] cost run=… search_data=0.0030 title=0.0021 research=… planner=… writer=… meta=… total=…
 */
export interface CostLedger {
  add(step: string, cost_usd: number | null, usage?: ClaudeUsage[] | ClaudeUsage | null): void;
  total(): number | null;
  steps(): Record<string, { cost_usd: number | null; in: number; out: number; cache_read: number; cache_write: number }>;
  line(runId?: string): string;
}

export function createCostLedger(): CostLedger {
  const steps: Record<string, { cost_usd: number | null; in: number; out: number; cache_read: number; cache_write: number }> = {};
  return {
    add(step, cost_usd, usage) {
      const s = (steps[step] ||= { cost_usd: 0, in: 0, out: 0, cache_read: 0, cache_write: 0 });
      s.cost_usd = s.cost_usd === null || cost_usd === null ? null : Math.round((s.cost_usd + cost_usd) * 1_000_000) / 1_000_000;
      const list = Array.isArray(usage) ? usage : usage ? [usage] : [];
      for (const u of list) {
        const t = usageTokens(u);
        s.in += t.input;
        s.out += t.output;
        s.cache_read += t.cache_read;
        s.cache_write += t.cache_write;
      }
    },
    total() {
      let sum = 0;
      for (const s of Object.values(steps)) {
        if (s.cost_usd === null) return null;
        sum += s.cost_usd;
      }
      return Math.round(sum * 1_000_000) / 1_000_000;
    },
    steps() {
      return JSON.parse(JSON.stringify(steps));
    },
    line(runId) {
      const parts = Object.entries(steps).map(([k, v]) => `${k}=${v.cost_usd === null ? 'null' : v.cost_usd.toFixed(4)}`);
      const total = this.total();
      parts.push(`total=${total === null ? 'null' : total.toFixed(4)}`);
      return `[content-v3] cost${runId ? ` run=${runId}` : ''} ${parts.join(' ')}`;
    },
  };
}
