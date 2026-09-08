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

describe('addUserWebsite — the website-limit gate', () => {
  const body = sqlOf(functionBody(models, 'addUserWebsite'));

  test('an unreadable account is refused, not waved through', () => {
    // `userPlan?.website_limit || 1` used to fall back to a limit of 1 when
    // the plan lookup itself failed — an account with a broken plan reference
    // could add sites without limit. Failing closed on a missing plan is the
    // opposite bug from the one below, and just as real.
    assert.match(body, /if \(!userPlan\)/);
    assert.match(body, /throw new Error\('User not found'\)/);
  });

  test('NULL (unlimited) is checked explicitly, not treated as falsy', () => {
    // The bug this fixes: `website_limit || 1` reads null (unlimited, the top
    // tier's own encoding) as 0-ish and falls back to 1 — a Scale customer
    // capped at a single website by the same expression meant to protect
    // Free's limit.
    assert.doesNotMatch(body, /website_limit \|\| 1/);
    assert.match(body, /website_limit !== null && userPlan\.website_limit !== undefined/);
  });

  test('the limit check does not run at all for an unlimited plan', () => {
    // getUserWebsites is only worth calling — and the count only worth
    // comparing — when there IS a limit to compare it against.
    const guarded = body.slice(body.indexOf('website_limit !== null'));
    assert.match(guarded, /getUserWebsites\(user_id\)/);
    assert.match(guarded, /currentWebsites\.length >= userPlan\.website_limit/);
  });

  test('the refusal message states the actual number, matching websites.routes.ts', () => {
    assert.match(body, /Website limit reached\. Your plan allows \$\{userPlan\.website_limit\} websites\./);
  });
});

describe('POST /users/websites — no longer trusts a bare user_id', () => {
  // Isolate this one route's handler by its unique registration line, up to
  // the next router.* call — the same slicing idiom the disconnect-endpoint
  // tests below use on this same `routes` source text.
  const start = routes.indexOf("router.post('/websites', requireSupabaseUser");
  const handlerBody = routes.slice(start, routes.indexOf('\nrouter.', start));

  test('the route is registered', () => {
    assert.ok(start >= 0, "router.post('/websites', ...) not found — has it moved or been renamed?");
  });

  test('requires a verified session', () => {
    // This route took `user_id` straight from the request body with no auth
    // middleware at all — any caller who knew a numeric id could attach a
    // website to that account. /websites (websites.routes.ts) has always
    // required a session; this route was simply missed.
    assert.match(handlerBody, /requireSupabaseUser, async \(req: SupabaseAuthedRequest/);
  });

  test('the id used to write the website comes from the token, not the body', () => {
    assert.match(handlerBody, /const user_id = req\.appUser!\.id/);
    assert.match(handlerBody, /addUserWebsite\(user_id, url, name\)/);
  });

  test('a body user_id that disagrees with the token is refused, not silently overridden', () => {
    // user_id stays optional in the body (existing callers keep working), but
    // when present it is CHECKED against the token, not trusted over it.
    assert.match(handlerBody, /user_id: z\.number\(\)\.optional\(\)/);
    assert.match(handlerBody, /bodyUserId !== undefined && bodyUserId !== user_id/);
    assert.match(handlerBody, /res\.status\(403\)/);
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
