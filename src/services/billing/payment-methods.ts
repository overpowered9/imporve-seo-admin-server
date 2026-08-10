/**
 * Default payment method: choosing it, keeping it, and keeping the two copies
 * of it in agreement.  (BILL-001)
 *
 * ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────
 * The reported symptom was "add a card, retry the upgrade, get told no default
 * payment method has been selected". Four hypotheses were offered; here is what
 * each turned out to be, having read the code rather than guessed:
 *
 *  1. "Card attached but never made default."  CONFIRMED, historically. The
 *     promotion happened ONLY in the setup_intent.succeeded webhook, and only
 *     when the customer had exactly one card. An earlier round added a shared
 *     helper called on the read and upgrade paths, which fixed the common case.
 *
 *  2. "A local is_default column is not written."  CONFIRMED, and stronger than
 *     stated: there was no local column at all. The default existed only in
 *     Stripe, so there were not two copies to disagree — there was one copy and
 *     no way to detect it was wrong. Migration 006 adds the local side.
 *
 *  3. "Client holds a stale payment-methods list."  CONFIRMED as a live race,
 *     though not the one described. The CMS fires the promotion call
 *     fire-and-forget on returning from Stripe and navigates immediately
 *     (Dashboard.js). A user who clicks upgrade quickly can beat it.
 *
 *  4. "Handler checks the wrong field / DB and provider diverge."  CONFIRMED
 *     for one path: /change-plan never ensured a default at all. An existing
 *     subscriber whose default card had been detached got a raw Stripe error
 *     from the proration invoice instead of an actionable message.
 *
 * ── WHY THE CLAIM IS TAKEN UNDER A ROW LOCK ─────────────────────────────────
 * Two concurrent "add card" requests both used to read "no default", both pick
 * a card, and both write to Stripe. Stripe has a single field so you never end
 * up with two defaults — but you do end up with the LOSER's card as default,
 * silently, which is the same bug wearing a different hat.
 *
 * The local row is therefore claimed with SELECT … FOR UPDATE inside a
 * transaction, and both the Stripe read and the Stripe write happen inside that
 * transaction. The second request blocks until the first commits, then reads a
 * default already in force and does nothing. That is what makes "cannot produce
 * two defaults or zero defaults" true rather than merely likely.
 *
 * Reading Stripe INSIDE the lock rather than before it is deliberate, and was
 * the one thing an early version of this got wrong: with a pre-lock snapshot,
 * both requests see "no default", and the second re-writes the first's choice
 * after waiting politely for its turn. A lock is only worth taking if what you
 * read under it is current.
 *
 * Holding a transaction across HTTP calls is normally a smell, so the common
 * case never does it: when Stripe and our record already agree there is nothing
 * to serialise, and the function returns before opening a transaction at all.
 * Only a change takes the lock.
 *
 * ── ATOMICITY, STATED HONESTLY ──────────────────────────────────────────────
 * A database and a remote API cannot share a transaction. What is guaranteed:
 * if the Stripe write fails, the local write is rolled back, so we never record
 * a default the provider does not have. The reverse — Stripe accepts the write
 * and our commit then fails — leaves Stripe ahead of us, which the reconciler
 * below repairs on the next read, because Stripe is the source of truth.
 */
import type Stripe from 'stripe';

/** Just enough of postgres.js to be substitutable in tests. */
export type SqlLike = {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
  begin<T>(fn: (tx: any) => Promise<T>): Promise<T>;
};

export interface PaymentMethodDeps {
  sql: SqlLike;
  stripe: Pick<Stripe, 'customers' | 'paymentMethods'> | any;
}

/** The shape every caller needs — never more of the card than this. */
export interface DefaultPaymentMethod {
  id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
}

/**
 * Reduce a Stripe PaymentMethod to the fields we are allowed to keep.
 *
 * Brand and last four are outside PCI's cardholder-data scope and are what
 * every receipt, confirm dialog and email needs. Nothing else from `card` is
 * copied — in particular there is no path here for a PAN or CVC to be
 * persisted, logged or returned.
 */
export const describePaymentMethod = (pm: any): DefaultPaymentMethod => ({
  id: pm.id,
  brand: pm.card?.brand ?? null,
  last4: pm.card?.last4 ?? null,
  exp_month: pm.card?.exp_month ?? null,
  exp_year: pm.card?.exp_year ?? null,
});

/**
 * Pick which card SHOULD be the default, given everything we know.
 *
 * Pure, so the precedence rules are testable without a database or a Stripe
 * account. Precedence, highest first:
 *
 *   1. Stripe's current default, if that card is still attached. Stripe is the
 *      source of truth and a default already in force outranks any preference —
 *      it may have been chosen deliberately by the user.
 *   2. Our local record, if that card is still attached. Covers "Stripe lost it"
 *      (e.g. the default was cleared when another card was detached).
 *   3. The card the caller just added.
 *   4. The most recently created attached card.
 *
 * Returns null only when the customer genuinely has no cards.
 */
export function chooseDefaultPaymentMethod(params: {
  attached: any[];
  stripeDefaultId?: string | null;
  localDefaultId?: string | null;
  preferredId?: string | null;
}): any | null {
  const { attached, stripeDefaultId, localDefaultId, preferredId } = params;
  if (attached.length === 0) return null;

  const byId = (id?: string | null) => (id ? attached.find((pm) => pm.id === id) ?? null : null);

  return (
    byId(stripeDefaultId)
    ?? byId(localDefaultId)
    ?? byId(preferredId)
    ?? attached.slice().sort((a, b) => (b.created || 0) - (a.created || 0))[0]
  );
}

const readStripeDefaultId = (customer: any): string | null => {
  const existing = customer?.invoice_settings?.default_payment_method;
  if (!existing) return null;
  return typeof existing === 'string' ? existing : existing.id ?? null;
};

/**
 * Make sure the customer has a default payment method, and that our copy of it
 * matches Stripe's. Idempotent: calling it twice changes nothing the second
 * time, which is why it is safe on every read path.
 *
 * @param preferredPaymentMethodId the card the user just added, if any
 * @returns the default in force afterwards, or null if they have no cards
 */
export async function ensureDefaultPaymentMethod(
  deps: PaymentMethodDeps,
  userId: number,
  customerId: string,
  preferredPaymentMethodId?: string | null,
): Promise<DefaultPaymentMethod | null> {
  const { sql, stripe } = deps;

  const readStripeState = async () => {
    const [customer, cardList] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.paymentMethods.list({ customer: customerId, type: 'card' }),
    ]);
    return { attached: cardList?.data ?? [], stripeDefaultId: readStripeDefaultId(customer) };
  };

  // ── Fast path: nothing to change ────────────────────────────────────────
  // This runs on every payment-methods read, so the common case must not take
  // a row lock. When Stripe and our record already name the same attached
  // card, there is nothing to serialise against.
  {
    const { attached, stripeDefaultId } = await readStripeState();
    const local = await getLocalDefaultPaymentMethod(sql, userId);
    const settled = stripeDefaultId
      && local?.id === stripeDefaultId
      && attached.find((pm: any) => pm.id === stripeDefaultId);
    if (settled) return describePaymentMethod(settled);
    if (attached.length === 0 && !local) return null;
  }

  // ── Slow path: something must change, so serialise it ───────────────────
  return sql.begin(async (tx: any) => {
    // The lock. A second concurrent caller waits here until we commit.
    const rows = await tx`
      SELECT id, default_payment_method_id
      FROM   users
      WHERE  id = ${userId}
      FOR UPDATE
    `;
    const localDefaultId: string | null = rows[0]?.default_payment_method_id ?? null;

    // Re-read Stripe INSIDE the lock. Reading it before would mean deciding on
    // a snapshot taken before we had the right to act on it: two concurrent
    // "add card" requests would each hold their own pre-lock view showing no
    // default, and the second would redundantly re-write the first's choice.
    // The lock is only worth taking if what we read under it is current.
    const { attached, stripeDefaultId } = await readStripeState();

    const chosen = chooseDefaultPaymentMethod({
      attached,
      stripeDefaultId,
      localDefaultId,
      preferredId: preferredPaymentMethodId,
    });

    // No cards: clear any stale local record so nothing claims a card that is
    // no longer there. This is the state after removing your only card.
    if (!chosen) {
      if (localDefaultId) {
        await tx`
          UPDATE users
          SET    default_payment_method_id = NULL,
                 default_payment_method_brand = NULL,
                 default_payment_method_last4 = NULL,
                 default_payment_method_exp_month = NULL,
                 default_payment_method_exp_year = NULL,
                 default_payment_method_set_at = NULL,
                 updated_at = NOW()
          WHERE  id = ${userId}
        `;
      }
      return null;
    }

    const described = describePaymentMethod(chosen);

    // Already correct on both sides — the common case on every read. Do no
    // writes at all, so this stays cheap enough to call from a GET.
    if (stripeDefaultId === chosen.id && localDefaultId === chosen.id) {
      return described;
    }

    // Local first, then Stripe. If Stripe rejects, this transaction rolls back
    // and we are left recording no default rather than a default the provider
    // does not have — the direction of failure that keeps the two honest.
    await tx`
      UPDATE users
      SET    default_payment_method_id = ${described.id},
             default_payment_method_brand = ${described.brand},
             default_payment_method_last4 = ${described.last4},
             default_payment_method_exp_month = ${described.exp_month},
             default_payment_method_exp_year = ${described.exp_year},
             default_payment_method_set_at = NOW(),
             updated_at = NOW()
      WHERE  id = ${userId}
    `;

    if (stripeDefaultId !== chosen.id) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: chosen.id },
      });
    }

    return described;
  });
}

/**
 * The default we hold locally, with no Stripe round trip.
 *
 * Used by the proration preview and the billing emails, both of which need to
 * name the card that will be charged ("Visa ••4242"). Going to Stripe for that
 * would make a slow provider into a blocked upgrade, which is precisely the
 * failure mode BILL-003 says must not happen.
 */
export async function getLocalDefaultPaymentMethod(
  sql: SqlLike,
  userId: number,
): Promise<DefaultPaymentMethod | null> {
  const rows = await sql`
    SELECT default_payment_method_id    AS id,
           default_payment_method_brand AS brand,
           default_payment_method_last4 AS last4,
           default_payment_method_exp_month AS exp_month,
           default_payment_method_exp_year  AS exp_year
    FROM   users
    WHERE  id = ${userId}
    LIMIT  1
  `;
  const row = rows[0];
  if (!row?.id) return null;
  return {
    id: row.id,
    brand: row.brand ?? null,
    last4: row.last4 ?? null,
    exp_month: row.exp_month ?? null,
    exp_year: row.exp_year ?? null,
  };
}

/**
 * Turn a Stripe error into something a customer can act on.
 *
 * BILL-001 asks that failure messaging is "specific and actionable … and never
 * a dead end". The upgrade path already did this; /change-plan did not — it
 * returned `Stripe error: <raw message>` with a 500, so a declined card during
 * a mid-cycle upgrade read as a server fault and offered nothing to do next.
 *
 * `retryable` tells the CMS whether to keep the user in the flow with the card
 * form open (a decline: try another card) or send them somewhere else (a
 * configuration fault: contact support).
 */
export interface FriendlyPaymentError {
  status: number;
  error: string;
  error_category: string;
  requires_payment_method: boolean;
  retryable: boolean;
  stripe_error_code?: string;
}

export function describePaymentError(err: any): FriendlyPaymentError | null {
  if (!err) return null;

  if (err.type === 'StripeCardError') {
    const code = err.code as string | undefined;
    const map: Record<string, { error: string; category: string }> = {
      card_declined: {
        error: 'Your card was declined. Try another card, or contact your bank — they can usually approve it straight away.',
        category: 'card_declined',
      },
      expired_card: {
        error: 'That card has expired. Add a different card to continue.',
        category: 'expired_card',
      },
      incorrect_cvc: {
        error: "The security code didn't match. Check the three digits on the back of the card and try again.",
        category: 'incorrect_cvc',
      },
      incorrect_number: {
        error: "That card number isn't valid. Check the digits and try again.",
        category: 'incorrect_number',
      },
      processing_error: {
        error: 'Your bank had trouble processing that card. Try again in a moment, or use a different card.',
        category: 'processing_error',
      },
      insufficient_funds: {
        error: 'That card has insufficient funds. Try a different card.',
        category: 'insufficient_funds',
      },
      authentication_required: {
        error: 'Your bank needs to verify this payment. Try again and complete the verification step.',
        category: 'authentication_required',
      },
    };
    const hit = (code && map[code]) || {
      error: err.message || 'That card could not be charged. Check the details and try again.',
      category: 'card_error',
    };
    return {
      status: 402,
      error: hit.error,
      error_category: hit.category,
      requires_payment_method: true,
      // Every card error is worth another attempt with a different card.
      retryable: true,
      stripe_error_code: code,
    };
  }

  if (err.code === 'resource_missing') {
    return {
      status: 402,
      error: 'We could not find that saved card. Add a payment method and try again.',
      error_category: 'payment_method_missing',
      requires_payment_method: true,
      retryable: true,
      stripe_error_code: err.code,
    };
  }

  // Not a payment problem — let the caller handle it as a genuine server error
  // rather than telling the customer to check a card that is fine.
  return null;
}
