/**
 * The daily Keyword Generator allowance — the rules that live in SQL and in the route.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ─────────────────────────────────────────
 * Same reason as website-connection.test.ts: keyword-usage.ts closes over the module-level `sql`,
 * so its queries cannot be exercised against the fake. The failure mode is a clause going missing,
 * and a grep catches that precisely. The pure limits are tested for real in
 * config/keyword-limits.config.test.ts.
 *
 * What is being protected:
 *
 *  1. The slot is taken by ONE conditional upsert. A count-then-insert would let two clicks landing
 *     together both take the last slot.
 *  2. A release lands on the day the slot came from, and never drives the counter negative.
 *  3. The credit check still runs first, so a trial-ended account keeps getting its 402 rather
 *     than an allowance message; and the allowance is claimed only after input validation, so a
 *     bad request never costs a use.
 *  4. Only a delivered run keeps its slot, and an unreachable counter fails open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = fs.readFileSync(path.join(SRC, 'models/keyword-usage.ts'), 'utf8');
const migration = fs.readFileSync(path.join(SRC, 'migrations/019-keyword-daily-usage.ts'), 'utf8');
const routes = fs.readFileSync(path.join(SRC, 'routes/generation.routes.ts'), 'utf8');
const printer = fs.readFileSync(path.join(SRC, 'scripts/print-migrations.ts'), 'utf8');

/** The body of a top-level exported function, by name. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = async`);
  assert.ok(start >= 0, `${name} not found — has it been renamed?`);
  const rest = source.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end >= 0 ? rest.slice(0, end) : rest;
}

/** Code with comment lines stripped, so a clause quoted in prose can't satisfy a check. */
const codeOf = (body: string) =>
  body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('reserveKeywordGeneration', () => {
  const body = codeOf(functionBody(model, 'reserveKeywordGeneration'));

  test('takes a slot with one conditional upsert, never a read-then-write', () => {
    assert.match(body, /ON CONFLICT \(user_id, usage_date\) DO UPDATE/);
    assert.match(body, /WHERE keyword_daily_usage\.used < \$\{limit\}/);
    assert.doesNotMatch(body, /SELECT[\s\S]*FROM keyword_daily_usage/);
  });

  test('counts in UTC days', () => {
    assert.match(body, /\(NOW\(\) AT TIME ZONE 'UTC'\)::date/);
  });

  test('carries the day back as text, so a release after midnight lands on the right day', () => {
    assert.match(body, /usage_date::text AS usage_date/);
  });

  test('a non-positive limit never reserves', () => {
    assert.match(body, /if \(!\(limit > 0\)\) return null;/);
  });
});

describe('releaseKeywordGeneration', () => {
  const body = codeOf(functionBody(model, 'releaseKeywordGeneration'));

  test('gives back one slot, never below zero, on the day it was taken', () => {
    assert.match(body, /SET used = GREATEST\(used - 1, 0\)/);
    assert.match(body, /usage_date = \$\{usageDate\}::date/);
  });
});

describe('migration 019', () => {
  test('one row per user per day, and idempotent', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS keyword_daily_usage/);
    assert.match(migration, /PRIMARY KEY \(user_id, usage_date\)/);
  });

  test('closed to the public REST API', () => {
    assert.match(migration, /ALTER TABLE keyword_daily_usage ENABLE ROW LEVEL SECURITY;/);
  });

  test('is in the paste-able migrations:print output', () => {
    assert.match(printer, /'\.\.\/migrations\/019-keyword-daily-usage\.js'/);
  });
});

describe('POST /generatekeyword', () => {
  const start = routes.indexOf("router.post('/generatekeyword',");
  assert.ok(start >= 0, '/generatekeyword route not found');
  const handler = codeOf(routes.slice(start, routes.indexOf('router.post(', start + 1)));

  const claimStart = routes.indexOf('async function claimKeywordAllowance');
  assert.ok(claimStart >= 0, 'claimKeywordAllowance not found');
  const claim = codeOf(routes.slice(claimStart, routes.indexOf('\n}\n', claimStart)));

  test('the credit check runs before the allowance', () => {
    assert.match(handler, /validateApiAccess, validateCredits\('iseo', priceOf\('keywords'\)\), async/);
  });

  test('the allowance is claimed after input validation and before generation', () => {
    const validated = handler.indexOf('seed_keyword is required');
    const claimed = handler.indexOf('claimKeywordAllowance(');
    const generated = handler.indexOf('await chat(');
    assert.ok(validated >= 0 && claimed > validated && generated > claimed);
  });

  test('a spent allowance is a 429 with the stable code, Retry-After and the manual-lists hint', () => {
    assert.match(claim, /res\.status\(429\)/);
    assert.match(claim, /code: KEYWORD_DAILY_LIMIT_CODE/);
    assert.match(claim, /error: KEYWORD_DAILY_LIMIT_MESSAGE/);
    assert.match(claim, /res\.set\('Retry-After'/);
    assert.match(claim, /manual_lists_hint: offersManualListsHint\(plan\)/);
  });

  test('fails open when the allowance cannot be checked', () => {
    assert.match(claim, /catch \(err\) \{[\s\S]*?return null;/);
  });

  test('only a delivered run keeps its slot', () => {
    assert.match(handler, /delivered = true;\s*res\.json\(\{\s*success: true/);
    assert.match(handler, /finally \{[\s\S]*if \(reservation && !delivered\)[\s\S]*releaseKeywordAllowance/);
  });
});
