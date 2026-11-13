/**
 * Brief rule 1 / production gate item 2: every stored prompt equals its block in
 * docs/content-v3-prompt-drafts.md, byte for byte, found by section heading.
 *
 * Each later phase adds its prompts here (Research, the Writer core, the rules blocks, the
 * blueprint and niche text pieces). A failing test prints the first differing position.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { docBlock, parseDocBlocks, repoDocBlocks } from './doc-blocks.js';
import { TITLE_SYSTEM_V1, PLANNER_SYSTEM_V1 } from '../content-v3-steps/prompts.js';
import { RESEARCH_INSTRUCTIONS_V1 } from '../research/prompt.js';

export function assertSameText(actual: string, expected: string, what: string): void {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  assert.fail(
    `${what} differs from the doc at character ${i} (stored ${actual.length} chars, doc ${expected.length}):\n` +
      `  stored: ${JSON.stringify(actual.slice(Math.max(0, i - 30), i + 50))}\n` +
      `  doc:    ${JSON.stringify(expected.slice(Math.max(0, i - 30), i + 50))}`,
  );
}

describe('doc-blocks extractor', () => {
  test('finds blocks by h2/h3 prefix and keeps their exact lines', () => {
    const md = ['## A (#1)', 'x', '### Sys', '```', 'line 1', '', 'line "3"', '```', '```', 'second', '```', '## B', '```', 'b', '```'].join('\n');
    const blocks = parseDocBlocks(md);
    assert.equal(docBlock(blocks, 'A', 'Sys'), 'line 1\n\nline "3"');
    assert.equal(docBlock(blocks, 'A', 'Sys', 1), 'second');
    assert.equal(docBlock(blocks, 'B', ''), 'b');
    assert.throws(() => docBlock(blocks, 'C', ''), /doc block not found/);
  });
});

describe('stored prompts equal the doc', () => {
  const blocks = repoDocBlocks();

  test('PROMPT 1 · Title: system prompt', () => {
    assertSameText(TITLE_SYSTEM_V1, docBlock(blocks, 'PROMPT 1 · Title', 'System prompt'), 'TITLE_SYSTEM_V1');
  });

  test('PROMPT 2 · Research query: instructions', () => {
    assertSameText(RESEARCH_INSTRUCTIONS_V1, docBlock(blocks, 'PROMPT 2 · Research query', 'System prompt'), 'RESEARCH_INSTRUCTIONS_V1');
  });

  test('PROMPT 3 · Planner: system prompt', () => {
    assertSameText(PLANNER_SYSTEM_V1, docBlock(blocks, 'PROMPT 3 · Planner', 'System prompt'), 'PLANNER_SYSTEM_V1');
  });
});
