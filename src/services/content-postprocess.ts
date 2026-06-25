/**
 * Deterministic post-processing for v2 article HTML.
 *
 * Opus usually returns clean HTML, but these defensive fixes catch the edge cases (ported from the old
 * conversational generator's postProcessContent, minus the destructive ones):
 *   - stray Markdown (**bold**, ## heading) → HTML, so the TOC builder sees real <h2>s
 *   - malformed anchors (target="blank", duplicated trailing URL)
 *   - em-dash overuse (the highest-signal AI tell) → commas
 *   - empty / punctuation-only paragraphs and &nbsp; cleanup
 *   - a code-built Table of Contents with matching heading ids (never trust the model's anchors)
 *   - bare emails/URLs (e.g. the CTA link) → anchors, existing <a> left intact
 *
 * Intentionally NOT ported (too destructive for local-SEO copy): blanket "[...]" bracket stripping and
 * "remove any run of 2+ special chars" — both mangle legitimate content like "$180-$350" or "[2024]".
 * The TOC link/heading reconciliation is unnecessary because we build the TOC from the headings.
 */

export function slugify(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Convert any stray Markdown the model emitted into HTML (no-op on already-clean HTML). */
function convertMarkdownToHtml(content: string): string {
  // bold/italic first so markers inside heading lines also convert
  content = content.replace(/\*\*([^*]+?)\*\*/gs, '<strong>$1</strong>');
  content = content.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
  // ATX headings at line start → HTML (article body has no <h1>, so '#' becomes <h2>)
  content = content.replace(/^\s{0,3}#{6}\s+(.+?)\s*#*\s*$/gm, '<h6>$1</h6>');
  content = content.replace(/^\s{0,3}#{5}\s+(.+?)\s*#*\s*$/gm, '<h5>$1</h5>');
  content = content.replace(/^\s{0,3}#{4}\s+(.+?)\s*#*\s*$/gm, '<h4>$1</h4>');
  content = content.replace(/^\s{0,3}#{3}\s+(.+?)\s*#*\s*$/gm, '<h3>$1</h3>');
  content = content.replace(/^\s{0,3}#{2}\s+(.+?)\s*#*\s*$/gm, '<h2>$1</h2>');
  content = content.replace(/^\s{0,3}#\s+(.+?)\s*#*\s*$/gm, '<h2>$1</h2>');
  // horizontal rules
  content = content.replace(/^\s*---+\s*$/gm, '<hr>');
  return content;
}

/** Repair the common malformed-anchor patterns. */
function fixMalformedAnchors(content: string): string {
  content = content.replace(/target=(["'])blank\1/gi, 'target="_blank"');
  // drop a duplicated raw URL immediately after a complete anchor: <a ...>text</a>https://...
  content = content.replace(
    /(<a\s+[^>]*href=["'][^"']+["'][^>]*>[^<]*<\/a>)[\]\s]*(https?:\/\/[^\s<]+)/gi,
    '$1'
  );
  return content;
}

/** Remove &nbsp; and empty / punctuation-only paragraphs left after other passes. */
function cleanupWhitespace(html: string): string {
  html = html.replace(/&nbsp;/g, ' ');
  html = html.replace(/<p>(?:\s|,|\.|;|&nbsp;)*<\/p>/gi, '');
  html = html.replace(/<p>\s*<\/p>/gi, '');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html;
}

/**
 * Build a linked Table of Contents from the article's <h2> headings and ensure every heading has a
 * matching id. Reliable and always present — no dependence on the model writing correct anchors.
 * Inserted right after the intro (before the first <h2>). Skipped for very short articles.
 */
export function injectTableOfContents(html: string): string {
  const used = new Set<string>();
  const headings: { id: string; text: string }[] = [];

  html = html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi, (_m, attrs: string, inner: string) => {
    const rawAttrs = attrs || '';
    const text = inner.replace(/<[^>]+>/g, '').trim();
    let id = '';
    const idMatch = rawAttrs.match(/id=["']([^"']+)["']/i);
    if (idMatch) {
      id = idMatch[1];
    } else {
      const base = slugify(text) || 'section';
      id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
    }
    used.add(id);
    headings.push({ id, text });
    const attrsWithId = /id=/.test(rawAttrs) ? rawAttrs : ` id="${id}"${rawAttrs}`;
    return `<h2${attrsWithId}>${inner}</h2>`;
  });

  if (headings.length < 2) return html;

  const items = headings.map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`).join('');
  const toc = `<h2 id="table-of-contents">Table of Contents</h2><ol class="improveseo-toc">${items}</ol>`;
  const firstH2 = html.search(/<h2[\s>]/i);
  return firstH2 === -1 ? html : html.slice(0, firstH2) + toc + html.slice(firstH2);
}

/** Convert bare emails and http(s) URLs into anchors, leaving existing <a> tags untouched. */
function linkifyContacts(html: string): string {
  const anchors: string[] = [];
  html = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => {
    anchors.push(m);
    return `__ISEO_A${anchors.length - 1}__`;
  });
  html = html.replace(
    /(https?:\/\/[^\s<>"')]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
  html = html.replace(
    /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
    '<a href="mailto:$1">$1</a>'
  );
  html = html.replace(/__ISEO_A(\d+)__/g, (_m, i) => anchors[parseInt(i, 10)]);
  return html;
}

/** Drop wrapping parentheses around a link: "(​<a>...</a>)" → "<a>...</a>". */
function stripParensAroundLinks(html: string): string {
  return html.replace(/\(\s*(<a\b[^>]*>[\s\S]*?<\/a>)\s*\)/gi, '$1');
}

/** Full post-processing pipeline. Order matters — see comments. */
export function postProcessArticle(html: string): string {
  html = convertMarkdownToHtml(html); // stray markdown → HTML (before TOC, so headings are <h2>)
  html = fixMalformedAnchors(html);
  html = html.replace(/\s*—\s*/g, ', '); // em-dash guard (keeps en-dashes in "$180–$350")
  html = cleanupWhitespace(html); // remove the now-empty "<p>, </p>" etc.
  html = injectTableOfContents(html); // build TOC + heading ids
  html = linkifyContacts(html); // emails + URLs → anchors
  html = stripParensAroundLinks(html);
  return html.trim();
}
