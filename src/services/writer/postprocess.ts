/**
 * Content v3 post-processing — the code steps after the Writer (WR4–WR8, WR10). v2's
 * content-postprocess.ts is untouched; v3 never strips em dashes or adds <hr> (conflict C4).
 *
 *   parseWriterOutput   split the article from ===WRITER_JSON=== and read the JSON (WR4, WR6).
 *   sanitizeArticle     WR10: the <rules_formatting> allowlist — p, h2, h3, ul, ol, li, table, thead,
 *                       tbody, tr, th, td, strong, em, a. Anything else is unwrapped (its text kept)
 *                       or, for script/style/iframe and friends, removed with its content. Only
 *                       data-iseo on h2 and href on a survive; hrefs must be http(s), mailto or tel.
 *                       Code fences and stray markdown wrappers are removed; curly quotes become
 *                       straight (the formatting rule).
 *   linkSourceTokens    WR7: the first use of up to 4 different sources becomes a link; every other
 *                       token is removed; a token with no matching source is removed and logged
 *                       (conflict C5: up to 4; the validator fails a Regulated post with fewer than 3).
 *   addTableOfContents  WR8 / C3: a code-built <nav class="iseo-toc"> placed right after the summary
 *                       section (so the summary still follows the introduction), with ids on the h2s.
 *   insertDisclaimer    WR8 / G4: before the last two sections, only when a real text exists.
 *   extractFaq          WR6: the FAQ is read from the HTML (each <h3> plus the next <p>) for the schema.
 */
import { load, type CheerioAPI } from 'cheerio';
import { z } from 'zod';
import type { ResearchSource } from '../research/research.service.js';

export const WRITER_MARKER = '===WRITER_JSON===';

const writerJsonSchema = z.object({
  facts_used: z
    .array(z.object({ claim: z.string().default(''), from: z.string().default('') }).passthrough())
    .default([]),
  claims_to_check: z.array(z.string()).default([]),
  items_delivered: z.union([z.number().int(), z.null()]).default(null),
});
export type WriterJson = z.infer<typeof writerJsonSchema>;

export interface WriterOutput {
  html: string;
  json: WriterJson;
}

/** Throws on a missing marker, an empty article or unreadable JSON — each counts as a failed attempt. */
export function parseWriterOutput(text: string): WriterOutput {
  const raw = String(text ?? '');
  const at = raw.lastIndexOf(WRITER_MARKER);
  if (at < 0) throw new Error('missing ===WRITER_JSON=== marker');
  const html = raw.slice(0, at).trim();
  if (html.replace(/<[^>]+>/g, '').trim().length < 200) throw new Error('article is empty or too short');
  let jsonText = raw.slice(at + WRITER_MARKER.length).trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('unreadable writer JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    throw new Error('unreadable writer JSON');
  }
  return { html, json: writerJsonSchema.parse(parsed) };
}

// ---------------------------------------------------------------- sanitizer (WR10)

const ALLOWED = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'a']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'head', 'title', 'meta', 'link', 'hr', 'img', 'video', 'audio', 'source', 'canvas']);
export const DATA_ISEO_VALUES = ['quick-answer', 'takeaways', 'body', 'faq', 'closing'] as const;

function safeHref(href: string | undefined): string | null {
  const h = String(href ?? '').trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(h)) return h;
  return null;
}

export interface SanitizeReport {
  unwrapped: string[];
  removed: string[];
}

export function sanitizeArticle(html: string): { html: string; report: SanitizeReport } {
  let src = String(html ?? '');
  // Code fences / a ```html wrapper the model should not have sent.
  src = src.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  const $ = load(src, null, false);
  const report: SanitizeReport = { unwrapped: [], removed: [] };

  // h1 → h2 (no h1 in the body); h4–h6 → h3.
  $('h1').each((_, el) => {
    (el as any).tagName = 'h2';
  });
  $('h4, h5, h6').each((_, el) => {
    (el as any).tagName = 'h3';
  });
  $('b').each((_, el) => {
    (el as any).tagName = 'strong';
  });
  $('i').each((_, el) => {
    (el as any).tagName = 'em';
  });

  // Deepest first, so unwrapping a parent never skips its children.
  const all = $('*').toArray().reverse();
  for (const el of all) {
    const tag = ((el as any).tagName || '').toLowerCase();
    if (!tag) continue;
    if (DROP_WITH_CONTENT.has(tag)) {
      report.removed.push(tag);
      $(el).remove();
      continue;
    }
    if (!ALLOWED.has(tag)) {
      report.unwrapped.push(tag);
      $(el).replaceWith($(el).contents());
      continue;
    }
    const attrs = { ...((el as any).attribs ?? {}) } as Record<string, string>;
    for (const name of Object.keys(attrs)) {
      const keep =
        (tag === 'h2' && name === 'data-iseo' && (DATA_ISEO_VALUES as readonly string[]).includes(attrs[name])) ||
        (tag === 'a' && name === 'href' && safeHref(attrs[name]) !== null);
      if (!keep) $(el).removeAttr(name);
    }
    if (tag === 'a' && !safeHref(attrs.href)) {
      $(el).replaceWith($(el).contents());
    }
  }

  let out = $.html();
  // Straight quotes and apostrophes, never curly (<rules_formatting>). Text only, so attributes are safe.
  out = out.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"');
  out = out.replace(/<p>\s*<\/p>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { html: out, report };
}

// ---------------------------------------------------------------- source tokens (WR7)

export const MAX_LINKED_SOURCES = 4;
const TOKEN_RE = /\s?\[(S\d{1,3})\]/g;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface TokenReport {
  linked: Array<{ token: string; url: string }>;
  removed: number;
  unknown: string[];
}

/**
 * The first use of up to 4 different sources becomes " (<a href=url>domain</a>)"; every other
 * token is removed. Tokens inside headings are removed, never linked (headings carry no links).
 */
export function linkSourceTokens(html: string, sources: Record<string, ResearchSource>, max = MAX_LINKED_SOURCES): { html: string; report: TokenReport } {
  const report: TokenReport = { linked: [], removed: 0, unknown: [] };
  const linked = new Set<string>();
  // Split on tags so headings can be told apart from body text.
  const parts = html.split(/(<[^>]+>)/);
  let inHeading = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('<')) {
      if (/^<h[23]\b/i.test(part)) inHeading++;
      else if (/^<\/h[23]>/i.test(part)) inHeading = Math.max(0, inHeading - 1);
      continue;
    }
    parts[i] = part.replace(TOKEN_RE, (_m, token: string) => {
      const src = sources[token];
      if (!src) {
        report.unknown.push(token);
        return '';
      }
      if (inHeading || linked.has(token) || linked.size >= max) {
        report.removed++;
        return '';
      }
      linked.add(token);
      report.linked.push({ token, url: src.url });
      return ` (<a href="${escAttr(src.url)}" target="_blank" rel="noopener">${escText(domainOf(src.url))}</a>)`;
    });
  }
  return { html: parts.join(''), report };
}

// ---------------------------------------------------------------- structure helpers

export interface Section {
  kind: string | null;
  heading: string;
  /** Outer HTML of the h2 and everything up to the next h2. */
  html: string;
}

export interface ArticleStructure {
  introHtml: string;
  sections: Section[];
}

export function splitSections(html: string): ArticleStructure {
  const parts = html.split(/(?=<h2[\s>])/i);
  const introHtml = parts[0] && !/^<h2[\s>]/i.test(parts[0]) ? parts.shift()! : '';
  const sections = parts.map((p) => {
    const m = /^<h2([^>]*)>([\s\S]*?)<\/h2>/i.exec(p);
    const kind = m ? (/data-iseo="([^"]+)"/.exec(m[1])?.[1] ?? null) : null;
    return { kind, heading: m ? m[2].replace(/<[^>]+>/g, '').trim() : '', html: p };
  });
  return { introHtml, sections };
}

export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ---------------------------------------------------------------- TOC (WR8, C3)

export function addTableOfContents(html: string, opts: { include: boolean; label?: string }): string {
  const { introHtml, sections } = splitSections(html);
  if (!sections.length) return html;
  const used = new Set<string>();
  const withIds = sections.map((s) => {
    let id = slug(s.heading) || 'section';
    while (used.has(id)) id = `${id}-2`;
    used.add(id);
    return { ...s, id, html: s.html.replace(/^<h2([^>]*)>/i, (_m, attrs: string) => `<h2${attrs.replace(/\s+id="[^"]*"/, '')} id="${id}">`) };
  });
  let toc = '';
  if (opts.include) {
    const items = withIds
      .filter((s) => s.kind === 'body' || s.kind === 'faq' || s.kind === 'closing')
      .map((s) => `<li><a href="#${s.id}">${escText(s.heading)}</a></li>`);
    if (items.length >= 2) toc = `<nav class="iseo-toc" aria-label="${escAttr(opts.label ?? 'Contents')}"><ul>${items.join('')}</ul></nav>\n`;
  }
  // Right after the summary section (quick answer / takeaways), else after the introduction.
  const out: string[] = [introHtml];
  let placed = !toc;
  const summaryIdx = withIds.findIndex((s) => s.kind === 'quick-answer' || s.kind === 'takeaways');
  withIds.forEach((s, i) => {
    if (!placed && summaryIdx < 0 && i === 0) {
      out.push(toc);
      placed = true;
    }
    out.push(s.html);
    if (!placed && i === summaryIdx) {
      out.push(toc);
      placed = true;
    }
  });
  return out.join('').trim();
}

// ---------------------------------------------------------------- disclaimer (WR8, G4)

/** Before the last two sections (FAQ and closing, in whatever order). Never with an empty text. */
export function insertDisclaimer(html: string, text: string | null | undefined): string {
  const t = String(text ?? '').trim();
  if (!t) return html;
  const { introHtml, sections } = splitSections(html);
  if (sections.length < 2) return `${html}\n<p class="iseo-disclaimer"><em>${escText(t)}</em></p>`;
  const at = sections.length - 2;
  const block = `<p class="iseo-disclaimer"><em>${escText(t)}</em></p>\n`;
  return [introHtml, ...sections.slice(0, at).map((s) => s.html), block, ...sections.slice(at).map((s) => s.html)].join('').trim();
}

// ---------------------------------------------------------------- FAQ (WR6)

export interface FaqPair {
  question: string;
  answer: string;
}

export function extractFaq(html: string): FaqPair[] {
  const { sections } = splitSections(html);
  const faq = sections.find((s) => s.kind === 'faq');
  if (!faq) return [];
  const $: CheerioAPI = load(faq.html, null, false);
  const out: FaqPair[] = [];
  $('h3').each((_, h) => {
    const q = $(h).text().replace(/\s+/g, ' ').trim();
    const next = $(h).nextAll('p').first();
    const a = next.text().replace(/\s+/g, ' ').trim();
    if (q && a) out.push({ question: q, answer: a });
  });
  return out;
}

export function faqSchema(faq: FaqPair[]): Record<string, unknown> | null {
  if (!faq.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
  };
}

/** Every h2 and h3 heading text, for <recent_headings> on later posts (B9). */
export function headingsOf(html: string): string[] {
  const $ = load(html, null, false);
  return $('h2, h3')
    .toArray()
    .map((h) => $(h).text().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
