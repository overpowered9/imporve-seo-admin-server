/**
 * The rules behind the CMS's "Active" / "Not Connected" chip.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ─────────────────────────────────────────
 * Same reason as credit-expiry.test.ts: every rule here lives inside SQL that
 * closes over the module-level `sql` rather than taking it as a parameter, so
 * it cannot be exercised against the fake. The failure mode is a clause going
 * missing, and a grep catches that precisely.
 *
 * What is being protected, and why each one matters:
 *
 *  1. The heartbeat write must land the FIRST time. `heartbeat_at` is not a
 *     timestamp anyone reads for its value — it is a capability bit, and it is
 *     what licenses the CMS to start treating this site's silence as a
 *     disconnection. If the five-minute throttle swallowed the first heartbeat,
 *     a busy site that never has a quiet five minutes would look like an older
 *     plugin build forever.
 *
 *  2. Disconnecting must clear BOTH columns. Leaving heartbeat_at set would
 *     claim the site still runs a heartbeating plugin immediately after being
 *     told it does not — and would then hold that against the site if it
 *     reconnected on an older build.
 *
 *  3. The migration must never backfill heartbeat_at, and must only ever fill
 *     a NULL last_connected_at. Backfilling the capability bit would subject
 *     every existing site to a silence window its plugin cannot satisfy, which
 *     would turn every currently-Active site into "Not Connected" within a day.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = fs.readFileSync(path.join(SRC, 'models/user.models.ts'), 'utf8');
const migration = fs.readFileSync(path.join(SRC, 'migrations/014-website-heartbeat.ts'), 'utf8');
const middleware = fs.readFileSync(path.join(SRC, 'middleware/apiAuth.middleware.ts'), 'utf8');
const routes = fs.readFileSync(path.join(SRC, 'routes/users.routes.ts'), 'utf8');

/** The body of a top-level exported function, by name. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = async`);
  assert.ok(start >= 0, `${name} not found — has it been renamed?`);
  const rest = source.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end >= 0 ? rest.slice(0, end) : rest;
}

/** SQL with comments stripped, so a clause quoted in prose can't satisfy a check. */
const sqlOf = (body: string) =>
  body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('touchWebsiteConnection', () => {
  const body = sqlOf(functionBody(models, 'touchWebsiteConnection'));

  test('a heartbeat writes both columns', () => {
    assert.match(body, /SET last_connected_at = NOW\(\), heartbeat_at = NOW\(\)/);
  });

  test('the first heartbeat is never lost to the five-minute throttle', () => {
    // Without `heartbeat_at IS NULL` in the WHERE, a heartbeat arriving within
    // five minutes of a generation is discarded — and with it the capability
    // bit the CMS needs. See the header.
    const heartbeatBranch = body.slice(body.indexOf('heartbeat_at = NOW()'));
    assert.match(heartbeatBranch, /heartbeat_at IS NULL/);
  });

  test('the ordinary path still does NOT touch heartbeat_at', () => {
    // A plugin request is not proof the plugin heartbeats. Only an unprompted
    // check-in is, or the window would be applied to sites that cannot meet it.
    const ordinary = body.slice(body.lastIndexOf('SET last_connected_at = NOW()'));
    assert.doesNotMatch(ordinary, /heartbeat_at/);
  });

  test('still swallows undefined_column so it can ship before the migration', () => {
    assert.match(body, /42703/);
  });
});

describe('clearWebsiteConnection', () => {
  const body = sqlOf(functionBody(models, 'clearWebsiteConnection'));

  test('clears both columns', () => {
    assert.match(body, /SET last_connected_at = NULL, heartbeat_at = NULL/);
  });

  test('is scoped to one website', () => {
    assert.match(body, /WHERE id = \$\{website_id\}/);
  });
});

describe('the disconnect endpoint', () => {
  test('authenticates WITHOUT stamping a connection', () => {
    // validateApiAccess stamps the site as connected on the way in, and that
    // write is fire-and-forget — so it can land after the handler has cleared
    // it, leaving a site the user just disconnected showing as Active.
    assert.match(routes, /router\.post\(\s*'\/disconnect',\s*validateApiAccessWithoutStamp/);
  });

  test('and the no-stamp variant really does skip the write', () => {
    assert.match(middleware, /if \(stampConnection\) void touchWebsiteConnection/);
    assert.match(middleware, /validateApiAccessWithoutStamp = authenticate\(\{ stampConnection: false \}\)/);
  });

  test('the ordinary variant still stamps', () => {
    assert.match(middleware, /validateApiAccess = authenticate\(\{ stampConnection: true \}\)/);
  });
});

describe('the heartbeat header', () => {
  test('is read as a presence check, not a version', () => {
    assert.match(middleware, /x-plugin-heartbeat/);
    assert.match(middleware, /touchWebsiteConnection\(website\.id, \{ heartbeat \}\)/);
  });
});

describe('migration 014', () => {
  const ddl = migration.slice(migration.indexOf('export const MIGRATION_SQL'));

  test('adds heartbeat_at idempotently', () => {
    assert.match(ddl, /ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ/);
  });

  test('NEVER backfills heartbeat_at', () => {
    // The single most damaging thing this migration could do: claiming the
    // capability for every existing row would put every currently-Active site
    // on a silence window its plugin has no way to satisfy.
    const statements = ddl.split(';');
    const writes = statements.filter((s) => /^\s*UPDATE/im.test(s));
    for (const w of writes) {
      assert.doesNotMatch(w, /SET[\s\S]*heartbeat_at/i,
        'a backfill of heartbeat_at would disconnect every existing site within a day');
    }
  });

  test('backfills last_connected_at only where it is NULL', () => {
    // Extend-only and idempotent: a second run matches no rows, and an existing
    // real timestamp is never overwritten with an older generation date.
    assert.match(ddl, /UPDATE websites w[\s\S]*SET last_connected_at = g\.last_generation/);
    assert.match(ddl, /AND w\.last_connected_at IS NULL/);
  });

  test('the backfill reads generations, which are proof of a real connection', () => {
    assert.match(ddl, /FROM user_generations/);
    assert.match(ddl, /MAX\(created_at\)/);
  });
});
