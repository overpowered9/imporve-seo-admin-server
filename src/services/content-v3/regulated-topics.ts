/**
 * Regulated topics list (docs/content-v3-prompt-drafts.md, "Regulated topics list (draft 1, for
 * review)") — the first, cheap post-level check for a Standard business (G2). Either this list or
 * the Planner's regulated_topic is enough to suggest Regulated; the single wizard then asks Keep /
 * Turn off, bulk applies it.
 *
 * The default terms and exclusions are the doc's table, word for word (regulated-topics.test.ts
 * reads the table from the doc and compares). It is an EDITABLE SETTING, not prompt text: the
 * prompt registry template `content_v3_regulated_topics` may hold a JSON replacement
 * ({ categories: { name: string[] }, exclusions: string[] }); an invalid value falls back to the
 * default. English only in v1. Each niche's watchlist joins the list at check time (niche profile).
 *
 * Matching: whole words/phrases, case-insensitive, on the title and seed keyword. Exclusion
 * phrases ("fuel injection", "photo shoot" …) are blanked out first so a term inside them never
 * matches on its own; the conditional exclusions ("interest (without "rate")", "therapy (without
 * "for" a condition)") are covered because the list only holds the qualified phrases.
 */

export type RegulatedCategory = 'Health and medical' | 'Legal' | 'Financial' | 'Insurance';

export interface RegulatedTopicsList {
  categories: Record<string, string[]>;
  exclusions: string[];
}

export const DEFAULT_REGULATED_TOPICS: RegulatedTopicsList = Object.freeze({
  categories: {
    'Health and medical': [
      'Botox', 'dermal filler', 'lip filler', 'injectable', 'IV therapy', 'IV drip', 'microneedling', 'laser treatment',
      'prescription', 'medication', 'dosage', 'side effects', 'diagnosis', 'surgery', 'anesthesia', 'dental implant',
      'root canal', 'weight loss injection', 'semaglutide', 'hormone therapy', 'testosterone therapy',
      'mental health treatment', 'therapy for anxiety', 'therapy for depression',
    ],
    Legal: [
      'lawsuit', 'settlement', 'personal injury claim', 'statute of limitations', 'custody', 'divorce filing', 'DUI',
      'criminal charge', 'bankruptcy', 'will and trust', 'power of attorney', "workers' compensation claim",
      'visa application', 'legal rights',
    ],
    Financial: [
      'mortgage rate', 'interest rate', 'APR', 'loan approval', 'credit score', 'debt relief', 'investment return',
      'retirement account', '401(k)', 'IRA', 'crypto', 'tax deduction', 'tax filing', 'tax refund', 'IRS',
    ],
    Insurance: ['insurance claim', 'insurance coverage', 'life insurance', 'annuity', 'deductible'],
  },
  exclusions: [
    'injection molding', 'fuel injection', 'legal pad', 'legal size', 'photo shoot',
    'hair treatment', 'lawn treatment', 'water treatment',
  ],
}) as RegulatedTopicsList;

/** Parse an admin-edited JSON list; null when it is not a usable list. */
export function parseRegulatedTopics(raw: string | null | undefined): RegulatedTopicsList | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as Partial<RegulatedTopicsList>;
    if (!v || typeof v !== 'object' || !v.categories || typeof v.categories !== 'object') return null;
    const categories: Record<string, string[]> = {};
    for (const [name, terms] of Object.entries(v.categories)) {
      if (!Array.isArray(terms)) continue;
      const clean = terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
      if (clean.length) categories[name] = clean;
    }
    if (!Object.keys(categories).length) return null;
    const exclusions = Array.isArray(v.exclusions) ? v.exclusions.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [];
    return { categories, exclusions };
  } catch {
    return null;
  }
}

function norm(s: string): string {
  return ` ${String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

export interface RegulatedMatch {
  category: string;
  term: string;
}

/** The first listed term found in the text, or null. Watchlist terms count as their own category. */
export function matchRegulatedTopic(text: string, list: RegulatedTopicsList = DEFAULT_REGULATED_TOPICS, watchlist: string[] = []): RegulatedMatch | null {
  let hay = norm(text);
  for (const ex of list.exclusions) {
    const e = norm(ex);
    if (e.trim()) hay = hay.split(e).join(' ');
  }
  const groups: Array<[string, string[]]> = [...Object.entries(list.categories), ['Niche watchlist', watchlist]];
  for (const [category, terms] of groups) {
    for (const term of terms) {
      const t = norm(term);
      if (t.trim() && hay.includes(t)) return { category, term };
    }
  }
  return null;
}

/** Plain words for the wizard's line ("This topic involves medical treatment, …"). */
export const CATEGORY_PHRASE: Record<string, string> = {
  'Health and medical': 'medical treatment',
  Legal: 'a legal matter',
  Financial: 'financial products or rates',
  Insurance: 'insurance',
  'Niche watchlist': 'a regulated subject',
};

export interface RegulatedSuggestion {
  suggested: boolean;
  /** Who suggested it: the code list, the Planner, both, or the business setting. */
  by: 'list' | 'planner' | 'both' | 'business' | null;
  category: string | null;
  phrase: string | null;
  term: string | null;
  reason: string;
}

/**
 * G2 / G3: a Regulated business starts every post Regulated with no check; a Standard business
 * gets the list check OR the Planner's regulated_topic. Missing proof level is treated as Standard.
 */
export function regulatedSuggestion(opts: {
  businessProofLevel?: string | null;
  title: string;
  seedKeyword: string;
  plannerRegulated: boolean | null;
  plannerReason?: string;
  list?: RegulatedTopicsList;
  watchlist?: string[];
}): RegulatedSuggestion {
  if (opts.businessProofLevel === 'regulated') {
    return { suggested: true, by: 'business', category: null, phrase: null, term: null, reason: '' };
  }
  const m = matchRegulatedTopic(`${opts.title} ${opts.seedKeyword}`, opts.list ?? DEFAULT_REGULATED_TOPICS, opts.watchlist ?? []);
  const planner = opts.plannerRegulated === true;
  if (!m && !planner) return { suggested: false, by: null, category: null, phrase: null, term: null, reason: '' };
  return {
    suggested: true,
    by: m && planner ? 'both' : m ? 'list' : 'planner',
    category: m?.category ?? null,
    phrase: m ? CATEGORY_PHRASE[m.category] ?? 'a regulated subject' : null,
    term: m?.term ?? null,
    reason: planner ? String(opts.plannerReason ?? '').trim() : '',
  };
}

/** Registry entry: the list is editable in the admin panel as JSON (a setting, not prompt text). */
export const REGULATED_TOPICS_DEF = {
  templateType: 'content_v3_regulated_topics' as const,
  displayName: 'Content v3 — Regulated topics list (JSON setting)',
  fallback: JSON.stringify(DEFAULT_REGULATED_TOPICS, null, 2),
};

/** The live list: the registry's active JSON when valid, else the default. Never throws. */
export async function liveRegulatedTopics(getActive: () => Promise<string>): Promise<RegulatedTopicsList> {
  try {
    return parseRegulatedTopics(await getActive()) ?? DEFAULT_REGULATED_TOPICS;
  } catch {
    return DEFAULT_REGULATED_TOPICS;
  }
}
