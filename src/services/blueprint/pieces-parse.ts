/**
 * The parser that turns the doc's blueprint code blocks into keyed pieces. Used by the test to
 * prove pieces.ts equals the doc; the same rules generated pieces.ts.
 */
import { docBlock, type DocBlock } from '../content-v3/doc-blocks.js';

const H2 = 'Writer part 2: Blueprint';

/** "key: text" lines; indented lines continue the previous key; anything else ends it. */
export function parseKeyed(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last = '';
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (m) {
      out[m[1]] = m[2];
      last = m[1];
      continue;
    }
    if (/^\s+\S/.test(line) && last) {
      out[last] += '\n' + line;
      continue;
    }
    last = '';
  }
  return out;
}

export function parseTypePieces(text: string): Record<string, string> {
  const headers: Array<[string, RegExp]> = [
    ['cost_guide', /^COST GUIDE$/],
    ['cost_guide_no_figure', /^COST GUIDE, NO FIGURE AVAILABLE/],
    ['decision_guide', /^DECISION GUIDE$/],
    ['question_guide', /^QUESTION GUIDE$/],
    ['topic_guide', /^TOPIC GUIDE$/],
  ];
  const out: Record<string, string> = {};
  let cur = '';
  for (const line of text.split('\n')) {
    const h = headers.find(([, re]) => re.test(line));
    if (h) {
      cur = h[0];
      out[cur] = line;
      continue;
    }
    if (line === '') {
      cur = '';
      continue;
    }
    if (cur) out[cur] += '\n' + line;
  }
  return out;
}

export function piecesFromDoc(blocks: DocBlock[]): Record<string, string> {
  return {
    ...parseKeyed(docBlock(blocks, H2, 'Text pieces: openings')),
    ...parseKeyed(docBlock(blocks, H2, 'Text pieces: length patterns and accents')),
    ...parseKeyed(docBlock(blocks, H2, 'Text pieces: closing moves')),
    ...parseTypePieces(docBlock(blocks, H2, 'Text pieces: the four article types')),
    numbered: docBlock(blocks, H2, 'Text piece: numbered titles'),
  };
}
