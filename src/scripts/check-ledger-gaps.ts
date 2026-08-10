/**
 * One-shot ledger gap check.  (BILL-004 monitoring)
 *
 *   npm run monitor:ledger-gaps
 *   npm run monitor:ledger-gaps -- --grace 60
 *
 * Exits 1 when gaps are found, so it can be wired to a cron/alerting system
 * without needing log parsing. The same check also runs hourly in-process when
 * LEDGER_MONITOR_ENABLED=true; this is the manual/on-call entry point.
 */
import sql from '../data/db.js';
import { reportLedgerGaps } from '../services/billing/ledger-monitor.js';

const graceIndex = process.argv.indexOf('--grace');
const graceMinutes = graceIndex >= 0 ? Number(process.argv[graceIndex + 1]) : 15;

reportLedgerGaps(sql, { graceMinutes })
  .then(async (count) => {
    await sql.end();
    process.exit(count > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('❌ Ledger gap check failed:', err);
    try { await sql.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
