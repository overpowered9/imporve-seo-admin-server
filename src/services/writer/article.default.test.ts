import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { liveWriterParts, __resetWriterPartWarnings } from './article.default.js';
import { WRITER_CORE_V2, RULES_SEO_V1 } from './prompt.js';

function svc(db: Record<string, string>, replaced: string[]) {
  return {
    getPromptWithVersion: async (type: string) => {
      if (!(type in db)) throw new Error('not found');
      return { text: db[type], version: 2, versionId: 'x', label: null };
    },
    hasVersionLabelled: async (type: string) => replaced.includes(type),
  };
}

describe('liveWriterParts guard (found in the 14 Nov live run)', () => {
  beforeEach(() => __resetWriterPartWarnings());

  test('legacy-shared templates use the doc text until the replace step ran, with one warning', async () => {
    const logs: string[] = [];
    const parts = await liveWriterParts(svc({ content_v3_system: 'OLD CORE ===META_JSON===', content_v3_seo_rules: 'old 3 lines', content_v3_rules_formatting: 'TUNED FORMATTING' }, []) as any, (l) => logs.push(l));
    assert.equal(parts.core!.text, WRITER_CORE_V2);
    assert.equal(parts.core!.source, 'fallback');
    assert.equal(parts.rules_seo!.text, RULES_SEO_V1);
    assert.equal(parts.rules_formatting!.text, 'TUNED FORMATTING', 'a v3-only template is used as stored');
    assert.equal(parts.rules_formatting!.source, 'db');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /still holds the pre-v3 text/);
  });

  test('after the replace step, tuned values are used — but never a core without the output contract', async () => {
    const tuned = WRITER_CORE_V2.replace('You write one blog article', 'You write one excellent blog article');
    const a = await liveWriterParts(svc({ content_v3_system: tuned }, ['content_v3_system']) as any, () => {});
    assert.equal(a.core!.text, tuned);
    assert.equal(a.core!.source, 'db');
    const logs: string[] = [];
    const b = await liveWriterParts(svc({ content_v3_system: 'tuned but no marker' }, ['content_v3_system']) as any, (l) => logs.push(l));
    assert.equal(b.core!.text, WRITER_CORE_V2);
    assert.match(logs[0], /no ===WRITER_JSON=== output contract/);
  });
});
