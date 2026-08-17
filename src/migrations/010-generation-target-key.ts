/**
 * Migration 010 — user_generations.target_key + custom_instruction
 *
 *   npm run migrate:target-key       (needs DATABASE_URL, same as the server)
 *
 * WHY
 * Regeneration must be priced lower than a first generation, and that decision has to be made by
 * the SERVER — a client-supplied `is_regeneration` flag would be a discount anyone could claim.
 * The server therefore answers "have I generated for this slot before?" by looking for a prior
 * successful row. Today it cannot: user_generations records only
 * (user_id, website_id, type, status, parameters, result, metadata, processing_time_ms) — nothing
 * identifies WHICH post or image slot a row belongs to.
 *
 * WHY AN OPAQUE KEY RATHER THAN A WORDPRESS POST ID
 * In the single-post wizard the WordPress post does not exist yet when the article is generated —
 * it is created later, on publish. So there is no post id to send at generation time. The plugin
 * mints an opaque key once per wizard session, keeps it in a hidden field, and persists it onto
 * the project row so the Edit Draft path reuses the same key.
 *
 * WHY NOT DERIVE THE KEY FROM THE PARAMETERS
 * A hash of (keyword + title) was the obvious alternative and is wrong: regeneration is required
 * to run on the user's EDITED parameters, so the hash would change exactly when someone edits and
 * regenerates — silently charging them the full first-generation price for the common case. The
 * key must be independent of the content, hence an opaque minted value.
 *
 * NULLABLE ON PURPOSE
 * NULL means "pre-migration row, or a caller that sent no key". Such rows never match a regen
 * lookup, so the effect of a missing key is that the generation is charged at the FULL price —
 * failing closed, in the platform's favour rather than the client's. No backfill: inventing keys
 * for historical rows would retroactively turn first generations into discounted regens.
 *
 * custom_instruction is stored alongside it purely for auditability — it is untrusted user text
 * that shaped a paid generation, so it should be inspectable after the fact.
 *
 * The DDL lives in TypeScript because this repo's .gitignore excludes `*.sql`, which would leave
 * the migration untracked.
 *
 * Idempotent — safe to run more than once.
 */
import sql from '../data/db.js';

export const MIGRATION_SQL = `
ALTER TABLE user_generations
  ADD COLUMN IF NOT EXISTS target_key TEXT,
  ADD COLUMN IF NOT EXISTS custom_instruction TEXT;

-- Serves the regen lookup, which is on the hot path of every paid generation:
--   SELECT 1 FROM user_generations
--   WHERE user_id = $1 AND target_key = $2 AND type = $3 AND status = 'success' LIMIT 1
-- Partial on target_key IS NOT NULL so the historical rows (all NULL) stay out of the index.
CREATE INDEX IF NOT EXISTS idx_user_generations_target
  ON user_generations (user_id, target_key, type)
  WHERE target_key IS NOT NULL;
`;

export async function up(): Promise<{ keyed: number }> {
  await sql.unsafe(MIGRATION_SQL);
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM user_generations WHERE target_key IS NOT NULL
  `;
  return { keyed: Number((rows as any[])[0]?.n ?? 0) };
}

const invokedDirectly = process.argv[1] && process.argv[1].includes('010-generation-target-key');
if (invokedDirectly) {
  up()
    .then(async ({ keyed }) => {
      console.log(`✅ Migration 010 applied. ${keyed} generation row(s) currently carry a target_key.`);
      await sql.end();
    })
    .catch(async (err) => {
      console.error('❌ Migration 010 failed:', err);
      try { await sql.end(); } catch (_) { /* ignore */ }
      process.exit(1);
    });
}
