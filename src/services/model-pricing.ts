/**
 * Per-model token prices, so every Content v3 model call can log what it cost (OPS3).
 *
 * USD per million tokens, Anthropic first-party list prices (checked 2026-11-14):
 *   input, output, cache_write (5-minute TTL, 1.25 x input), cache_read.
 * Cache reads are NOT always 0.1 x input: Opus 5.5 and Sonnet 5.5 bill 0.05 x, Fable 5.2 0.025 x.
 *
 * Prices change. MODEL_PRICES_JSON overrides or adds entries without a deploy, e.g.
 *   MODEL_PRICES_JSON={"claude-sonnet-5":{"input":2,"output":10,"cache_write":2.5,"cache_read":0.2}}
 * An unknown model logs cost=null rather than a guessed number.
 */
import type { ClaudeUsage } from './claude.service.js';

export interface ModelPrice {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-fable-5-2': { input: 8, output: 40, cache_write: 10, cache_read: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
});

function isPrice(v: unknown): v is ModelPrice {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return ['input', 'output', 'cache_write', 'cache_read'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k] as number) && (p[k] as number) >= 0);
}

/** The price table in effect: defaults, then any valid MODEL_PRICES_JSON entries on top. */
export function modelPrices(env: NodeJS.ProcessEnv = process.env): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES };
  const raw = env.MODEL_PRICES_JSON;
  if (!raw || !raw.trim()) return table;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [model, price] of Object.entries(parsed ?? {})) {
      if (isPrice(price)) table[model] = price;
    }
  } catch {
    // A malformed override must not take logging down; the defaults stay in effect.
  }
  return table;
}

export interface UsageTokens {
  /** Uncached input tokens (Anthropic's input_tokens already excludes cache reads and writes). */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export function usageTokens(u: ClaudeUsage | null | undefined): UsageTokens {
  return {
    input: Number(u?.input_tokens) || 0,
    output: Number(u?.output_tokens) || 0,
    cache_read: Number(u?.cache_read_input_tokens) || 0,
    cache_write: Number(u?.cache_creation_input_tokens) || 0,
  };
}

/** USD for one call, rounded to 6 decimals; null when the model has no known price. */
export function modelCostUsd(model: string | undefined, usage: ClaudeUsage | null | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  if (!model) return null;
  const price = modelPrices(env)[model];
  if (!price) return null;
  const t = usageTokens(usage);
  const usd =
    (t.input * price.input + t.output * price.output + t.cache_write * price.cache_write + t.cache_read * price.cache_read) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
