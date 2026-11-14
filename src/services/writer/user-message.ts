/**
 * The Writer's user message — docs/content-v3-prompt-drafts.md "User message, built by code" (WR2).
 * Every per-article value travels here as a data tag, in the doc's order; the system prompt carries
 * no article data, so it stays cacheable. Empty tags are left out (the core's WHEN A TAG IS MISSING
 * rules then apply). <niche_profile> and <blueprint> arrive pre-built.
 *
 * <research> carries the numbered facts (S1…) and <local_conditions> only, as in the doc's template;
 * follow-up questions were for the Planner and are not sent to the Writer.
 */
import { attrString, inline, isBlank, joinBlocks, listTag, tag } from '../content-v3-steps/xml.js';
import type { MappedResearch } from '../research/research.service.js';
import type { SearcherProfile } from '../content-v3-steps/planner.step.js';
import type { PostSize } from '../content-v3-steps/types.js';

export type PointOfView = 'we' | 'i' | 'business_name';

export const POV_TEXT: Record<PointOfView, string> = {
  we: 'we / our',
  i: 'I / my',
  business_name: 'business name only',
};

export const SIZE_TEXT: Record<PostSize, string> = {
  small: 'small: 600 to 1200 words',
  medium: 'medium: 1200 to 2400 words',
  large: 'large: 2400 to 3600 words',
};

export interface WriterUserInput {
  nicheProfile: string;
  blueprint: string;
  recentHeadings: string;
  title: string;
  seed_keyword: string;
  language?: string;
  post_size: PostSize;
  business_name?: string;
  niche?: string;
  reach?: string;
  target_town?: string;
  featured_service?: string;
  business_description?: string;
  stand_out?: string;
  ideal_client?: string;
  tone?: string;
  point_of_view?: PointOfView;
  cta?: { text?: string; url?: string; phone?: string };
  post_answers?: Array<{ question: string; answer: string }>;
  anything_else?: string;
  searcher_profile?: SearcherProfile | null;
  research?: MappedResearch | null;
}

export function searcherProfileBlock(sp: SearcherProfile | null | undefined): string {
  if (!sp) return '';
  const children = [
    tag('situation', sp.situation),
    tag('main_concern', sp.main_concern),
    tag('desired_outcome', sp.desired_outcome),
    tag('readiness', sp.readiness),
    tag('their_words', (sp.their_words ?? []).filter(Boolean).join('; ')),
    tag('reassurance', sp.reassurance),
  ].filter(Boolean);
  if (!children.length) return '';
  return `<searcher_profile>\n${children.map((c) => `  ${c}`).join('\n')}\n</searcher_profile>`;
}

export function writerResearchBlock(r: MappedResearch | null | undefined): string {
  if (!r) return '';
  const facts = r.facts.map((f) => `<fact id="${f.token}"${attrString({ scope: f.scope, conflict: f.conflict ? 'true' : undefined })}>${inline(f.claim)}</fact>`);
  const conditions = r.local_conditions.map((c) => `<condition id="${c.token}">${inline(c.claim)}</condition>`);
  const children = [listTag('facts', facts), listTag('local_conditions', conditions)].filter(Boolean);
  if (!children.length) return '';
  const nest = (b: string) => b.split('\n').map((l) => `  ${l}`).join('\n');
  return `<research>\n${children.map(nest).join('\n')}\n</research>`;
}

export function postAnswersBlock(answers: WriterUserInput['post_answers']): string {
  const lines = (answers ?? [])
    .filter((a) => a && !isBlank(a.answer))
    .map((a) => `<answer${attrString({ question: a.question })}>${inline(a.answer)}</answer>`);
  return listTag('post_answers', lines);
}

export function ctaTag(cta: WriterUserInput['cta']): string {
  if (!cta || (isBlank(cta.text) && isBlank(cta.url) && isBlank(cta.phone))) return '';
  const text = isBlank(cta.text) ? 'Contact us' : cta.text;
  return tag('cta', text, { url: cta.url, phone: cta.phone });
}

export function buildWriterUserMessage(i: WriterUserInput): string {
  const head = joinBlocks([i.nicheProfile, i.blueprint, i.recentHeadings]);
  const data = joinBlocks([
    tag('title', i.title),
    tag('seed_keyword', i.seed_keyword),
    tag('language', i.language),
    tag('post_size', SIZE_TEXT[i.post_size]),
    tag('business_name', i.business_name),
    tag('niche', i.niche),
    tag('reach', i.reach),
    tag('target_town', i.target_town),
    tag('featured_service', i.featured_service),
    tag('business_description', i.business_description),
    tag('stand_out', i.stand_out),
    tag('ideal_client', i.ideal_client),
    tag('tone', i.tone),
    tag('point_of_view', i.point_of_view ? POV_TEXT[i.point_of_view] : undefined),
    ctaTag(i.cta),
    postAnswersBlock(i.post_answers),
    tag('anything_else', i.anything_else),
    searcherProfileBlock(i.searcher_profile),
    writerResearchBlock(i.research),
  ]);
  return `${head}\n\n${data}\n\nWrite the article.`;
}
