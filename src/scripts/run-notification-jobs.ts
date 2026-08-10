/**
 * Manual runner for the notification jobs.  (BILL-007, BILL-008 runbook)
 *
 *   npm run notify                      # DRY RUN — who WOULD be emailed
 *   npm run notify -- --apply           # queue for real
 *   npm run notify -- --job credit_expiry --apply
 *
 * Dry run is the default and prints the full recipient list, because both
 * tickets make it mandatory and because a wrong predicate here emails real
 * customers. Read the list before using --apply.
 */
import sql from '../data/db.js';
import { runAllNotificationJobs } from '../services/billing/notification-jobs.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const jobIndex = process.argv.indexOf('--job');
  const onlyJob = jobIndex >= 0 ? process.argv[jobIndex + 1] : null;

  console.log(apply
    ? '⚠️  APPLY MODE — emails will be queued for sending.\n'
    : '🔍 DRY RUN — nothing will be queued or claimed. Re-run with --apply.\n');

  const results = await runAllNotificationJobs(sql, { dryRun: !apply });

  for (const r of results) {
    if (onlyJob && !r.name.startsWith(onlyJob)) continue;

    console.log(`── ${r.name} ${'─'.repeat(Math.max(0, 44 - r.name.length))}`);
    console.log(`   scanned:${r.scanned} queued:${r.queued} duplicate:${r.skippedDuplicate} errors:${r.errors}`);

    if (r.wouldEmail.length > 0) {
      console.log('   would email:');
      for (const w of r.wouldEmail) {
        console.log(`     user ${String(w.userId).padStart(5)}  ${w.email.padEnd(32)} ${w.dedupeKey}`);
      }
    }
    console.log('');
  }

  const totalWould = results.reduce((n, r) => n + r.wouldEmail.length, 0);
  const totalQueued = results.reduce((n, r) => n + r.queued, 0);
  console.log(apply
    ? `Queued ${totalQueued} email(s). The worker will send them unless BILLING_EMAILS_ENABLED=false.`
    : `${totalWould} email(s) would be sent. Review the list above, then re-run with --apply.`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('❌ Notification run failed:', err);
  try { await sql.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
