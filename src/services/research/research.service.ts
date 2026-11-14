/**
 * Research (PROMPT 2 · Research query, #1) on the Perplexity Agent API — R1–R10.
 *
 * Request (R1, Perplexity docs checked 14 Nov 2026): POST https://api.perplexity.ai/v1/agent with
 *   instructions      = RESEARCH_INSTRUCTIONS_V1 (verbatim, DB-tunable as content_v3_research)
 *   input             = the doc's data block (buildResearchInput)
 *   tools             = [{ type: "web_search", max_results, filters: { search_domain_filter },
 *                          user_location? }]
 *   response_format   = { type: "json_schema", json_schema: { name, schema } }
 *   effort / model    = config (open question for Zaid)
 * Response: output_text (the JSON), output[] items of type "search_results" (results[] with id,
 * url, title, date), usage.cost.total_cost (USD).
 *
 * Competitor filter (R4): the domains of the LOCAL ranking pages only, as a denylist ("-x.com"),
 * up to 20, skipping government / education / encyclopedia / major news (configurable).
 * Location (R3): user_location { city, region, country } when a target town is given.
 * Mapping (R5): every source number is mapped to its search result; a fact, question or local
 * condition with no matching source is dropped (this is what stops invented URLs). Caps (R6) 15 /
 * 10 / 6 in code. Facts are numbered S1… and local conditions continue the numbering, so every
 * token the Writer can cite maps to exactly one URL (R10).
 * Failure (R7): up to 3 attempts through the shared model-call wrapper; after that the run goes on
 * without research (null). Never throws.
 */
import { z } from 'zod';
import { DOMAIN_FILTER_MAX, PERPLEXITY_AGENT_URL, RESEARCH_CAPS, researchConfig, type ResearchConfig } from '../../config/research.config.js';
import { runModelCall, promptVersionLabel, type ProviderCall } from '../model-call.js';
import { StepFailedError } from '../content-v3-steps/attempts.js';
import type { ResearchInput, ScopedItem } from '../content-v3-steps/types.js';
import { parseJsonLoose } from '../claude.service.js';
import { parseTown, stateName } from '../search-data/towns.js';
import { buildResearchInput, RESEARCH_OUTPUT_SCHEMA, RESEARCH_PROMPT_DEF, type ResearchInputData } from './prompt.js';

// ---------- Perplexity response shapes (the subset read here) ----------

export interface PplxSearchResult {
  id: number;
  url?: string | null;
  title?: string | null;
  date?: string | null;
  last_updated?: string | null;
}

export interface PplxAgentResponse {
  output_text?: string | null;
  output?: Array<{ type?: string; results?: PplxSearchResult[]; content?: Array<{ type?: string; text?: string }> }> | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
    cost?: { total_cost?: number | null } | null;
  } | null;
}

/** output_text, or the message items' output_text parts joined, when the top-level field is absent. */
export function outputText(r: PplxAgentResponse): string {
  if (typeof r.output_text === 'string' && r.output_text.trim()) return r.output_text;
  const parts: string[] = [];
  for (const item of r.output ?? []) {
    for (const c of item.content ?? []) if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('');
}

export function searchResults(r: PplxAgentResponse): PplxSearchResult[] {
  const out: PplxSearchResult[] = [];
  for (const item of r.output ?? []) {
    if (item?.type === 'search_results' && Array.isArray(item.results)) {
      for (const res of item.results) if (res && Number.isInteger(res.id)) out.push(res);
    }
  }
  return out;
}

// ---------- the model's JSON (schema-validated) ----------

const ids = z.array(z.number().int()).default([]);
export const researchOutputSchema = z.object({
  facts: z
    .array(z.object({ claim: z.string(), scope: z.enum(['local', 'state', 'national', 'general']).catch('general'), source_ids: ids, conflict: z.boolean().default(false) }))
    .default([]),
  follow_up_questions: z.array(z.object({ question: z.string(), source_ids: ids })).default([]),
  local_conditions: z.array(z.object({ claim: z.string(), source_ids: ids })).default([]),
  notes: z.string().default(''),
});
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

// ---------- mapped research ----------

export interface ResearchSource {
  url: string;
  title: string;
  date: string | null;
}

export interface MappedResearch {
  facts: Array<{ token: string; claim: string; scope: 'local' | 'state' | 'national' | 'general'; conflict: boolean; source: ResearchSource }>;
  follow_up_questions: Array<{ question: string; source: ResearchSource }>;
  local_conditions: Array<{ token: string; claim: string; source: ResearchSource }>;
  notes: string;
  /** token → source, for linking the Writer's [S3] tokens (WR7). */
  sources: Record<string, ResearchSource>;
  dropped: { facts: number; questions: number; conditions: number };
}

const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** R5 + R6 + R10: map source numbers, drop the unmatched, cap, number S1… */
export function mapResearch(out: ResearchOutput, results: PplxSearchResult[], opts: { allowLocalConditions: boolean }): MappedResearch {
  const byId = new Map<number, ResearchSource>();
  for (const r of results) {
    const url = clean(r.url);
    if (!/^https?:\/\//i.test(url)) continue;
    byId.set(r.id, { url, title: clean(r.title), date: clean(r.date) || clean(r.last_updated) || null });
  }
  const firstSource = (sourceIds: number[]): ResearchSource | null => {
    for (const id of sourceIds) {
      const s = byId.get(id);
      if (s) return s;
    }
    return null;
  };

  const dropped = { facts: 0, questions: 0, conditions: 0 };
  const sources: Record<string, ResearchSource> = {};
  let n = 0;

  const facts: MappedResearch['facts'] = [];
  for (const f of out.facts) {
    const claim = clean(f.claim);
    const source = firstSource(f.source_ids);
    if (!claim) continue;
    if (!source) {
      dropped.facts++;
      continue;
    }
    if (facts.length >= RESEARCH_CAPS.facts) break;
    const token = `S${++n}`;
    sources[token] = source;
    facts.push({ token, claim, scope: f.scope, conflict: !!f.conflict, source });
  }

  const follow_up_questions: MappedResearch['follow_up_questions'] = [];
  for (const q of out.follow_up_questions) {
    const question = clean(q.question);
    const source = firstSource(q.source_ids);
    if (!question) continue;
    if (!source) {
      dropped.questions++;
      continue;
    }
    if (follow_up_questions.length >= RESEARCH_CAPS.questions) break;
    follow_up_questions.push({ question, source });
  }

  const local_conditions: MappedResearch['local_conditions'] = [];
  if (opts.allowLocalConditions) {
    for (const c of out.local_conditions) {
      const claim = clean(c.claim);
      const source = firstSource(c.source_ids);
      if (!claim) continue;
      if (!source) {
        dropped.conditions++;
        continue;
      }
      if (local_conditions.length >= RESEARCH_CAPS.conditions) break;
      const token = `S${++n}`;
      sources[token] = source;
      local_conditions.push({ token, claim, source });
    }
  }

  return { facts, follow_up_questions, local_conditions, notes: clean(out.notes), sources, dropped };
}

/** The mapped research in the shape the existing <research> builder takes (tokens kept). */
export function toResearchInput(m: MappedResearch): ResearchInput {
  return {
    facts: m.facts.map((f) => ({ claim: f.claim, scope: f.scope, conflict: f.conflict, token: f.token })),
    follow_up_questions: m.follow_up_questions.map((q) => ({ question: q.question })),
    local_conditions: m.local_conditions.map((c) => ({ claim: c.claim, token: c.token })),
    notes: m.notes || undefined,
  };
}

// ---------- competitor filter and location ----------

function registrable(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

export function isSkippedDomain(domain: string, skip: string[]): boolean {
  const d = registrable(domain);
  if (/\.(gov|edu|mil)(\.[a-z]{2})?$/.test(d) || /\.gov\.[a-z]{2}$/.test(d) || /\.ac\.[a-z]{2}$/.test(d)) return true;
  return skip.some((s) => d === s || d.endsWith(`.${s}`));
}

/** R4: "-domain" entries for the LOCAL ranking domains, skip list applied, at most 20. */
export function competitorDenylist(localDomains: string[], skip: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of localDomains) {
    const d = registrable(raw);
    if (!d || seen.has(d) || isSkippedDomain(d, skip)) continue;
    seen.add(d);
    out.push(`-${d}`);
    if (out.length >= DOMAIN_FILTER_MAX) break;
  }
  return out;
}

/** R3: { city, region, country } for the target town ("Española, NM" → New Mexico, US). */
export function userLocation(targetTown: string | undefined | null, stateHint?: string | null, country = 'US'): { city: string; region?: string; country: string } | null {
  if (!targetTown || !targetTown.trim()) return null;
  const { town, state } = parseTown(targetTown, stateHint);
  if (!town) return null;
  const region = state ?? stateName(stateHint);
  return { city: town, ...(region ? { region } : {}), country };
}

// ---------- the call ----------

export interface ResearchRequest extends ResearchInputData {
  /** Domains of the LOCAL ranking pages from the search data lookup (never the national ones). */
  local_domains?: string[];
  state_hint?: string | null;
}

export interface ResearchResult {
  research: MappedResearch | null;
  status: 'ok' | 'failed' | 'not_configured';
  attempts: number;
  cost_usd: number | null;
  ms: number;
  prompt_version: string;
  request_meta: { domain_filter: string[]; user_location: ReturnType<typeof userLocation>; effort: string; model: string | null };
}

export interface ResearchDeps {
  config?: ResearchConfig;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** The DB-tunable instructions; defaults to the in-code text. */
  resolveInstructions?: () => Promise<{ text: string; source: 'db' | 'fallback'; dbVersion?: number | null }>;
  log?: (line: string) => void;
  now?: () => number;
  runId?: string;
  /** B-3: epoch ms by which research must give up, so the Planner keeps its share of the request. */
  deadlineAt?: number;
}

export function perplexityProviderCall(cfg: ResearchConfig, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): ProviderCall {
  return async ({ system, user, signal }) => {
    const res = await fetchImpl(PERPLEXITY_AGENT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, instructions: system, input: user }),
      signal,
    });
    let json: PplxAgentResponse | null = null;
    try {
      json = (await res.json()) as PplxAgentResponse;
    } catch {
      json = null;
    }
    if (!res.ok || !json) {
      // Status only; a provider's error body never reaches a log line or a user.
      throw Object.assign(new Error(`perplexity http ${res.status}`), { status: res.status });
    }
    const u = json.usage ?? {};
    const usage = {
      input_tokens: Number(u.input_tokens) || 0,
      output_tokens: Number(u.output_tokens) || 0,
      cache_read_input_tokens: Number(u.input_tokens_details?.cache_read_input_tokens) || 0,
      cache_creation_input_tokens: Number(u.input_tokens_details?.cache_creation_input_tokens) || 0,
    };
    const cost = u.cost?.total_cost;
    // The wrapper's parse sees one string; carry the search results along with the answer.
    return { text: JSON.stringify({ output_text: outputText(json), results: searchResults(json) }), usage, cost_usd: typeof cost === 'number' ? cost : null };
  };
}

export async function runResearch(req: ResearchRequest, deps: ResearchDeps = {}): Promise<ResearchResult> {
  const cfg = deps.config ?? researchConfig();
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const nationwide = String(req.reach ?? '').toLowerCase().startsWith('nation');
  const town = nationwide ? undefined : req.target_town?.trim() || undefined;
  const location = town ? userLocation(town, req.state_hint) : null;
  const domainFilter = competitorDenylist(req.local_domains ?? [], cfg.skipDomains);
  const instr = deps.resolveInstructions ? await deps.resolveInstructions() : { text: RESEARCH_PROMPT_DEF.fallback, source: 'fallback' as const };
  const promptVersion = promptVersionLabel({ templateType: RESEARCH_PROMPT_DEF.templateType, source: instr.source, dbVersion: instr.dbVersion, text: instr.text });
  const meta = { domain_filter: domainFilter, user_location: location, effort: cfg.effort, model: cfg.model };
  const modelLabel = `perplexity:${cfg.model ?? cfg.effort}`;

  if (!cfg.apiKey) {
    log(`[research] skipped run=${deps.runId ?? '-'} reason=not_configured (PERPLEXITY_API_KEY unset)`);
    return { research: null, status: 'not_configured', attempts: 0, cost_usd: null, ms: 0, prompt_version: promptVersion, request_meta: meta };
  }

  const tool: Record<string, unknown> = { type: 'web_search', max_results: cfg.maxResults };
  if (domainFilter.length) tool.filters = { search_domain_filter: domainFilter };
  if (location) tool.user_location = location;
  const body: Record<string, unknown> = {
    effort: cfg.effort,
    ...(cfg.model ? { model: cfg.model } : {}),
    tools: [tool],
    response_format: { type: 'json_schema', json_schema: { name: 'research', schema: RESEARCH_OUTPUT_SCHEMA } },
    max_output_tokens: cfg.maxOutputTokens,
  };
  const input = buildResearchInput({ ...req, target_town: town, reach: req.reach });

  try {
    const r = await runModelCall<{ out: ResearchOutput; results: PplxSearchResult[] }>({
      step: 'research',
      model: modelLabel,
      promptVersion,
      system: instr.text,
      user: input,
      maxTokens: cfg.maxOutputTokens,
      timeoutMs: cfg.timeoutMs,
      call: perplexityProviderCall(cfg, body, deps.fetchImpl ?? fetch),
      parse: (text) => {
        const wrapped = JSON.parse(text) as { output_text: string; results: PplxSearchResult[] };
        const out = researchOutputSchema.parse(parseJsonLoose(wrapped.output_text));
        return { out, results: wrapped.results ?? [] };
      },
      runId: deps.runId,
      deadlineAt: deps.deadlineAt,
      log,
      now,
    });
    const research = mapResearch(r.value.out, r.value.results, { allowLocalConditions: !!town });
    log(
      `[research] run=${deps.runId ?? '-'} facts=${research.facts.length} questions=${research.follow_up_questions.length} ` +
        `local_conditions=${research.local_conditions.length} dropped=${research.dropped.facts}/${research.dropped.questions}/${research.dropped.conditions} ` +
        `results=${r.value.results.length} filter=${domainFilter.length} location=${location ? `"${location.city}${location.region ? `, ${location.region}` : ''}"` : 'none'} ` +
        `attempts=${r.attempts.length} cost_usd=${r.cost_usd ?? 'null'} ms=${now() - started}`,
    );
    return { research, status: 'ok', attempts: r.attempts.length, cost_usd: r.cost_usd, ms: now() - started, prompt_version: promptVersion, request_meta: meta };
  } catch (err) {
    const attempts = err instanceof StepFailedError ? err.attempts.length : 0;
    log(`[research] failed run=${deps.runId ?? '-'} attempts=${attempts} — continuing without research`);
    return { research: null, status: 'failed', attempts, cost_usd: null, ms: now() - started, prompt_version: promptVersion, request_meta: meta };
  }
}

export type { ScopedItem };
