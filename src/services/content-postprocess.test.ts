/**
 * Post-processing, both ways round.
 *
 * This module is shared with the live v2 route, so the half of this file that matters most is the
 * half asserting that the default (no options) behaviour is byte-identical to what v2 has always
 * produced. The v3 options only exist because v3 writes its headings from the article's topic, and
 * two of the passes here assume otherwise.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { postProcessArticle, injectTableOfContents, ensureHeadingIds } from './content-postprocess.js';

const ARTICLE = [
  '<p>An intro paragraph that sets the scene.</p>',
  '<h2 data-iseo="quick-answer">What a new unit runs in Phoenix</h2>',
  '<p>Between $3,800 and $6,200 for most homes.</p>',
  '<h2 data-iseo="body">Why Phoenix is harder on equipment</h2>',
  '<p>Heat cycling wears a compressor faster here.</p>',
  '<h2 data-iseo="takeaways">key takeaways</h2>',
  '<ul><li>Get a load calculation.</li></ul>',
].join('');

describe('postProcessArticle — v2 defaults are unchanged', () => {
  test('still normalizes the takeaways heading to its canonical casing', () => {
    const out = postProcessArticle(ARTICLE);
    assert.ok(out.includes('>Key Takeaways</h2>'), 'v2 relies on this canonical casing');
  });

  test('still injects a table of contents unconditionally', () => {
    const out = postProcessArticle(ARTICLE);
    assert.ok(out.includes('Table of Contents'));
    assert.ok(out.includes('class="improveseo-toc"'));
  });

  test('still converts stray markdown, repairs anchors and guards em-dashes', () => {
    const out = postProcessArticle('## A heading\n<p>**bold** and a — dash</p>');
    assert.ok(out.includes('<h2'), 'markdown heading should become an h2');
    assert.ok(out.includes('<strong>bold</strong>'));
    assert.ok(!out.includes('—'), 'em-dash is the highest-signal tell');
  });

  test('still leaves a price range alone', () => {
    const out = postProcessArticle('<p>Expect $180-$350 per visit.</p>');
    assert.ok(out.includes('$180-$350'));
  });
});

describe('postProcessArticle — v3 options', () => {
  test('leaves a topic-written takeaways heading exactly as the model wrote it', () => {
    const out = postProcessArticle(ARTICLE, { normalizeHeadings: false });
    assert.ok(out.includes('>key takeaways</h2>'));
    assert.ok(!out.includes('>Key Takeaways</h2>'));
  });

  test('honours a blueprint that decided against a table of contents', () => {
    const out = postProcessArticle(ARTICLE, { includeToc: false });
    assert.ok(!out.includes('improveseo-toc'));
    assert.ok(!out.includes('Table of Contents'));
  });

  test('still gives every heading an id when the TOC is off, so anchors keep working', () => {
    const out = postProcessArticle(ARTICLE, { includeToc: false });
    assert.ok(out.includes('id="what-a-new-unit-runs-in-phoenix"'));
  });

  test('uses the supplied TOC heading so it is not a fingerprint of its own', () => {
    const out = postProcessArticle(ARTICLE, { tocHeading: "What's covered" });
    assert.ok(out.includes(">What's covered</h2>"));
    assert.ok(!out.includes('Table of Contents'));
  });

  test('preserves the data-iseo attributes the v3 contract depends on', () => {
    const out = postProcessArticle(ARTICLE, { normalizeHeadings: false });
    for (const role of ['quick-answer', 'body', 'takeaways']) {
      assert.ok(out.includes(`data-iseo="${role}"`), `lost the ${role} marker`);
    }
  });

  test('adds an id alongside an existing data-iseo attribute rather than replacing it', () => {
    const out = ensureHeadingIds('<h2 data-iseo="body">A section</h2>');
    assert.ok(out.includes('data-iseo="body"'));
    assert.ok(out.includes('id="a-section"'));
  });
});

describe('injectTableOfContents', () => {
  test('skips the TOC when there are fewer than two headings', () => {
    const out = injectTableOfContents('<p>Intro</p><h2>Only one</h2>');
    assert.ok(!out.includes('improveseo-toc'));
  });

  test('de-duplicates ids when two headings slugify the same', () => {
    const out = injectTableOfContents('<h2>Costs</h2><p>a</p><h2>Costs</h2><p>b</p>');
    assert.ok(out.includes('id="costs"'));
    assert.ok(out.includes('id="costs-2"'));
  });
});
