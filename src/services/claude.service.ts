/**
 * Thin Anthropic Claude client wrapper for the v2 content route.
 *
 * Design notes:
 * - Static instructions (voice rules, banned words, output spec) go in `system` and are
 *   prompt-cached (cache_control: ephemeral) so multi-call pipelines and bulk batches reuse the prefix.
 * - Long generations stream and resolve via .finalMessage() to avoid HTTP timeouts.
 * - JSON calls instruct the model to return only JSON and parse defensively (with one retry by the
 *   caller if needed) — robust across SDK versions without depending on the structured-output surface.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/config.js';

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — required for the v2 content route');
  }
  if (!client) {
    // Retry transient 429/500/529 (overloaded) responses — the API can be briefly overloaded.
    client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 4 });
  }
  return client;
}

export interface ClaudeCallOptions {
  /** Static, cacheable instruction block. */
  system: string;
  /** Per-request volatile content. */
  user: string;
  maxTokens?: number;
  /** Enable adaptive thinking (recommended for the long generation pass). */
  thinking?: boolean;
  /** Put cache_control on the system block (default true). */
  cacheSystem?: boolean;
  /** Override the model for this call (defaults to config.anthropicModel). */
  model?: string;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function buildSystem(system: string, cacheSystem: boolean | undefined): Anthropic.TextBlockParam[] | string {
  if (cacheSystem === false) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/** Long-form text generation. Streams and resolves the full message. */
export async function claudeText(
  opts: ClaudeCallOptions
): Promise<{ text: string; usage: ClaudeUsage }> {
  const anthropic = getAnthropic();
  const stream = anthropic.messages.stream({
    model: opts.model ?? config.anthropicModel,
    max_tokens: opts.maxTokens ?? 8000,
    system: buildSystem(opts.system, opts.cacheSystem),
    messages: [{ role: 'user', content: opts.user }],
    ...(opts.thinking ? { thinking: { type: 'adaptive' } } : {}),
  });
  const message = await stream.finalMessage();
  return { text: extractText(message).trim(), usage: message.usage as ClaudeUsage };
}

/** Short structured call — model returns JSON only; parsed defensively. */
export async function claudeJSON<T = unknown>(
  opts: ClaudeCallOptions
): Promise<{ data: T; raw: string; usage: ClaudeUsage }> {
  const anthropic = getAnthropic();
  const message = await anthropic.messages.create({
    model: opts.model ?? config.anthropicModel,
    max_tokens: opts.maxTokens ?? 2500,
    system: buildSystem(opts.system, opts.cacheSystem),
    messages: [{ role: 'user', content: opts.user }],
  });
  const raw = extractText(message).trim();
  return { data: parseJsonLoose<T>(raw), raw, usage: message.usage as ClaudeUsage };
}

/** Strip code fences / prose and parse the first JSON object/array in the text. */
export function parseJsonLoose<T = unknown>(raw: string): T {
  let s = raw.trim();
  // remove ```json ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) {
    throw new Error(`No JSON found in model output: ${raw.slice(0, 200)}`);
  }
  const openChar = s[start];
  const closeChar = openChar === '{' ? '}' : ']';
  const end = s.lastIndexOf(closeChar);
  const slice = end > start ? s.slice(start, end + 1) : s.slice(start);
  return JSON.parse(slice) as T;
}
