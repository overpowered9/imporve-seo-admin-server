/**
 * Who is allowed to write credit_balances.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
 * When credits gained expiry dates, credit_lots became the source of truth and
 * credit_balances became a derived cache. Three writers were missed in that
 * conversion, and each produced a different-looking bug:
 *
 *   • initializeUserCredits — new accounts got a balance they could not spend a
 *     single credit of, because burnFromLots found no lots.
 *   • suspendPlanCredits    — trial expiry zeroed the cache, the next read
 *     recomputed it from the untouched lots, and expired trials carried on
 *     generating. Silent, and it cost money.
 *   • admin adjustments     — support grants were invisible and unspendable.
 *
 * All three looked correct while being written: an INSERT into credit_balances
 * reads exactly like granting credits. A comment saying "go through the lot
 * layer" did not prevent it — one already existed on grantCreditLot. So the
 * rule is enforced here instead, as a grep over the source.
 *
 * Crude by design: it only has to be right about which files mention a table
 * name, which is exactly what it checks. The same remedy was applied to
 * LIVE_SUBSCRIPTION_STATUSES after that set was miswritten four times.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files permitted to write credit_balances.
 *
 * user.models.ts holds syncBalanceCache, the single writer, plus the lot
 * functions that call it. Migrations legitimately seed the table directly —
 * that is what a migration is for.
 */
const ALLOWED = [
  'models/user.models.ts',
  'migrations/',
];

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const sourceFiles = (dir: string, acc: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) acc.push(full);
  }
  return acc;
};

describe('credit_balances has exactly one writer', () => {
  test('no file outside the model or migrations writes it', () => {
    const offenders = sourceFiles(SRC)
      .map((f) => [path.relative(SRC, f), stripComments(fs.readFileSync(f, 'utf8'))] as const)
      .filter(([rel]) => !ALLOWED.some((a) => rel.startsWith(a)))
      .filter(([, code]) => /(INSERT\s+INTO|UPDATE)\s+credit_balances/i.test(code))
      .map(([rel]) => rel);

    assert.deepEqual(
      offenders,
      [],
      'These files write credit_balances directly. It is a DERIVED CACHE of '
      + 'credit_lots — writing it changes what the user sees without changing '
      + 'what they can spend. Grant through grantCreditLot / the lot helpers in '
      + 'user.models.ts and let syncBalanceCache update the cache.',
    );
  });

  test('every function that mutates lots also refreshes the cache', () => {
    // Deliberately NOT a count of balance writes. A magic threshold would need
    // raising every time someone adds a legitimate one, and a test you edit to
    // make it pass is a test nobody trusts.
    //
    // What matters is the pairing: a function that changes credit_lots and does
    // not call syncBalanceCache leaves the displayed balance stale.
    const code = stripComments(fs.readFileSync(path.join(SRC, 'models/user.models.ts'), 'utf8'));
    assert.match(code, /export async function syncBalanceCache/, 'the single cache writer must exist and be exported');

    // Split on top-level function starts and check each block that touches lots.
    const blocks = code.split(/\n(?=export (?:const|async function)\s)/);
    const missing = blocks
      .filter((b) => /(INSERT\s+INTO|UPDATE)\s+credit_lots/i.test(b))
      .filter((b) => !/syncBalanceCache\(/.test(b))
      .map((b) => (b.match(/export (?:const|async function)\s+(\w+)/) || [, '(anonymous)'])[1]);

    assert.deepEqual(
      missing,
      [],
      'These functions change credit_lots without refreshing the derived balance '
      + 'cache. Call syncBalanceCache(tx, user_id) inside the same transaction, '
      + 'or the dashboard will show a number the user cannot spend.',
    );
  });
});
