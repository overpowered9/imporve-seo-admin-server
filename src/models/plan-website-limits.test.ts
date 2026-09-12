/**
 * Website allowances: Basic 1, Grow 3, Optimize 5, Scale unlimited.
 *
 * Enforced from subscription_plans.website_limit, which migration 020 sets.
 * Read as source rather than imported so the test needs no DATABASE_URL.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(SRC, 'migrations/020-plan-website-limits-v2.ts'), 'utf8');
const printer = fs.readFileSync(path.join(SRC, 'scripts/print-migrations.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'));

describe('migration 020 — website_limit', () => {
  test('Grow (slug basic) connects 3 websites', () => {
    assert.match(migration, /SET website_limit = 3 WHERE slug = 'basic'/);
  });

  test('Optimize (slug starter) connects 5 websites', () => {
    assert.match(migration, /SET website_limit = 5 WHERE slug = 'starter'/);
  });

  test('free (1) and pro (unlimited) are not touched', () => {
    assert.doesNotMatch(migration, /WHERE slug = 'free'/);
    assert.doesNotMatch(migration, /WHERE slug = 'pro'/);
  });

  test('is runnable and listed', () => {
    assert.equal(pkg.scripts['migrate:website-limits-v2'], 'tsx src/migrations/020-plan-website-limits-v2.ts');
    assert.match(printer, /'\.\.\/migrations\/020-plan-website-limits-v2\.js'/);
  });
});
