/**
 * Give back the credits keyword lists were charged in the current billing cycle.
 *
 * Keyword lists are free (generation.routes.ts, c2a29a4 / d6cc207), but a run used to cost 1
 * credit — and the live server went on charging until the fix was deployed. This finds those
 * debits and refunds each one through the caller's `refund` (refundCredits() in production),
 * which tops the credits back into the lots they came from with their original expiry.
 *
 * SCOPE — only debits made since the account's current cycle began. Older ones were spent in a
 * cycle whose credits have since been replaced by a refill, so refunding them would hand out
 * credits the account never lost from what it holds now.
 *
 * SAFE TO RE-RUN — every refund is written with REFUND_REASON and the debit's generation_id, and a
 * debit that already has such a row is never selected again. A debit with no generation_id cannot
 * be matched that way, so it is reported and left alone rather than risk refunding it twice.
 *
 * Kept free of the database module so tests can drive it with test/helpers/fake-sql.ts; the
 * runner is scripts/refund-keyword-charges.ts.
 */

/** Written on every refund row; also what makes a refunded debit recognisable. */
export const REFUND_REASON = 'Refund: keyword lists are free';

/** Any tagged-template SQL client (postgres.js in production, FakeSql in tests). */
export type SqlTag = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export interface KeywordDebit {
  id: string;
  user_id: number;
  website_id: number | null;
  generation_id: string | null;
  amount: number;
  created_at: Date | string;
}

export type RefundFn = (
  userId: number,
  amount: number,
  reason: string,
  websiteId: number | null,
  generationId: string,
) => Promise<void>;

export interface Selection {
  /** Debits to refund. */
  refundable: KeywordDebit[];
  /** In scope but without a generation_id — never refunded automatically (see SAFE TO RE-RUN). */
  unmatched: KeywordDebit[];
}

export interface RefundSummary {
  apply: boolean;
  debits: number;
  credits: number;
  /** user id → { debits, credits } */
  byUser: Map<number, { debits: number; credits: number }>;
  unmatched: number;
}

/** Keyword debits from each account's current cycle that have not been refunded yet. */
export async function findRefundableKeywordDebits(sql: SqlTag, onlyUser: number | null = null): Promise<Selection> {
  const rows = await sql`
    SELECT ct.id, ct.user_id, ct.website_id, ct.generation_id, (-ct.delta)::int AS amount, ct.created_at
      FROM credit_transactions ct
      JOIN (SELECT user_id, MAX(cycle_started_at) AS cycle_start
              FROM credit_balances GROUP BY user_id) b ON b.user_id = ct.user_id
     WHERE ct.delta < 0
       AND (ct.reason LIKE 'Keyword research:%' OR ct.reason LIKE 'Plugin keyword:%')
       AND b.cycle_start IS NOT NULL
       AND ct.created_at >= b.cycle_start
       AND (${onlyUser}::int IS NULL OR ct.user_id = ${onlyUser}::int)
       AND NOT EXISTS (
             SELECT 1 FROM credit_transactions r
              WHERE r.user_id = ct.user_id
                AND r.delta > 0
                AND r.generation_id = ct.generation_id
                AND r.reason LIKE ${REFUND_REASON + '%'})
     ORDER BY ct.user_id, ct.created_at
  `;

  const debits: KeywordDebit[] = rows.map((r: any) => ({
    id: String(r.id),
    user_id: Number(r.user_id),
    website_id: r.website_id == null ? null : Number(r.website_id),
    generation_id: r.generation_id == null || String(r.generation_id) === '' ? null : String(r.generation_id),
    amount: Number(r.amount),
    created_at: r.created_at,
  }));

  return {
    refundable: debits.filter((d) => d.generation_id !== null && d.amount > 0),
    unmatched: debits.filter((d) => d.generation_id === null),
  };
}

/**
 * Refund every selected debit when `apply` is true; otherwise only total them up.
 * Debits are refunded one by one, each in its own transaction (refundCredits), so a failure part
 * way leaves the rest refundable on the next run rather than half-applied.
 */
export async function refundKeywordDebits(selection: Selection, refund: RefundFn, apply: boolean): Promise<RefundSummary> {
  const byUser = new Map<number, { debits: number; credits: number }>();
  let credits = 0;

  for (const d of selection.refundable) {
    const u = byUser.get(d.user_id) ?? { debits: 0, credits: 0 };
    u.debits += 1;
    u.credits += d.amount;
    byUser.set(d.user_id, u);
    credits += d.amount;

    if (apply) {
      await refund(d.user_id, d.amount, REFUND_REASON, d.website_id, d.generation_id as string);
    }
  }

  return {
    apply,
    debits: selection.refundable.length,
    credits,
    byUser,
    unmatched: selection.unmatched.length,
  };
}
