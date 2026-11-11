/**
 * The data tags the Title and Planner user messages are built from.
 *
 * The data contract (docs/content-v3-prompt-drafts.md) says: every tag is left out when empty,
 * tags are delimiters for DATA the model must not treat as instructions, and items inside
 * <search_data> carry scope="local" or scope="national". Values are escaped so a title or keyword
 * containing "<" cannot open or close a tag.
 */
import { escapeTagText } from '../keyword-data/keyword-data.types.js';
import type { RecentPost, ResearchInput, ScopedItem, SearchDataInput } from './types.js';

type AttrValue = string | number | boolean | null | undefined;

export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Collapse inner whitespace so a pasted multi-line value stays on one line inside its tag. */
export function inline(value: unknown): string {
  return escapeTagText(String(value ?? '').replace(/\s+/g, ' ').trim());
}

export function attrString(attrs?: Record<string, AttrValue>): string {
  if (!attrs) return '';
  return Object.entries(attrs)
    .filter(([, v]) => !(v === undefined || v === null || v === ''))
    .map(([k, v]) => ` ${k}="${inline(typeof v === 'boolean' ? (v ? 'yes' : 'no') : v)}"`)
    .join('');
}

/** `<name>value</name>`, or '' when the value is blank — the "left out when empty" rule. */
export function tag(name: string, value: unknown, attrs?: Record<string, AttrValue>): string {
  if (isBlank(value)) return '';
  return `<${name}${attrString(attrs)}>${inline(value)}</${name}>`;
}

/** A tag with one rendered line per item, indented; '' when there are no items. */
export function listTag(name: string, lines: string[], attrs?: Record<string, AttrValue>): string {
  const kept = lines.filter((l) => !isBlank(l));
  if (!kept.length) return '';
  return `<${name}${attrString(attrs)}>\n${kept.map((l) => `  ${l}`).join('\n')}\n</${name}>`;
}

export function scopedItemLines(items: ScopedItem[] | undefined, itemTag = 'item'): string[] {
  return (items ?? [])
    .filter((i) => i && !isBlank(i.text))
    .map((i) => `<${itemTag} scope="${i.scope === 'national' ? 'national' : 'local'}">${inline(i.text)}</${itemTag}>`);
}

/** Indent a rendered block one level, for nesting inside another tag. */
function nest(block: string): string {
  return block
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

export function searchDataBlock(sd?: SearchDataInput): string {
  if (!sd) return '';
  const titles = scopedItemLines(sd.ranking_titles);
  const paa = scopedItemLines(sd.people_also_ask);
  const related = scopedItemLines(sd.related_searches);
  if (!titles.length && !paa.length && !related.length) return '';
  const children = [
    listTag('ranking_titles', titles),
    listTag('people_also_ask', paa, { count: paa.length }),
    listTag('related_searches', related, { count: related.length }),
  ].filter(Boolean);
  const attrs = attrString({
    location: sd.location,
    national_fallback: typeof sd.national_fallback === 'boolean' ? sd.national_fallback : undefined,
  });
  return `<search_data${attrs}>\n${children.map(nest).join('\n')}\n</search_data>`;
}

export function researchBlock(r?: ResearchInput): string {
  if (!r) return '';
  const facts = (r.facts ?? [])
    .filter((f) => f && !isBlank(f.claim))
    .map((f, i) => `<fact id="S${i + 1}"${attrString({ scope: f.scope, conflict: f.conflict ? 'true' : undefined })}>${inline(f.claim)}</fact>`);
  const questions = (r.follow_up_questions ?? [])
    .filter((q) => q && !isBlank(q.question))
    .map((q) => `<question>${inline(q.question)}</question>`);
  const conditions = (r.local_conditions ?? [])
    .filter((c) => c && !isBlank(c.claim))
    .map((c) => `<condition>${inline(c.claim)}</condition>`);
  const children = [
    listTag('facts', facts),
    listTag('follow_up_questions', questions),
    listTag('local_conditions', conditions),
    tag('notes', r.notes),
  ].filter(Boolean);
  if (!children.length) return '';
  return `<research>\n${children.map(nest).join('\n')}\n</research>`;
}

/** The posts code selected (recent-posts.ts), one line each, with the id the model must echo in overlap. */
export function recentPostsBlock(posts: RecentPost[]): string {
  const lines = posts
    .filter((p) => p && Number.isInteger(p.post_id) && !isBlank(p.title))
    .map((p) => `<post id="${p.post_id}"${attrString({ seed_keyword: p.seed_keyword })}>${inline(p.title)}</post>`);
  return listTag('recent_posts', lines);
}

/** Join rendered blocks, dropping the empty ones. */
export function joinBlocks(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}
