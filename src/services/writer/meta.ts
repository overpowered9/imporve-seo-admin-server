/**
 * Meta title and description for v3 articles — interim U4 (approved 14 Nov). The Meta prompt (#13)
 * is not drafted, so this runs the EXISTING v3 meta wording (claude-content-generator-v3.service.ts
 * recoverMeta / regenerateMetaField) on the final article, minus the FAQ part, with the existing
 * length enforcement (meta-length.ts). Only the transport changed: both calls go through
 * model-call.ts, so they have a timeout, attempts and a [model-call] cost line.
 */
import { META_BOUNDS, enforceMetaLength, type MetaKind } from '../meta-length.js';
import { runModelCall, type ProviderCall } from '../model-call.js';
import { parseJsonLoose } from '../claude.service.js';

const META_SYSTEM = 'You write SEO metadata. Return ONLY valid JSON, no prose, no fences.';
const META_FIELD_SYSTEM = 'You write SEO metadata to an exact character budget. Return ONLY valid JSON, no prose, no fences.';

/** The article as plain text, capped as the existing logic does. */
export function articlePlain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

/** recoverMeta's wording without the "faq" line and its instruction. */
export function metaUserMessage(seedKeyword: string, html: string): string {
  return `From the article below, output ONLY JSON:
{"meta_title": "50-60 chars, sentence case, includes the keyword naturally, no pipes/slashes",
 "meta_description": "150-160 chars, pain then outcome, soft CTA, human voice"}
Keyword: ${seedKeyword}

Article:
${articlePlain(html)}`;
}

/** regenerateMetaField's wording, unchanged. */
export function metaFieldUserMessage(kind: MetaKind, seedKeyword: string, html: string): string {
  const isTitle = kind === 'meta_title';
  const { min, max } = META_BOUNDS[kind];
  const style = isTitle
    ? 'sentence case, include the keyword naturally, no pipes or slashes'
    : "address the reader's pain then the outcome, with a soft CTA, in a human voice";
  return `Rewrite ONLY the ${isTitle ? 'meta title' : 'meta description'} for the article below.
HARD REQUIREMENT: the result MUST be between ${min} and ${max} characters, counting every character including spaces. Closer to ${max} is better than under ${min}. Never exceed ${max}.
Style: ${style}.
Return ONLY JSON: {"${kind}": "..."}
Keyword: ${seedKeyword}

Article:
${articlePlain(html)}`;
}

export interface MetaDeps {
  call: ProviderCall;
  model: string;
  timeoutMs: number;
  runId?: string;
  log?: (line: string) => void;
  /** The article request's deadline (B-3): meta calls never run past it. */
  deadlineAt?: number;
}

export interface MetaResult {
  meta_title: string;
  meta_description: string;
  cost_usd: number | null;
  usage: unknown[];
}

export async function generateMetaV3(seedKeyword: string, html: string, deps: MetaDeps): Promise<MetaResult> {
  const usage: unknown[] = [];
  let cost: number | null = 0;
  const addCost = (c: number | null) => {
    cost = cost === null || c === null ? null : Math.round((cost + c) * 1e6) / 1e6;
  };
  let first = { meta_title: '', meta_description: '' };
  try {
    const r = await runModelCall<{ meta_title: string; meta_description: string }>({
      step: 'meta',
      model: deps.model,
      promptVersion: 'meta_v3_interim@code',
      system: META_SYSTEM,
      user: metaUserMessage(seedKeyword, html),
      maxTokens: 4000,
      timeoutMs: deps.timeoutMs,
      call: deps.call,
      parse: (t) => {
        const o = parseJsonLoose(t) as Record<string, unknown>;
        return { meta_title: String(o?.meta_title ?? '').trim(), meta_description: String(o?.meta_description ?? '').trim() };
      },
      runId: deps.runId,
      deadlineAt: deps.deadlineAt,
      log: deps.log,
    });
    first = r.value;
    usage.push(...r.usage);
    addCost(r.cost_usd);
  } catch {
    // Both fields are then produced by the length-enforcement re-prompts below.
  }

  const field = (kind: MetaKind, current: string) =>
    enforceMetaLength({
      kind,
      current,
      regenerate: async () => {
        const r = await runModelCall<string>({
          step: 'meta',
          model: deps.model,
          promptVersion: `meta_v3_interim_${kind}@code`,
          system: META_FIELD_SYSTEM,
          user: metaFieldUserMessage(kind, seedKeyword, html),
          maxTokens: 3000,
          timeoutMs: deps.timeoutMs,
          maxAttempts: 1,
          call: deps.call,
          parse: (t) => String((parseJsonLoose(t) as Record<string, unknown>)?.[kind] ?? '').trim(),
          runId: deps.runId,
      deadlineAt: deps.deadlineAt,
          log: deps.log,
        });
        usage.push(...r.usage);
        addCost(r.cost_usd);
        return r.value;
      },
    });

  const [meta_title, meta_description] = await Promise.all([field('meta_title', first.meta_title), field('meta_description', first.meta_description)]);
  return { meta_title, meta_description, cost_usd: cost, usage };
}
