/**
 * Re-queue emails that were blocked or lost by the "undefined payload" bug.
 *
 *   npm run email:requeue              # DRY RUN — report only
 *   npm run email:requeue -- --apply
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * Receipts were queued with a payload that came back out of Postgres as a string
 * instead of an object, so every field rendered as `undefined`. Two populations
 * exist in email_sends:
 *
 *   1. Rows the new guard will dead-letter on the next worker pass, because the
 *      render still contains placeholder tokens.
 *   2. Rows already marked `sent` whose payload is a string — those went to a
 *      customer as "Welcome to undefined". They are REPORTED, never re-sent
 *      automatically: a duplicate receipt is its own kind of wrong, and whether
 *      to apologise and resend is a judgement call, not a migration.
 *
 * normalizePayload() rescues any payload that is still recoverable, so a row
 * reset to `pending` now renders correctly. A row whose payload is genuinely
 * empty cannot be rescued — there is nothing to render from — and is reported
 * rather than reset, because resetting it just re-blocks it on the next pass.
 */
import sql from '../data/db.js';

const APPLY = process.argv.includes('--apply');

/** Is this payload usable by a renderer? */
const recoverable = (raw: unknown): boolean => {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return false; }
  }
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0;
};

async function main() {
  console.log(APPLY ? '⚠️  APPLY MODE — rows will be re-queued.\n' : '🔍 DRY RUN — nothing will be written.\n');

  // jsonb_typeof tells us what actually got stored, which is the whole question.
  const rows = await sql`
    SELECT id, user_id, recipient, template, event_key, status, attempts, last_error,
           jsonb_typeof(payload) AS kind,
           payload
    FROM   email_sends
    ORDER  BY id DESC
    LIMIT  1000
  `;

  const stringScalars = rows.filter((r: any) => r.kind === 'string');
  const emptyObjects = rows.filter((r: any) => r.kind === 'object' && Object.keys(r.payload || {}).length === 0);

  console.log(`Scanned ${rows.length} row(s).`);
  console.log(`  payload stored as a jsonb STRING scalar : ${stringScalars.length}  ← the bug`);
  console.log(`  payload stored as an empty object       : ${emptyObjects.length}`);
  console.log(`  payload stored correctly                : ${rows.length - stringScalars.length - emptyObjects.length}\n`);

  const alreadySent = stringScalars.filter((r: any) => r.status === 'sent');
  if (alreadySent.length > 0) {
    console.warn(`⚠️  ${alreadySent.length} broken email(s) were ALREADY DELIVERED. Not re-sending — decide per case:`);
    for (const r of alreadySent) {
      console.warn(`     id=${r.id} user=${r.user_id} ${r.recipient} ${r.template}/${r.event_key}`);
    }
    console.warn('');
  }

  // Anything not yet successfully delivered, whose payload we can still rescue.
  const fixable = rows.filter((r: any) =>
    r.status !== 'sent' && r.status !== 'suppressed' && recoverable(r.payload));

  if (fixable.length === 0) {
    console.log('✅ Nothing to re-queue.');
    await sql.end();
    return;
  }

  console.log(`${fixable.length} undelivered row(s) can be rescued and re-queued:`);
  for (const r of fixable) {
    console.log(`   id=${r.id} ${r.status} attempts=${r.attempts} ${r.template}/${r.event_key} → ${r.recipient}`);
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to reset these to pending.');
    await sql.end();
    return;
  }

  // attempts reset to 0 as well: the previous attempts were spent on a fault
  // that has been fixed, so they should not count against MAX_ATTEMPTS.
  const ids = fixable.map((r: any) => r.id);
  await sql`
    UPDATE email_sends
    SET    status = 'pending', attempts = 0, next_attempt_at = NOW(),
           last_error = NULL, updated_at = NOW()
    WHERE  id = ANY(${ids})
  `;
  console.log(`\n✅ Re-queued ${ids.length} row(s). The worker will send them within a minute.`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Re-queue failed:', err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
});
