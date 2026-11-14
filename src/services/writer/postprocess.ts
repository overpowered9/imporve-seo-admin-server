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

/**
 * B-4: one canonical form of a link for comparison and output. http(s) through the URL parser
 * (which percent-encodes anything like < > " that could break out of an attribute), mailto:/tel:
 * trimmed with whitespace removed; anything else is null (never linked).
 */
export function normalizeUrl(href: string | null | undefined): string | null {
  const h = String(href ?? '').trim();
  if (!h) return null;
  if (/^(mailto|tel):/i.test(h)) {
    const v = h.replace(/\s+/g, '');
    return /[<>"'`]/.test(v) ? null : v.replace(/^(mailto|tel):/i, (m) => m.toLowerCase());
  }
  try {
    const u = new URL(h);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

const sameLink = (a: string | null, b: string | null) => !!a && !!b && a.replace(/\/$/, '') === b.replace(/\/$/, '');

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

export interface SanitizeReport {
  unwrapped: string[];
  removed: string[];
}

/**
 * WR10 + B-4. `ctaUrl`: the only link the Writer may write itself ("The only link is the <cta>
 * link"); every other link it writes is unwrapped (its text kept). Source links are added later by
 * code (linkSourceTokens), never taken from the model.
 */
export function sanitizeArticle(html: string, opts: { ctaUrl?: string | null } = {}): { html: string; report: SanitizeReport } {
  let src = stripComments(String(html ?? ''));
  // Code fences / a ```html wrapper the model should not have sent.
  src = src.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  const $ = load(src, null, false);
  const report: SanitizeReport = { unwrapped: [], removed: [] };
  const cta = normalizeUrl(opts.ctaUrl);

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
    if (tag === 'a') {
      // B-4: keep only the CTA link (normalized); any other link the model wrote loses its <a>.
      const href = normalizeUrl(attrs.href);
      if (cta && sameLink(href, cta)) {
        $(el).attr('href', cta);
      } else {
        report.unwrapped.push('a');
        $(el).replaceWith($(el).contents());
      }
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
/** One bracket of one or more tokens: [S1], [s2], [S1, S2], [S1; S3] (WR7), with the space before it. */
const TOKEN_GROUP_RE = /\s?\[\s*[Ss]\d{1,3}(?:\s*[,;]\s*[Ss]\d{1,3})*\s*\]/g;
/** Anything left that still looks like a source token, for the leftover check. */
const LEFTOVER_TOKEN_RE = /\s?\[\s*[Ss]\d{1,3}[^\]]{0,40}\]/g;

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
  /** Token-like text that was not a valid token group, stripped by the leftover check. */
  leftovers: number;
}

/**
 * The first use of up to 4 different sources becomes " (<a href=url>domain</a>)"; every other
 * token is removed. Tokens inside headings are removed, never linked (headings carry no links).
 *
 * B-4/WR7: works on the DOM's text nodes (never a regex over the HTML string, which an attribute
 * holding ">" could break), accepts token lists ([S1, S2], [S1; S3]) in any case, links a source
 * only when its URL is a valid http(s) URL (normalized, so nothing in it can break out of the
 * attribute), and strips anything token-like that is left.
 */
export function linkSourceTokens(html: string, sources: Record<string, ResearchSource>, max = MAX_LINKED_SOURCES): { html: string; report: TokenReport } {
  const report: TokenReport = { linked: [], removed: 0, unknown: [], leftovers: 0 };
  const linked = new Set<string>();
  const $ = load(html, null, false);
  const textNodes: any[] = [];
  const walk = (node: any, inHeading: boolean, inLink: boolean) => {
    for (const child of node.children ?? []) {
      if (child.type === 'text') {
        textNodes.push({ node: child, inHeading, inLink });
      } else if (child.type === 'tag') {
        const t = String(child.tagName ?? child.name ?? '').toLowerCase();
        walk(child, inHeading || t === 'h2' || t === 'h3', inLink || t === 'a');
      }
    }
  };
  walk($.root()[0], false, false);
  for (const { node, inHeading, inLink } of textNodes) {
    const text: string = node.data ?? '';
    if (!/\[\s*[Ss]\d/.test(text)) continue;
    let out = '';
    let last = 0;
    let changed = false;
    for (const m of text.matchAll(TOKEN_GROUP_RE)) {
      out += escText(text.slice(last, m.index));
      last = (m.index ?? 0) + m[0].length;
      changed = true;
      const tokens = [...m[0].matchAll(/[Ss](\d{1,3})/g)].map((t) => `S${Number(t[1])}`);
      const links: string[] = [];
      for (const token of tokens) {
        const src = sources[token];
        const url = src ? normalizeUrl(src.url) : null;
        if (!src || !url || !/^https?:/i.test(url)) {
          report.unknown.push(token);
          continue;
        }
        if (inHeading || inLink || linked.has(token) || linked.size >= max) {
          report.removed++;
          continue;
        }
        linked.add(token);
        report.linked.push({ token, url });
        links.push(`<a href="${escAttr(url)}" target="_blank" rel="noopener">${escText(domainOf(url))}</a>`);
      }
      if (links.length) out += ` (${links.join(', ')})`;
    }
    out += escText(text.slice(last));
    // Leftover check: anything that still looks like a token goes, and is counted.
    const cleaned = out.replace(LEFTOVER_TOKEN_RE, () => {
      report.leftovers++;
      return '';
    });
    if (changed || cleaned !== out) $(node).replaceWith(cleaned);
  }
  return { html: $.html(), report };
}

/**
 * B-4: the last step of post-processing, after the table of contents and the disclaimer: one
 * allowlist pass over the final HTML. Allowed: the WR10 tags; h2 with data-iseo and id; the TOC
 * (nav.iseo-toc with aria-label, its ul/li and in-page #links); p.iseo-disclaimer; links only to
 * the CTA URL or a linked research source (normalized). Everything else is unwrapped or removed.
 */
export function finalSanitize(html: string, opts: { ctaUrl?: string | null; sourceUrls?: string[] } = {}): string {
  const $ = load(stripComments(html), null, false);
  const cta = normalizeUrl(opts.ctaUrl);
  const allowedLinks = (opts.sourceUrls ?? []).map((u) => normalizeUrl(u)).filter((u): u is string => !!u);
  const all = $('*').toArray().reverse();
  for (const el of all) {
    const tag = ((el as any).tagName || '').toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      $(el).remove();
      continue;
    }
    const inToc = $(el).closest('nav.iseo-toc').length > 0;
    if (!ALLOWED.has(tag) && tag !== 'nav') {
      $(el).replaceWith($(el).contents());
      continue;
    }
    const attrs = { ...((el as any).attribs ?? {}) } as Record<string, string>;
    for (const name of Object.keys(attrs)) {
      const v = attrs[name];
      const keep =
        (tag === 'h2' && name === 'data-iseo' && (DATA_ISEO_VALUES as readonly string[]).includes(v)) ||
        (tag === 'h2' && name === 'id' && /^[a-z0-9-]{1,90}$/.test(v)) ||
        (tag === 'nav' && name === 'class' && v === 'iseo-toc') ||
        (tag === 'nav' && name === 'aria-label' && !/[<>]/.test(v)) ||
        (tag === 'p' && name === 'class' && v === 'iseo-disclaimer') ||
        (tag === 'a' && (name === 'href' || name === 'target' || name === 'rel'));
      if (!keep) $(el).removeAttr(name);
    }
    if (tag === 'nav' && $(el).attr('class') !== 'iseo-toc') {
      $(el).replaceWith($(el).contents());
      continue;
    }
    if (tag === 'a') {
      const raw = attrs.href ?? '';
      if (inToc && /^#[a-z0-9-]{1,90}$/.test(raw)) {
        $(el).removeAttr('target').removeAttr('rel');
        continue;
      }
      const href = normalizeUrl(raw);
      const isSource = !!href && allowedLinks.some((u) => sameLink(u, href));
      const isCta = !!href && sameLink(href, cta);
      if (!isSource && !isCta) {
        $(el).replaceWith($(el).contents());
        continue;
      }
      $(el).attr('href', href!);
      if (isSource) $(el).attr('target', '_blank').attr('rel', 'noopener');
      else $(el).removeAttr('target').removeAttr('rel');
    }
  }
  return $.html().trim();
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
    // The heading's text, entities decoded once ("Pros &amp; cons" → "Pros & cons"), for both the id
    // and the TOC entry (the raw text gave "pros-amp-cons" and a doubly escaped "&amp;amp;").
    const text = load(`<i>${s.heading}</i>`, null, false).text();
    let id = slug(text) || 'section';
    while (used.has(id)) id = `${id}-2`;
    used.add(id);
    return { ...s, id, text, html: s.html.replace(/^<h2([^>]*)>/i, (_m, attrs: string) => `<h2${attrs.replace(/\s+id="[^"]*"/, '')} id="${id}">`) };
  });
  let toc = '';
  if (opts.include) {
    const items = withIds
      .filter((s) => s.kind === 'body' || s.kind === 'faq' || s.kind === 'closing')
      .map((s) => `<li><a href="#${s.id}">${escText(s.text)}</a></li>`);
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
