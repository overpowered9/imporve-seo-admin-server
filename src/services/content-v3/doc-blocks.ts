/**
 * Read the fenced code blocks of docs/content-v3-prompt-drafts.md by section heading.
 *
 * Brief rule 1: every system prompt, data block, text piece and rules block comes byte for byte
 * from the doc, with a test that extracts each block BY ITS SECTION HEADING and compares it with
 * the stored template. This is that extractor; the equality tests live in doc-equality.test.ts.
 *
 * A block's text is the lines between its opening and closing ``` fences, joined with "\n", with
 * no trailing newline: exactly how the in-code constants are stored.
 *
 * The doc is the plugin repo's docs/content-v3-prompt-drafts.md, copied into this repo's docs/
 * unchanged (same md5). When the doc changes, copy it again; the equality tests then show every
 * prompt that must change with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DocBlock {
  /** The "## " heading the block sits under, without the hashes. */
  h2: string;
  /** The "### " heading, or '' when the block sits directly under the h2. */
  h3: string;
  /** 0-based position among the blocks under the same h2 + h3. */
  index: number;
  text: string;
  /** 1-based line of the opening fence, for error messages. */
  line: number;
}

export function parseDocBlocks(markdown: string): DocBlock[] {
  const lines = markdown.split('\n');
  const out: DocBlock[] = [];
  let h2 = '';
  let h3 = '';
  const counters = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      h2 = line.slice(3).trim();
      h3 = '';
      continue;
    }
    if (line.startsWith('### ')) {
      h3 = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('```')) {
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      const key = `${h2}\u0000${h3}`;
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      out.push({ h2, h3, index, text: body.join('\n'), line: start + 1 });
    }
  }
  return out;
}

/**
 * The block under the h2 and h3 that START WITH the given prefixes (headings carry decorations like
 * "(#3)" or a backticked tag). Throws when it is missing, so a renamed heading fails a test loudly.
 */
export function docBlock(blocks: DocBlock[], h2Prefix: string, h3Prefix: string, index = 0): string {
  const found = blocks.find((b) => b.h2.startsWith(h2Prefix) && b.h3.startsWith(h3Prefix) && b.index === index);
  if (!found) throw new Error(`doc block not found: "${h2Prefix}" > "${h3Prefix}" #${index}`);
  return found.text;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DOC_PATH = path.resolve(here, '../../../docs/content-v3-prompt-drafts.md');

let cached: DocBlock[] | null = null;
/** The repo copy of the doc, parsed once. Tests only: production never reads the doc at runtime. */
export function repoDocBlocks(): DocBlock[] {
  if (!cached) cached = parseDocBlocks(fs.readFileSync(DOC_PATH, 'utf8'));
  return cached;
}

/** Test helper: fail with the first differing position and a little context on each side. */
export function assertSameText(actual: string, expected: string, what: string): void {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  throw new Error(
    `${what} differs from the doc at character ${i} (stored ${actual.length} chars, doc ${expected.length}):\n` +
      `  stored: ${JSON.stringify(actual.slice(Math.max(0, i - 30), i + 50))}\n` +
      `  doc:    ${JSON.stringify(expected.slice(Math.max(0, i - 30), i + 50))}`,
  );
}
