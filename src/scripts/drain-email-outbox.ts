/**
 * Manually drain the email outbox.  (BILL-006 runbook)
 *
 *   npm run email:drain             # DRY RUN — render and report, send nothing
 *   npm run email:drain -- --apply
 *
 * The on-call entry point: use it to flush a backlog after an ESP outage, or to
 * verify what is queued before enabling the worker for the first time.
 *
 * NOTE: dry run still CLAIMS jobs (it marks them 'sending' then leaves them),
 * unlike the notification dry run. Use it on a queue you intend to drain.
 */
import sql from '../data/db.js';
import { processEmailBatch } from '../services/billing/email-worker.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const limitIndex = process.argv.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 25;

  console.log(apply ? '⚠️  APPLY MODE — emails will be sent.\n' : '🔍 DRY RUN — rendering only.\n');

  const counts = await processEmailBatch(sql, { limit, dryRun: !apply });
  console.log(`sent:${counts.sent} failed:${counts.failed} suppressed:${counts.suppressed} dead:${counts.deadLettered}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Drain failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
