/**
 * Research (PROMPT 2, Perplexity Agent API) — settings. The model and effort level are an open
 * question for Zaid (docs/content-v3-prompt-drafts.md, "Open questions"), so both are env values
 * with a working default, listed in .env.example and docs/CONTENT_V3.md.
 *
 *   PERPLEXITY_API_KEY                secret; unset → research is skipped (the run continues
 *                                     without it, exactly the doc's "if all fail" path)
 *   PERPLEXITY_EFFORT          low    fast | low | medium | high (Agent API effort preset)
 *   PERPLEXITY_MODEL           unset  optional model id; unset = the effort preset's model
 *   PERPLEXITY_MAX_RESULTS     20     web_search max_results (1–50)
 *   PERPLEXITY_MAX_OUTPUT_TOKENS 4000
 *   RESEARCH_FILTER_SKIP_DOMAINS     extra comma-separated domains never put in the competitor
 *                                     denylist (added to the built-in government / education /
 *                                     encyclopedia / major news list)
 */

export const PERPLEXITY_AGENT_URL = 'https://api.perplexity.ai/v1/agent';

/** The doc's caps, enforced in code as well as asked for in the prompt (R6). */
export const RESEARCH_CAPS = Object.freeze({ facts: 15, questions: 10, conditions: 6 });

/** search_domain_filter accepts at most 20 entries (Perplexity web search docs). */
export const DOMAIN_FILTER_MAX = 20;

/**
 * Never denylisted even when they rank locally: government, education, encyclopedias and major
 * news (R4). Suffix rules cover .gov / .edu / .mil and their country variants.
 */
export const DEFAULT_SKIP_DOMAINS: readonly string[] = Object.freeze([
  'wikipedia.org', 'britannica.com', 'merriam-webster.com', 'dictionary.com',
  'nytimes.com', 'washingtonpost.com', 'wsj.com', 'usatoday.com', 'latimes.com', 'chicagotribune.com',
  'cnn.com', 'foxnews.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'npr.org', 'pbs.org',
  'apnews.com', 'reuters.com', 'bloomberg.com', 'cnbc.com', 'forbes.com', 'time.com', 'newsweek.com',
  'theguardian.com', 'bbc.com', 'bbc.co.uk', 'axios.com', 'politico.com', 'consumerreports.org',
]);

export interface ResearchConfig {
  apiKey: string | null;
  effort: 'fast' | 'low' | 'medium' | 'high';
  model: string | null;
  maxResults: number;
  maxOutputTokens: number;
  skipDomains: string[];
  timeoutMs: number;
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function researchConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  const effortRaw = (env.PERPLEXITY_EFFORT || 'low').trim().toLowerCase();
  const effort = (['fast', 'low', 'medium', 'high'].includes(effortRaw) ? effortRaw : 'low') as ResearchConfig['effort'];
  const extra = (env.RESEARCH_FILTER_SKIP_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
  return {
    apiKey: env.PERPLEXITY_API_KEY?.trim() || null,
    effort,
    model: env.PERPLEXITY_MODEL?.trim() || null,
    maxResults: intEnv(env.PERPLEXITY_MAX_RESULTS, 20, 1, 50),
    maxOutputTokens: intEnv(env.PERPLEXITY_MAX_OUTPUT_TOKENS, 4000, 500, 16000),
    skipDomains: [...new Set([...DEFAULT_SKIP_DOMAINS, ...extra])],
    timeoutMs: intEnv(env.CONTENT_V3_TIMEOUT_RESEARCH_MS, 120_000, 5_000, 600_000),
  };
}
