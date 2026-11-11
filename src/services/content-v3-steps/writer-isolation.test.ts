/**
 * Option C (rejected) made enforceable: keyword data must NEVER reach the Writer, in any form.
 *
 * Three guards:
 *  1. The Writer-chain system prompts (Writer, humanizer, intelligence, blueprint directives, SEO
 *     rules, business context) are pinned by hash to their text before this branch.
 *  2. The Writer's user-message builder emits nothing keyword-data-shaped even when a caller
 *     smuggles keyword fields into params.
 *  3. The Writer module and the blueprint module import nothing from keyword-data or the steps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The generator module reaches data/db.js through generation-history.ts; postgres() is lazy, so a
// placeholder URL is enough to import it without a database.
process.env.DATABASE_URL ||= 'postgres://placeholder:placeholder@localhost:5432/placeholder';
const gen = await import('../claude-content-generator-v3.service.js');

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// Computed on main at 571cb62, before any keyword-data work.
const PINNED: Record<string, string> = {
  intelligence: '767485286ad9d5b2a9fe8c5ede9b6ad0f42cb506c83243e2253981603e975116',
  generation: 'fecf7e7a80dc64f07845bddfd4d0d05819d37666d3aa73c7b06135e972a8da6a',
  humanize: '474e642c9473b2c7e7cf9727a8c82869eb501c79915fe7d88e83d7d95d8c8477',
  blueprintDirectives: '322efdfc419dd95b838d6ce720b5f4c20814a790b9cf13ccfb62dd118a4e3542',
  seoRules: '9180853af223b831a2f9b28ea0e9043691171a58cab320ed281d075980538955',
  businessContext: '34b3d3aa509886e2be2129cee8691177813eb58328d11a5611821cca58c52fe5',
};

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stripComments = (s: string) =>
  s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');

describe('Writer-chain system prompts are unchanged byte for byte', () => {
  for (const [key, expected] of Object.entries(PINNED)) {
    test(`${key} (${(gen.V3_PROMPT_DEFS as any)[key].templateType})`, () => {
      assert.equal(sha((gen.V3_PROMPT_DEFS as any)[key].fallback), expected);
    });
  }
});

describe('the Writer request carries no keyword data', () => {
  test('buildGenerationUserV3 ignores keyword fields smuggled into params', () => {
    const smuggled = {
      seed_keyword: 'water heater repair cost',
      niche: 'plumbing',
      title: 'Water heater repair cost in Española: what drives the price',
      keyword_data: '<keyword_data scope="national" location="United States">\nseed: water heater repair cost | volume 2400\n</keyword_data>',
      use_keyword_data: true,
      recent_posts: [{ post_id: 1, title: 'x' }],
      search_volume: 2400,
    } as any;
    const user = gen.buildGenerationUserV3(smuggled, { niche: 'plumbing' }, 'English (US)', null, 'DIRECTIVE', 'SEO RULES', 'BUSINESS CONTEXT');
    assert.doesNotMatch(user, /<keyword_data|keyword_data|search_volume|\| volume \d|recent_posts|demand_notes|overlap|2400/);
    assert.match(user, /Keyword: water heater repair cost/);
  });

  test('GenerateV3Params has no keyword-data field a route could populate', () => {
    const source = stripComments(fs.readFileSync(path.join(SRC, 'services/claude-content-generator-v3.service.ts'), 'utf8'));
    const iface = source.slice(source.indexOf('export interface GenerateV3Params'), source.indexOf('export interface AudienceIntelligence'));
    assert.doesNotMatch(iface, /keyword_data|use_keyword_data|recent_posts|search_volume/);
  });
});

describe('module boundaries', () => {
  test('the Writer module imports nothing from keyword-data or the steps, and never names keyword_data', () => {
    const source = stripComments(fs.readFileSync(path.join(SRC, 'services/claude-content-generator-v3.service.ts'), 'utf8'));
    assert.doesNotMatch(source, /keyword-data|content-v3-steps|keyword_data|dataforseo/i);
  });

  test('the blueprint module is untouched by keyword data', () => {
    const source = fs.readFileSync(path.join(SRC, 'services/content-blueprint.ts'), 'utf8');
    assert.doesNotMatch(source, /keyword-data|keyword_data|search_volume|dataforseo/i);
  });

  test('the step modules never import the Writer', () => {
    const dir = path.join(SRC, 'services/content-v3-steps');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
      assert.doesNotMatch(source, /claude-content-generator-v3|buildGenerationUserV3|GEN_SYSTEM/, file);
    }
  });
});
