import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOC_PATH } from '../services/content-v3/doc-blocks.js';
import { reviewSheet, testingChecklists } from './content-v3-ten-keywords.js';

test('the review sheet carries the doc\'s own "What to check in testing" lists', () => {
  const lists = testingChecklists(fs.readFileSync(DOC_PATH, 'utf8'));
  const sections = lists.map((l) => l.section);
  for (const s of ['PROMPT 1 · Title (#3)', 'PROMPT 2 · Research query (#1)', 'PROMPT 3 · Planner (#2)']) assert.ok(sections.includes(s), s);
  assert.ok(lists.every((l) => l.items.length > 0));
});

test('a failed case is listed with its error; HTML is escaped', () => {
  const html = reviewSheet([{ id: 'x', ok: false, error: '<script>bad</script>', case: { seed_keyword: 'k<b>' }, timings: { total_ms: 1 } }], []);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});
