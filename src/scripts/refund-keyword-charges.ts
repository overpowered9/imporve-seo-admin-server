/**
 * Refund the credits keyword lists were charged in each account's current billing cycle.
 *
 *   npm run refund:keyword-charges              # DRY RUN — prints what would be refunded
 *   npm run refund:keyword-charges -- --apply
 *   npm run refund:keyword-charges -- --user 36 --apply
 *
 * Keyword lists are free; before that fix was deployed every Keyword Generator run cost 1 credit.
 * Selection and the safe-to-re-run rule live in services/billing/keyword-refunds.ts. Each refund
 * goes through refundCredits(), the same compensating path a failed generation uses: credits go
 * back into the lots they were drawn from (keeping their expiry), the balance cache is re-synced,
 * and a positive ledger row is written.
 *
 * Run it only once the free-keyword build is live (GET /health shows keyword_lists: "free"),
 * otherwise new charges keep arriving behind it. Dry run is the default; it prints per-account
 * totals only — no emails, no keywords.
 */
import sql from '../data/db.js';
import { refundCredits, ISEO_CREDIT_TYPE } from '../models/user.models.js';
import { findRefundableKeywordDebits, refundKeywordDebits, type SqlTag } from '../services/billing/keyword-refunds.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const userArgIndex = process.argv.indexOf('--user');
  const onlyUser = userArgIndex >= 0 ? Number(process.argv[userArgIndex + 1]) : null;
  if (onlyUser !== null && !Number.isInteger(onlyUser)) {
    throw new Error('--user needs a numeric user id');
  }

  console.log(apply
    ? '⚠️  APPLY MODE — keyword charges will be refunded.\n'
    : '🔍 DRY RUN — nothing will be written. Re-run with --apply.\n');

  const selection = await findRefundableKeywordDebits(sql as unknown as SqlTag, onlyUser);
  const summary = await refundKeywordDebits(
    selection,
    // credit_transactions.generation_id is text; refundCredits() types it as a number only
    // because it predates string ids — it writes the value straight through.
    (userId, amount, reason, websiteId, generationId) =>
      refundCredits(userId, ISEO_CREDIT_TYPE, amount, reason, websiteId ?? undefined, generationId as unknown as number),
    apply,
  );

  for (const [userId, u] of summary.byUser) {
    console.log(`  user ${userId}: ${u.debits} keyword run(s), ${u.credits} credit(s) ${apply ? 'refunded' : 'to refund'}`);
  }
  console.log(`\n${apply ? 'Refunded' : 'Would refund'} ${summary.credits} credit(s) for ${summary.debits} keyword run(s) across ${summary.byUser.size} account(s).`);
  if (summary.unmatched > 0) {
    console.log(`⚠️  ${summary.unmatched} charge(s) have no generation_id and were left alone — they cannot be matched to a refund, so re-running could refund them twice. Handle by hand if needed.`);
  }
  if (apply && summary.debits > 0) {
    console.log('Re-run without --apply to confirm nothing is left. refundCredits() logs, rather than throws, a refund it could not write.');
  }
}

main()
  .catch((err) => {
    console.error('❌ refund-keyword-charges failed:', err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
