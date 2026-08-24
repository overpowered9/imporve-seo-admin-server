/**
 * Migration 014 — websites.heartbeat_at
 *
 *   npm run migrate:website-heartbeat    (needs DATABASE_URL, same as the server)
 *
 * WHAT THIS ANSWERS
 * Migration 008 gave the CMS `last_connected_at`, which says when a site last
 * proved it holds valid credentials. That is enough to show a site as connected,
 * but not enough to show one as DISCONNECTED — because a plugin that has had its
 * API key removed does not announce it, it simply stops calling. Absence of
 * contact is the only observable signal, and absence only means something if the
 * plugin would otherwise have been in touch.
 *
 * Until now it would not have been. The plugin contacted us on Test Connection
 * and on content generation, and at no other time, so a connected-but-idle site
 * was indistinguishable from a disconnected one. The plugin now pings hourly, and
 * THIS column records that it does.
 *
 * WHY A SECOND COLUMN RATHER THAN A PLUGIN VERSION NUMBER
 * The CMS needs one bit: may I hold this site's silence against it? A version
 * number would make every reader parse and compare versions, and would have to be
 * revised each release. A site that has ever sent a heartbeat has proved the
 * capability directly, which is both simpler and impossible to get wrong.
 *
 * Sites on older plugin builds keep a NULL here forever and keep their current
 * behaviour — connected once, connected until told otherwise. That is deliberate:
 * applying a silence window to a plugin that has no reason to speak would report
 * healthy sites as dead, which is a worse bug than the one being fixed.
 *
 * heartbeat_at IS NULLABLE ON PURPOSE, AND NEVER BACKFILLED
 * NULL means "has never heartbeat", which is exactly true of every existing row.
 * Backfilling IT would claim capability for plugin builds that do not have it,
 * and would flip every currently-Active site to "Not Connected" a day later —
 * the precise regression this design avoids. (last_connected_at IS backfilled,
 * for the opposite reason — see the SQL below.)
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`,
 * which would leave the migration untracked.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
ALTER TABLE websites
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- ── One-off backfill: last generation → last_connected_at ───────────────────
--
-- Migration 008 deliberately did NOT backfill, on the grounds that inventing a
-- connection event would be dishonest. That reasoning depended on something
-- that is going away: the CMS ORed this column with "has this site ever
-- generated content", so a site with history stayed Active without needing a
-- timestamp. This migration ships alongside the removal of that OR, and without
-- a backfill those sites would silently drop to "Not Connected".
--
-- Measured against production before writing this: stamping began 2026-08-20,
-- and three active sites last generated on 10, 11 and 13 August. Their missing
-- timestamp says nothing about whether they are connected — only that they have
-- not been USED since the column started being written.
--
-- And this invents nothing. A generation is proof that the plugin authenticated
-- with a valid API Key and Site Code at that moment, which is the exact fact
-- last_connected_at records; the request that produced it would have stamped
-- this column had it existed. The backfill converts the old evidence into the
-- current shape once, so the old signal can be retired for good.
--
-- These rows keep heartbeat_at NULL, so they take the "older plugin build"
-- branch in the CMS and never go stale — identical to today's behaviour. They
-- become subject to the silence window only once their plugin actually checks
-- in on its own.
--
-- Idempotent: it only ever fills NULLs, and only upwards from nothing.
UPDATE websites w
   SET last_connected_at = g.last_generation
  FROM (
    SELECT website_id, MAX(created_at) AS last_generation
      FROM user_generations
     WHERE website_id IS NOT NULL
     GROUP BY website_id
  ) g
 WHERE w.id = g.website_id
   AND w.last_connected_at IS NULL;
`;

export async function up(): Promise<{ heartbeating: number; backfilled: number }> {
  // Counted before the write, so re-running reports 0 rather than re-reporting
  // rows a previous run already filled.
  const pending = await sql`
    SELECT COUNT(*)::int AS n
      FROM websites w
     WHERE w.last_connected_at IS NULL
       AND EXISTS (SELECT 1 FROM user_generations g WHERE g.website_id = w.id)
  `;

  await sql.unsafe(MIGRATION_SQL);

  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM websites WHERE heartbeat_at IS NOT NULL
  `;
  return {
    heartbeating: Number((rows as any[])[0]?.n ?? 0),
    backfilled: Number((pending as any[])[0]?.n ?? 0),
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('014-website-heartbeat');
if (invokedDirectly) {
  up()
    .then(async ({ heartbeating, backfilled }) => {
      console.log(`✅ Migration 014 applied.`);
      console.log(`   ${backfilled} website(s) backfilled from their last generation.`);
      console.log(`   ${heartbeating} website(s) are sending heartbeats.`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 014 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
