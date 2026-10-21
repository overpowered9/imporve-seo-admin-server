import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import sql from '../data/db.js';
import {
  findUserByEmail,
  getUserCreditBalances,
  getUserSubscription,
  getAllSubscriptionPlans,
  changePlan,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  refillPlanCredits,
  addPurchasedCredits,
  suspendPlanCredits,
  getFreePlanId,
  hasBillingAddress,
  syncAddressFromStripe,
  previewUpgradeCreditGrant,
  getLiveBalance,
  ISEO_CREDIT_TYPE
} from '../models/user.models.js';
// The plan's monthly credit allotment, for the quote branches that do not go
// through previewUpgradeCreditGrant (a first subscription, a scheduled
// downgrade). Same function the grant itself uses.
import {
  grantForPlanSlug,
  creditPackages,
  creditPackagesForPlan,
  creditPackageById,
  creditPackPrice,
  creditsPerPiece,
  PURCHASED_CREDIT_LIFETIME_MONTHS,
  type CreditPackage,
} from '../config/credits.config.js';

/**
 * Map a legacy raw quantity onto a package.
 *
 * Chosen as "the smallest package that covers what they asked for", falling back
 * to the largest — so an old client can never buy FEWER credits than the
 * quantity it requested, which would be taking money for less than was ordered.
 */
const nearestPackageFor = (quantity: number): CreditPackage => {
  const all = creditPackages();
  return all.find((p) => p.credits >= quantity) ?? all[all.length - 1];
};

export type BillingInterval = 'month' | 'year';

/**
 * The Stripe price for a plan on a given interval.
 *
 * One resolver for every path that starts or changes a subscription, so the
 * interval cannot be honoured in checkout and quietly dropped in change-plan —
 * which would move an annual customer onto monthly billing as a side effect of
 * switching plan.
 *
 * Falls back to monthly when a yearly price is not configured for that plan,
 * rather than failing: a plan without an annual price should still be
 * purchasable. The caller is told which interval it actually got.
 */
const priceForPlan = (
  plan: { stripe_price_id?: string | null; stripe_price_id_yearly?: string | null },
  interval: BillingInterval,
): { priceId: string | null; interval: BillingInterval } => {
  if (interval === 'year' && plan.stripe_price_id_yearly) {
    return { priceId: plan.stripe_price_id_yearly, interval: 'year' };
  }
  return { priceId: plan.stripe_price_id ?? null, interval: 'month' };
};

/**
 * ── THE BILLING-ADDRESS GATE IS GONE, DELIBERATELY ─────────────────────────
 *
 * There used to be a blockedForMissingAddress() guard here, refusing every
 * money-moving request from an account with no address on file, plus a signup
 * field, a dashboard reminder and a dialog in the CMS to get one.
 *
 * All of it existed to satisfy Stripe. Stripe collects the address itself at
 * checkout now (billing_address_collection: 'required' on every session
 * below), writes it onto the Customer, and lets the user edit it later in the
 * billing portal — so the address arrives at the moment it is actually needed,
 * from the system that needs it, and four places asking for it in advance were
 * four places to get it wrong.
 *
 * What replaced it: the collection flags on the sessions, syncAddressFromStripe
 * keeping our copy in step from the checkout.session.completed and
 * customer.updated webhooks, and POST /billing-portal for later edits.
 *
 * hasBillingAddress() is still exported and still read by GET /users/address,
 * which reports whether we hold one. It no longer BLOCKS anything.
 */
import { sendEmail, emailTemplates } from '../services/email.service.js';
import {
  ensureDefaultPaymentMethod as ensureDefaultPaymentMethodFor,
  getLocalDefaultPaymentMethod,
  describePaymentError,
  type DefaultPaymentMethod,
} from '../services/billing/payment-methods.js';
import { enqueueEmail } from '../services/billing/email-outbox.js';
import { publicPricing } from '../services/credit-pricing.js';
import {
  clearScheduledCancellation,
  releaseOrphanedSchedules,
  isLiveStatus,
} from '../services/billing/subscription-state.js';
import { periodEndOf, periodEndOrWarn, periodStartOf } from '../services/billing/subscription-period.js';
import type { RecordTransactionInput } from '../services/billing/transactions.js';
import {
  recordTransaction,
  transactionsFromInvoice,
  subscriptionIdFromInvoice,
  settlePendingPlanChanges,
  isRenewalInvoice,
  fetchCheckoutReceiptUrl,
  fetchFirstInvoiceCharge,
  readLedger,
} from '../services/billing/transactions.js';
import {
  previewUpgrade,
  recordDisclosure,
  settleDisclosure,
  isProrationLine,
  chargeProrationNow,
  dayAlignedProrationDate,
  groupProrationLines,
  nameChangeGroups,
  type ProrationQuote,
} from '../services/billing/proration.js';
import {
  describePlanUpgraded,
  describePlanDowngradeScheduled,
  describeCreditPurchase,
  describePaymentFailed,
  describeSubscriptionStarted,
  describeSubscriptionCancelled,
  describeSubscriptionReactivated,
  describeSubscriptionEnded,
  describePlanDowngraded,
  describeRefund,
  planUpgradeConfirmationParts,
  planDowngradeConfirmationParts,
  reactivationConfirmation,
} from '../services/billing/descriptions.js';

const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover'
});

/**
 * The dependencies the billing service modules take explicitly.
 *
 * Passing them in rather than importing them there is what makes that logic
 * testable: the tests hand it a fake Postgres and a fake Stripe and assert on
 * the resulting state. This object is the single place the real ones are bound.
 */
const billingDeps = { sql, stripe };

/**
 * Build the Stripe request options carrying an idempotency key. (BILL-002)
 *
 * Stripe deduplicates on this key for 24 hours, so a double-clicked confirm
 * button, a retried request after a network timeout, and a user hammering the
 * back button all resolve to ONE subscription and ONE charge.
 *
 * The key is NAMESPACED with the operation and our user id rather than passed
 * through as the client sent it. A raw client-supplied key is a cross-account
 * hazard: keys are unique per Stripe account, not per customer, so one user
 * replaying another user's key would collide with that user's operation and
 * receive its cached response. Namespacing makes collisions structurally
 * impossible while keeping the client's retry semantics.
 *
 * Returns undefined when no key was supplied, which leaves Stripe's behaviour
 * exactly as it was — the endpoint stays usable by callers that predate this.
 */
const idempotencyKeyFor = (
  operation: string,
  userId: number,
  clientKey?: string,
): { idempotencyKey: string } | undefined =>
  clientKey ? { idempotencyKey: `${operation}:${userId}:${clientKey}` } : undefined;

/** Convenience wrapper so call sites read the same as they did before. */
const ensureDefaultPaymentMethod = (
  userId: number,
  customerId: string,
  preferredPaymentMethodId?: string | null,
): Promise<DefaultPaymentMethod | null> =>
  ensureDefaultPaymentMethodFor(billingDeps, userId, customerId, preferredPaymentMethodId);

/**
 * Append the Stripe checkout session id to a success URL using the correct
 * separator. Stripe replaces {CHECKOUT_SESSION_ID} at redirect time.
 * Using a fixed `?` breaks URLs that already contain a query string.
 */
const withSessionId = (url: string): string => {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}session_id={CHECKOUT_SESSION_ID}`;
};

/** Where billing emails send the user back to. */
const CMS_BILLING_URL = `${process.env.CMS_BASE_URL || 'https://account.improveseoplugin.com'}/credits`;

const firstNameOf = (name?: string | null, email?: string | null): string =>
  (name || '').trim().split(/\s+/)[0] || (email || '').split('@')[0] || 'there';

const formatCents = (cents: number, currency = 'usd'): string => {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format((cents || 0) / 100);
  } catch (_) {
    return `${((cents || 0) / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};

/**
 * Queue a billing email. (BILL-006)
 *
 * REPLACES an inline sendEmail wrapped in try/catch. That satisfied "never fail
 * the billing operation" by making a failed receipt indistinguishable from a
 * delivered one: no record, no retry, and no way to answer "did this user get
 * their receipt?".
 *
 * Now it writes a row to the outbox and returns. The worker sends it, retries
 * with backoff, and dead-letters with an alert. Enqueueing is idempotent on
 * (template, eventKey), so a replayed webhook cannot produce a second email —
 * which is why call sites need no guard of their own.
 *
 * `eventKey` MUST identify the billing event, not the moment: keying on a
 * timestamp would make every retry a new email.
 */
const queueBillingEmail = async (
  userId: number,
  template: string,
  eventKey: string,
  buildPayload: (firstName: string) => Record<string, unknown>,
  category: 'transactional' | 'lifecycle' = 'transactional',
): Promise<void> => {
  try {
    const rows = await sql`SELECT email, name FROM users WHERE id = ${userId} LIMIT 1`;
    const user = rows[0] as any;
    if (!user?.email) return;
    await enqueueEmail(sql, {
      userId,
      recipient: user.email,
      template,
      category,
      eventKey,
      payload: buildPayload(firstNameOf(user.name, user.email)),
    });
  } catch (err) {
    // Queueing must never break billing; the money has already moved.
    console.error(`⚠️ Could not queue ${template} for user ${userId}:`, err);
  }
};

/**
 * Create/refresh a user's subscription row and refill their credits in the DB.
 *
 * This is intentionally idempotent (subscription row keyed on user_id, credit
 * balances REPLACED to the plan amount). It is called both synchronously when a
 * subscription is created via a saved card (so the user gets credits instantly,
 * regardless of webhook timing/health) and from the customer.subscription.created
 * webhook. Running both is safe — they converge to the same end state.
 */
const activateSubscriptionInDb = async (params: {
  userId: number;
  planId: number;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  /**
   * Stripe's period end, unix seconds — or null when it could not be read.
   *
   * Nullable deliberately. This used to take `current_period_end || now + 30
   * days`, and since that field moved onto the subscription ITEM the left side
   * was always undefined, so every row got a fabricated date. See
   * services/billing/subscription-period. Null now means "keep what is there",
   * because a stale date self-corrects on the next webhook and an invented one
   * never does.
   */
  nextBillingTimestamp: number | null;
  /** How this subscription bills. Recorded so the plan grid opens on the right
   *  side of the monthly/yearly toggle without asking Stripe. */
  billingInterval?: 'month' | 'year';
}): Promise<void> => {
  const { userId, planId, stripeSubscriptionId, stripeCustomerId, nextBillingTimestamp } = params;
  const billingInterval = params.billingInterval ?? 'month';

  await sql`
    INSERT INTO subscriptions (
      user_id, plan_id, status, stripe_subscription_id, stripe_customer_id, billing_interval, start_date, next_billing_date
    )
    VALUES (
      ${userId}, ${planId}, 'active', ${stripeSubscriptionId}, ${stripeCustomerId}, ${billingInterval}, NOW(),
      TO_TIMESTAMP(${nextBillingTimestamp}::double precision)
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
      plan_id = ${planId},
      status = 'active',
      stripe_subscription_id = ${stripeSubscriptionId},
      stripe_customer_id = ${stripeCustomerId},
      billing_interval = ${billingInterval},
      -- COALESCE, not an overwrite: an unreadable period must leave the date
      -- alone rather than blank a good one.
      next_billing_date = COALESCE(
        TO_TIMESTAMP(${nextBillingTimestamp}::double precision),
        subscriptions.next_billing_date
      ),
      cancel_at_period_end = FALSE,
      pending_plan_id = NULL,
      pending_plan_effective_date = NULL
  `;

  await sql`
    UPDATE users SET plan_id = ${planId}, updated_at = NOW() WHERE id = ${userId}
  `;

  const planResult = await sql`SELECT * FROM subscription_plans WHERE id = ${planId}`;
  // What the plan actually granted, carried to the ledger row below so Account
  // Activity's Credits column reads "+200" rather than "—". Taken from the
  // grant itself rather than re-derived from the plan here: two readings of an
  // allotment are two numbers that can disagree, and the one the customer sees
  // must be the one they received.
  let planCreditsGranted: number | null = null;
  if (planResult.length > 0) {
    // Reset the plan (included) credits; purchased top-ups are preserved.
    planCreditsGranted = await refillPlanCredits(userId, planResult[0], 'Subscription activated');
  }

  // ── Record the ledger row HERE, not only from invoice.payment_succeeded ──
  //
  // This is the same reasoning that made the plan_upgrade write synchronous
  // (see the comment at its call site in /change-plan): a customer converting
  // from Free Trial to a paid plan was charged and their subscription is
  // active in Stripe regardless of whether our webhook ever runs, so Account
  // Activity must not depend on it alone. It previously did — there was no
  // recordTransaction call anywhere on the path a NEW subscription takes
  // (this function, called from /subscribe-to-plan, /verify-session, and the
  // customer.subscription.created webhook), only on invoice.payment_succeeded,
  // which additionally no-ops silently if it arrives before the subscription
  // row above has been upserted (a real possible ordering, since Stripe does
  // not guarantee event order).
  //
  // Keyed `subscription_create:<subscription id>`, NOT `invoice:<invoice id>` —
  // deliberately a different key than transactionsFromInvoice would use for a
  // renewal or plan-change invoice, so the two can never collide, and matched
  // to what transactionsFromInvoice now uses for THIS specific case (see
  // transactions.ts) so the eventual invoice webhook settles this same row
  // in place — filling in the real amount/receipt via recordTransaction's
  // COALESCE upsert — rather than creating a second, redundant-looking row
  // for the same one-time event.
  //
  // OLD: "amountCents is unknown at this synchronous point (no invoice has
  // necessarily been read yet); the settle fills it in." It often never did —
  // the invoice webhook can arrive before the subscriptions row it looks up
  // exists, and is not retried — so QA saw a Grow signup with no amount and no
  // receipt. The first invoice is now read here; see fetchFirstInvoiceCharge.
  try {
    const firstCharge = await fetchFirstInvoiceCharge(stripe, stripeSubscriptionId);
    await recordTransaction(sql, {
      userId,
      type: 'subscription_create',
      description: describeSubscriptionStarted(planResult[0]?.name ?? null),
      status: 'succeeded',
      providerEventId: `subscription_create:${stripeSubscriptionId}`,
      providerObjectId: stripeSubscriptionId,
      planId,
      amountCents: firstCharge?.amountCents ?? null,
      currency: firstCharge?.currency ?? null,
      receiptUrl: firstCharge?.receiptUrl ?? null,
      creditType: planCreditsGranted === null ? null : ISEO_CREDIT_TYPE,
      creditDelta: planCreditsGranted,
    });
  } catch (ledgerError) {
    // recordTransaction never throws; this guards anything around it. A
    // ledger write must not fail a subscription that has already activated.
    console.error('⚠️ Could not record the new subscription in the ledger:', ledgerError);
  }

  // BILL-005 — a NEW subscription is the clearest possible statement that the
  // customer is not leaving. The UPSERT above already clears
  // cancel_at_period_end in our row; this clears the provider-side schedule
  // that would otherwise cancel them again later.
  await releaseOrphanedSchedules(stripe, stripeCustomerId);
};

/**
 * Apply a one-time credit top-up exactly once for a given checkout session.
 *
 * The claim is keyed on the *session id* (not the webhook event id) so the
 * webhook and the synchronous /verify-session endpoint can never double-credit:
 * whichever runs first wins the claim, the other no-ops.
 *
 * Returns true if this call applied the credits, false if it was already applied
 * (or the session lacked the metadata needed to apply it).
 */
const applyCreditTopupOnce = async (session: Stripe.Checkout.Session): Promise<boolean> => {
  const claimId = `topup_${session.id}`;

  const userId = parseInt(session.metadata?.user_id || '0');
  // Whatever type the checkout was created with, the credits land in the single ISEO pool.
  // Sessions started BEFORE the pool collapse carry 'images' | 'content' | 'keywords' in their
  // metadata and their webhook can arrive after this deploys. Those are credits somebody paid
  // for, so they are mapped onto the pool rather than rejected; the original label is kept only
  // to keep the ledger description recognisable.
  const legacyCreditType = session.metadata?.credit_type as string | undefined;
  const creditType = ISEO_CREDIT_TYPE;
  const quantity = parseInt(session.metadata?.quantity || '0');

  if (!userId || !legacyCreditType || !quantity) {
    // Claim the id purely to mark it dealt with, so a redelivery of the same
    // malformed session does not retry forever.
    await sql`
      INSERT INTO stripe_webhook_events (event_id, event_type, processed, processed_at, error_message)
      VALUES (${claimId}, 'credit_topup', true, NOW(), 'missing credit_topup metadata')
      ON CONFLICT (event_id) DO UPDATE
        SET processed = true, processed_at = NOW(), error_message = 'missing credit_topup metadata'
    `;
    return false;
  }

  // The webhook payload carries payment_intent as a bare id, so the receipt has
  // to be fetched. Without this every credit purchase landed in the ledger with
  // a null receipt_url and downloaded to an Account Activity CSV with an empty
  // Receipt column — on exactly the rows people expense. Returns null rather
  // than throwing: a missing receipt must not block credits already paid for.
  const receiptUrl = await fetchCheckoutReceiptUrl(stripe, session.id);

  const granted = await grantCreditPack({
    userId,
    credits: quantity,
    claimId,
    amountCents: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: session.currency || 'usd',
    providerObjectId: session.id,
    receiptUrl,
    // Stamped when the session was created, from the plan resolved server-side
    // at that moment — not re-derived here, where the customer may since have
    // subscribed and would retro-actively relabel a purchase they made on the
    // free rate.
    atFreeRate: session.metadata?.at_free_rate === 'true',
  });

  if (!granted) return false;

  // ── Credit pack receipt, Checkout path ────────────────────────────────────
  // Queued HERE rather than in the webhook case, because this function is also
  // reached from /verify-session when the browser comes back before the webhook
  // lands. Putting it at the grant means the receipt follows the credits
  // wherever they were granted from, and `granted` being true exactly once is
  // what keeps it to a single email.
  const packBalance = await getLiveBalance(userId).then((b) => b.total).catch(() => null);
  const packCard = await getLocalDefaultPaymentMethod(sql, userId).catch(() => null);
  const topupExpiry = new Date();
  topupExpiry.setMonth(topupExpiry.getMonth() + PURCHASED_CREDIT_LIFETIME_MONTHS);

  await queueBillingEmail(
    userId,
    'billing.credit_purchase',
    `credit_purchase:${session.id}`,
    (firstName) => ({
      firstName,
      packName: `${quantity.toLocaleString()} ISEO credits`,
      creditsAdded: `${quantity.toLocaleString()} credits`,
      newBalance: packBalance !== null
        ? `${Number(packBalance).toLocaleString()} credits`
        : `${quantity.toLocaleString()} credits added`,
      amountCharged: formatCents(
        typeof session.amount_total === 'number' ? session.amount_total : 0,
        session.currency || 'usd',
      ),
      cardBrand: packCard?.brand ?? null,
      cardLast4: packCard?.last4 ?? null,
      receiptUrl,
      expiresOn: topupExpiry.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      creditsUrl: CMS_BILLING_URL,
    }),
  );

  console.log(`✅ Applied top-up of ${quantity} ${creditType} credits to user ${userId} (session ${session.id})`);
  return true;
};

/**
 * Grant a bought credit pack, exactly once.
 *
 * The same body as applyCreditTopupOnce, with the Checkout Session lifted out
 * so a purchase paid on a saved card can grant identically. That path has no
 * session — it has a paid invoice — and duplicating the claim/grant/ledger
 * sequence for it would be two implementations of "the customer paid, give them
 * the credits", which is the last thing that should exist twice.
 *
 * `claimId` is the idempotency key: a repeat call with the same id is a no-op
 * and returns false, which is what makes a redelivered webhook safe.
 */
const grantCreditPack = async (params: {
  userId: number;
  credits: number;
  claimId: string;
  amountCents: number | null;
  currency: string | null;
  providerObjectId: string | null;
  receiptUrl: string | null;
  atFreeRate: boolean;
}): Promise<boolean> => {
  const claim = await sql`
    INSERT INTO stripe_webhook_events (event_id, event_type, processed)
    VALUES (${params.claimId}, 'credit_topup', false)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;

  // Someone else already claimed (and is applying / has applied) this purchase.
  if (claim.length === 0) return false;

  // Purchased, not plan: these persist across billing cycles and are never
  // wiped by a monthly refill.
  //
  // Guarded on its own: this is a real DB transaction (sql.begin in
  // addPurchasedCredits) and it CAN throw — a constraint violation on this
  // account's credit rows, a deadlock, anything. Left unguarded, that
  // exception used to propagate all the way out through chargeCreditPackOnCard
  // AFTER the card had already been charged, where it was read as "the charge
  // failed" and triggered a second, duplicate Checkout Session for money
  // already collected — see the comment at that call site.
  //
  // Releasing the claim here (rather than leaving it stuck at
  // processed:false forever, unretriable because ON CONFLICT DO NOTHING) is
  // safe specifically BECAUSE addPurchasedCredits is atomic: it throwing
  // means nothing was granted, so a later retry with the same claimId can
  // attempt the whole grant cleanly. This must NOT be done below this point —
  // once credits are granted, releasing the claim would let a retry grant
  // them again.
  try {
    await addPurchasedCredits(params.userId, ISEO_CREDIT_TYPE, params.credits, 'Credit purchase via Stripe');
  } catch (grantError) {
    console.error(
      `❌ Could not grant ${params.credits} purchased credits to user ${params.userId} `
      + `(claim ${params.claimId}) — releasing the claim so this can be retried. `
      + `The customer was already charged; do not charge them again.`,
      grantError,
    );
    try {
      await sql`DELETE FROM stripe_webhook_events WHERE event_id = ${params.claimId} AND processed = false`;
    } catch (releaseError) {
      console.error(`❌ Could not even release the claim ${params.claimId} — needs manual cleanup.`, releaseError);
    }
    return false;
  }

  await recordTransaction(sql, {
    userId: params.userId,
    type: 'credit_purchase',
    // atFreeRate finally carries a real value — see credits.config.ts. Two
    // purchases of the same size can now legitimately cost different amounts,
    // and the row says which rate applied.
    description: describeCreditPurchase(params.credits, params.atFreeRate),
    amountCents: params.amountCents,
    currency: params.currency || 'usd',
    providerEventId: params.claimId,
    providerObjectId: params.providerObjectId,
    receiptUrl: params.receiptUrl,
    creditType: ISEO_CREDIT_TYPE,
    creditDelta: params.credits,
  });

  await sql`
    UPDATE stripe_webhook_events
    SET processed = true, processed_at = NOW()
    WHERE event_id = ${params.claimId}
  `;

  return true;
};

/** What a saved-card charge did, or why it could not happen. */
interface CreditPackCharge {
  paid: boolean;
  receiptUrl: string | null;
  reason: string | null;
  /**
   * The invoice this purchase was charged on.
   *
   * Carried back out so the receipt email can be keyed on the billing event
   * rather than on the moment the request happened — a key derived from a
   * timestamp would make every retry a second email.
   */
  invoiceId?: string | null;
}

/**
 * Charge a credit pack to the card we already hold.
 *
 * Modelled on chargeProrationNow: an invoice, not a bare PaymentIntent. Two
 * reasons — it is the pattern upgrades already use to charge a stored card, and
 * it produces a hosted invoice, so the ledger row gets a real receipt link.
 * A PaymentIntent would leave that column null on exactly the rows people
 * expense.
 *
 * ── EVERY FAILURE FALLS BACK, NONE SURFACES ─────────────────────────────────
 * No customer, no card on file, a decline, or a card that needs 3-D Secure all
 * return `paid: false` with a reason. The caller then issues a Checkout session
 * and the customer completes the purchase there, where Stripe handles
 * authentication and card entry for us.
 *
 * That last case is the one that matters: `invoices.pay` cannot perform 3-D
 * Secure, so a card requiring it would otherwise strand a paying customer at a
 * dead "payment failed" — for a card that works perfectly well.
 *
 * The grant is claimed on the INVOICE id, so the invoice.payment_succeeded
 * webhook cannot grant the same pack a second time.
 */
const chargeCreditPackOnCard = async (params: {
  userId: number;
  pkg: CreditPackage;
  amountCents: number;
  paymentMethodId: string | null;
}): Promise<CreditPackCharge> => {
  const nope = (reason: string): CreditPackCharge => ({ paid: false, receiptUrl: null, reason, invoiceId: null });

  try {
    const rows = await sql`SELECT stripe_customer_id FROM users WHERE id = ${params.userId}`;
    const customerId = rows[0]?.stripe_customer_id as string | undefined;
    if (!customerId) return nope('no stripe customer');

    // A card must already be on file. Passing an explicit one is advisory: the
    // customer's local default is used when the CMS does not name one, which is
    // the same record the upgrade flow and the Settings page read.
    const paymentMethod = params.paymentMethodId
      ?? (await getLocalDefaultPaymentMethod(sql, params.userId))?.id
      ?? null;
    if (!paymentMethod) return nope('no card on file');

    // ── THE INVOICE COMES FIRST, AND THE ITEM NAMES IT ──────────────────────
    // The obvious order — create the item, then create an invoice and let it
    // sweep whatever is pending — is what shipped, and it gave credits away.
    // `invoices.create` does NOT pull in pending invoice items unless told to,
    // so it produced an invoice with ZERO lines and a total of $0;
    // `invoices.pay` succeeded on it, the customer got the credits for nothing,
    // and the $4 item stayed pending, waiting to appear on their next renewal
    // invoice weeks later with no explanation.
    //
    // Creating the invoice first and attaching the item BY ID removes the sweep
    // from the picture. Nothing here now depends on a default that varies by
    // API version.
    const draft = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false,
      collection_method: 'charge_automatically',
      default_payment_method: paymentMethod,
      description: 'ImproveSEO credit pack',
      // This invoice is for the single item attached below and must never
      // absorb unrelated pending items belonging to this customer.
      pending_invoice_items_behavior: 'exclude',
    });
    if (!draft.id) return nope('invoice not created');

    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: draft.id,
      amount: params.amountCents,
      currency: 'usd',
      description: `${params.pkg.credits.toLocaleString()} ISEO Credits`
        + ` — about ${params.pkg.approx_pieces} piece${params.pkg.approx_pieces === 1 ? '' : 's'}`
        + ` of local SEO content with AI image`,
    });

    // ── NEVER PAY AN INVOICE THAT IS NOT THE AMOUNT WE MEANT TO CHARGE ──────
    // The check that would have caught the bug above in production rather than
    // in a customer's ledger. A $0 invoice is not a free credit pack; it means
    // the item did not attach. Bail out, void the empty invoice, and let the
    // caller fall back to Checkout where the customer pays properly.
    const finalized = await stripe.invoices.finalizeInvoice(draft.id);
    if ((finalized.amount_due ?? 0) !== params.amountCents) {
      try { await stripe.invoices.voidInvoice(draft.id); } catch { /* already gone */ }
      return nope(`invoice total ${finalized.amount_due} != expected ${params.amountCents}`);
    }

    const paid = await stripe.invoices.pay(draft.id);
    if (paid.status !== 'paid') return nope(`invoice status ${paid.status}`);
    // And again after the money moves, because amount_paid is what the ledger
    // records and a zero there is exactly what the customer reported seeing.
    if ((paid.amount_paid ?? 0) !== params.amountCents) {
      return nope(`paid ${paid.amount_paid} != expected ${params.amountCents}`);
    }

    const receiptUrl = paid.hosted_invoice_url || paid.invoice_pdf || null;

    // ── THE MONEY HAS ALREADY MOVED — NOTHING BELOW THIS LINE MAY REPORT
    //    `paid: false` ─────────────────────────────────────────────────────
    //
    // grantCreditPack was called from inside the SAME try block this catch
    // guards, which meant a failure granting credits (addPurchasedCredits is
    // a real DB transaction — it can throw) was indistinguishable from a
    // failed CHARGE. The caller (POST /buy-credits) reads `paid: false` as
    // "the card route didn't work" and falls back to opening a brand-new
    // Checkout Session for the same purchase — so a customer who was already
    // charged here would be asked to pay AGAIN, while the credits and ledger
    // row from the charge that actually succeeded are silently lost, with
    // nothing that ever retries them.
    //
    // A failure here is now caught on its own and logged loudly for manual
    // reconciliation, but it can no longer turn an already-paid invoice into
    // a reported failure — that would risk a double charge, which is strictly
    // worse than a delayed credit grant.
    try {
      await grantCreditPack({
        userId: params.userId,
        credits: params.pkg.credits,
        claimId: `topup_invoice_${paid.id}`,
        amountCents: paid.amount_paid ?? params.amountCents,
        currency: paid.currency || 'usd',
        providerObjectId: paid.id ?? null,
        receiptUrl,
        // Only subscribers reach this path; the free rate is Checkout-only.
        atFreeRate: false,
      });
    } catch (grantError) {
      console.error(
        `❌ Charged invoice ${paid.id} for user ${params.userId} but could not grant`
        + ` the credits/ledger row — needs manual reconciliation. Customer must NOT`
        + ` be charged again.`,
        grantError,
      );
    }

    console.log(
      `✅ Charged ${params.amountCents} for ${params.pkg.credits} credits to user ${params.userId}`
      + ` on file (invoice ${paid.id})`,
    );
    return { paid: true, receiptUrl, reason: null, invoiceId: paid.id ?? null };
  } catch (err: any) {
    // Declines, authentication_required, Stripe unreachable — all the same to
    // the caller: the card route did not work, use Checkout.
    return nope(err?.code || err?.message || String(err));
  }
};

/**
 * BILL-001 — the promotion logic now lives in services/billing/payment-methods.ts.
 *
 * It moved for two reasons, both of which the ticket forces:
 *
 *   • It has to write OUR database as well as Stripe's, atomically, and roll
 *     back cleanly when either side fails. That is real logic with real failure
 *     modes, and it needs tests; logic embedded in a route handler that
 *     constructs its own Stripe client at module load cannot be given a fake.
 *   • It has to be safe under two concurrent "add card" requests. Proving that
 *     requires driving two callers at once against a lock, which again means
 *     injectable dependencies.
 *
 * The version that lived here read Stripe, decided, and wrote Stripe — with no
 * local record and no serialisation. See the module for what each of the
 * ticket's four root-cause hypotheses turned out to be.
 */

/**
 * Point a subscription at the customer's default payment method.
 *
 * A customer-level default does not retroactively apply to a subscription that
 * was created with its own `default_payment_method`, so a renewal can still be
 * attempted against a stale card. Clearing the subscription-level override
 * makes it inherit the customer default, which is the one the user manages in
 * Settings.
 */
const alignSubscriptionPaymentMethod = async (subscriptionId: string): Promise<void> => {
  try {
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: '',
    });
  } catch (err) {
    // Non-fatal: the charge will still fall back to the customer default.
    console.warn(`⚠️ Could not align subscription ${subscriptionId} payment method:`, err);
  }
};

// Validation schemas
const createCheckoutSessionSchema = z.object({
  user_id: z.number(),
  price_id: z.string(),
  success_url: z.string().url(),
  cancel_url: z.string().url()
});

const buyCreditSchema = z.object({
  user_id: z.number(),
  // The current shape: pick one of the configured packages. 'large' is still
  // ACCEPTED so a stale tab gets the route's own "unknown package" message
  // listing what is on sale, rather than a bare schema rejection.
  package_id: z.enum(['small', 'medium', 'large']).optional(),
  // Which saved card to charge, for a subscriber paying inside the modal.
  // Advisory only: the customer's default is used when absent, and the tier is
  // never inferred from its presence.
  payment_method_id: z.string().optional(),
  // 'iseo' is the real pool. The three legacy labels are still accepted so a CMS that has not
  // been redeployed keeps working; handleCreditTopup maps whatever arrives onto the pool.
  credit_type: z.enum(['iseo', 'images', 'content', 'keywords']).default('iseo'),
  // Legacy, and now optional: a raw quantity is mapped onto the nearest package
  // rather than priced per credit. Required until the CMS ships package_id.
  quantity: z.number().min(1).max(100000).optional(),
  success_url: z.string().url(),
  cancel_url: z.string().url()
});

const upgradeSchema = z.object({
  user_id: z.number(),
  new_plan_id: z.number(),
  success_url: z.string().url(),
  cancel_url: z.string().url()
});

/**
 * Create checkout session for plan upgrade
 * POST /api/v1/stripe/create-checkout-session
 */
router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { user_id, price_id, success_url, cancel_url } = createCheckoutSessionSchema.parse(req.body);

    // Get user email
    const userResult = await sql`SELECT email FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const userEmail = userResult[0].email;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      customer_email: userEmail,
      // Stripe collects the billing address at checkout, so nothing has to be
      // demanded at signup or gated before a purchase. It is REQUIRED rather
      // than auto: the reason we ask at all is tax and a valid invoice, and
      // 'auto' asks only where the card brand happens to require it.
      billing_address_collection: 'required',
      payment_method_types: ['card'],
      line_items: [
        {
          price: price_id,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: withSessionId(success_url),
      cancel_url: cancel_url,
      metadata: {
        user_id: user_id.toString()
      }
    });

    res.json({
      success: true,
      data: {
        session_id: session.id,
        url: session.url
      }
    });

  } catch (error) {
    console.error('Stripe checkout session error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create checkout session'
    });
  }
});

/**
 * The credit packages on sale, and what a piece of content costs.
 * GET /api/v1/stripe/credit-packages
 *
 * Serves the storefront so prices live in ONE place. The CMS previously had no
 * way to know them and would have had to hardcode a second copy — which is how
 * a price list drifts from the one that actually charges.
 *
 * `credits_per_piece` is included so the info icon on the balance panel can
 * explain the weighting without shipping its own arithmetic.
 */
/**
 * Does this account pay for a plan?
 *
 * The single answer to "which credit-pack tier applies", derived HERE from the
 * account rather than accepted from the caller. A tier taken from a request
 * body is a discount anyone can ask for.
 *
 * Fails to `false` — the dearer, free-plan rate — on any doubt, including a
 * failed lookup. Quoting the subscriber price and then charging more is the one
 * outcome worth ruling out by construction; the opposite mistake costs us a
 * dollar and is visible in the ledger.
 */
const isSubscriberAccount = async (user_id: number): Promise<boolean> => {
  try {
    const sub = await getUserSubscription(user_id);
    return Boolean(sub) && isLiveStatus(sub.status);
  } catch (err) {
    console.warn(`Could not resolve the plan tier for user ${user_id}; using the free rate:`, err);
    return false;
  }
};

router.get('/credit-packages', async (req: Request, res: Response) => {
  // Optional: an unattributed caller is quoted the free (higher) rate, so the
  // discount can never be advertised to someone who will not be charged it.
  const requested = Number(req.query.user_id);
  const isSubscriber = Number.isFinite(requested) && requested > 0
    ? await isSubscriberAccount(requested)
    : false;

  res.json({
    success: true,
    data: {
      // `price_cents` is already resolved to this customer's tier, so the CMS
      // renders a price rather than choosing between two.
      packages: creditPackagesForPlan(isSubscriber),
      is_subscriber: isSubscriber,
      credits_per_piece: creditsPerPiece(),
      // The real per-action price table, so the CMS can say what a balance is
      // good for ("enough for 1 AI image") without shipping a second copy of
      // the prices that would drift the moment one changed. Same function the
      // plugin endpoint already serves.
      pricing: publicPricing(),
    },
  });
});

/**
 * Buy additional credits (one-time purchase)
 * POST /api/v1/stripe/buy-credits
 */
router.post('/buy-credits', async (req: Request, res: Response) => {
  try {
    const {
      user_id, package_id, quantity, success_url, cancel_url, payment_method_id,
    } = buyCreditSchema.parse(req.body);

    // Get user email
    const userResult = await sql`SELECT email, stripe_customer_id FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const userEmail = userResult[0].email;
    const existingCustomerId = (userResult[0].stripe_customer_id as string | null) || null;

    // ── Packages, not per-credit pricing ──────────────────────────────────────
    // This sold `{credit_type, quantity}` at {images: $1, content: $2,
    // keywords: $0.50} per credit — three prices for three pools that no longer
    // exist, and an arbitrary quantity the customer had to reason about in a
    // unit ("one content credit") that stopped meaning anything when the pools
    // collapsed into one weighted pool.
    //
    // Now: two fixed packages sized in PIECES OF CONTENT, priced from the
    // fail-closed config so a deploy missing a price refuses to boot rather
    // than selling credits for nothing.
    //
    // The legacy shape is still accepted for one release, so a CMS that has not
    // been redeployed keeps working; it maps onto the nearest package rather
    // than resurrecting the old per-type maths.
    const pkg = creditPackageById(package_id)
      ?? (quantity ? nearestPackageFor(quantity) : null);

    if (!pkg) {
      return res.status(400).json({
        success: false,
        error: 'Unknown credit package. Choose one of: '
          + creditPackages().map((p) => p.id).join(', '),
      });
    }

    // ── The price is decided HERE, from the account ──────────────────────────
    // Never from the request body. The CMS is told a price so it can render
    // one; it is not asked which price to charge, because then the discount is
    // available to anyone who can edit a fetch call.
    const isSubscriber = await isSubscriberAccount(user_id);
    const amountCents = creditPackPrice(pkg, isSubscriber);

    // ── Subscribers pay on the card we already hold ─────────────────────────
    // A top-up mid-cycle should not throw a paying customer out to a hosted
    // checkout page to re-enter a card Stripe already has. Falls through to
    // Checkout below when there is no usable card, or when the card needs
    // 3-D Secure — see chargeCreditPackOnCard.
    if (isSubscriber) {
      const charged = await chargeCreditPackOnCard({
        userId: user_id, pkg, amountCents, paymentMethodId: payment_method_id ?? null,
      });

      if (charged.paid) {
        // ── Credit pack receipt ────────────────────────────────────────────
        // There was none. A customer could be charged for a pack and receive
        // nothing in writing at all — the largest single source of "did my
        // payment go through?" tickets, and in most jurisdictions a receipt for
        // a completed sale is not optional.
        //
        // Keyed on the invoice, so the fallback-to-Checkout path below and a
        // retried request cannot both produce one.
        const balanceAfter = await getLiveBalance(user_id).then((b) => b.total).catch(() => null);
        const cardForReceipt = await getLocalDefaultPaymentMethod(sql, user_id);
        // Calendar months, not 30-day blocks: the grant itself expires on a
        // calendar boundary, and a receipt that names a date two days off the
        // real one is worse than naming no date.
        const packExpiry = new Date();
        packExpiry.setMonth(packExpiry.getMonth() + PURCHASED_CREDIT_LIFETIME_MONTHS);

        await queueBillingEmail(
          user_id,
          'billing.credit_purchase',
          `credit_purchase:${charged.invoiceId ?? `${user_id}:${pkg.id}:${amountCents}`}`,
          (firstName) => ({
            firstName,
            packName: `${pkg.credits.toLocaleString()} credits — about ${pkg.approx_pieces} piece${pkg.approx_pieces === 1 ? '' : 's'} of content`,
            creditsAdded: `${pkg.credits.toLocaleString()} credits`,
            // Branches rather than interpolating: a failed balance read must
            // cost one row of the receipt, never the receipt.
            newBalance: balanceAfter !== null
              ? `${Number(balanceAfter).toLocaleString()} credits`
              : `${pkg.credits.toLocaleString()} credits added`,
            amountCharged: formatCents(amountCents, 'usd'),
            cardBrand: cardForReceipt?.brand ?? null,
            cardLast4: cardForReceipt?.last4 ?? null,
            receiptUrl: charged.receiptUrl,
            // Stated on the receipt, not only in the expiry warning: "I didn't
            // know they expired" is not answerable if the confirmation of
            // purchase never mentioned it.
            expiresOn: packExpiry.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
            creditsUrl: CMS_BILLING_URL,
          }),
        );

        return res.json({
          success: true,
          data: {
            paid: true,
            amount: amountCents,
            quantity: pkg.credits,
            package_id: pkg.id,
            approx_pieces: pkg.approx_pieces,
            receipt_url: charged.receiptUrl,
            // The balance AFTER the grant, read back rather than computed by
            // adding the pack to whatever the CMS last saw. The confirmation
            // states this number, and a stale client-side total would put a
            // wrong balance in front of someone who has just paid. Best effort:
            // a failed read costs one clause of a sentence, never the purchase,
            // which has already completed by this point.
            balance_after: await getLiveBalance(user_id)
              .then((b) => b.total)
              .catch(() => null),
            // No `url`: nothing to redirect to. The CMS confirms in place and
            // refreshes the balance.
          },
        });
      }

      console.warn(
        `Card charge unavailable for user ${user_id} (${charged.reason}); falling back to Checkout.`,
      );
    }

    // Create Stripe checkout session for one-time payment
    const session = await stripe.checkout.sessions.create({
      // An existing Stripe customer is reused so the invoice below lands on the
      // same customer as their subscription invoices (and charge.refunded can
      // find them). Without one, Stripe creates a customer for the invoice.
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : { customer_email: userEmail }),
      // Stripe collects the billing address at checkout, so nothing has to be
      // demanded at signup or gated before a purchase. It is REQUIRED rather
      // than auto: the reason we ask at all is tax and a valid invoice, and
      // 'auto' asks only where the card brand happens to require it.
      billing_address_collection: 'required',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${pkg.credits.toLocaleString()} ISEO Credits`,
              // `approx_pieces` is derived from the live cost table (see
              // credits.config.ts), so this count follows a pricing change
              // instead of going stale. The lifetime comes from the constant
              // for the same reason — a hardcoded "12 months" here would
              // outlive the policy it describes.
              description:
                `Enough for about ${pkg.approx_pieces} piece${pkg.approx_pieces === 1 ? '' : 's'} of local SEO content`
                + ` with AI image. Credits valid for ${PURCHASED_CREDIT_LIFETIME_MONTHS} months.`,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      // ── A real invoice, so the receipt matches every other purchase ───────
      // A payment-mode session on its own produces only a charge, whose receipt
      // is a different Stripe page from the hosted invoice that subscriptions,
      // renewals, plan changes and saved-card packs all link to. QA reported the
      // two looking different in Account Activity. With this, the ledger row
      // links to this invoice instead (receiptUrlFromSession). The invoice is
      // paid by the session and has no subscription, so the
      // invoice.payment_succeeded handler ignores it — no second grant or row.
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: 'ImproveSEO credit pack',
          metadata: {
            user_id: user_id.toString(),
            package_id: pkg.id,
            purchase_type: 'credit_topup',
          },
        },
      },
      success_url: withSessionId(success_url),
      cancel_url: cancel_url,
      metadata: {
        user_id: user_id.toString(),
        // `quantity` is the CREDITS granted, which is what applyCreditTopupOnce
        // reads. credit_type stays for that function's legacy branch.
        credit_type: ISEO_CREDIT_TYPE,
        quantity: pkg.credits.toString(),
        package_id: pkg.id,
        // Which tier was charged, so the ledger row can say "(Basic plan rate)"
        // and support can explain why two identical-looking purchases cost
        // different amounts.
        at_free_rate: (!isSubscriber).toString(),
        purchase_type: 'credit_topup'
      }
    });

    res.json({
      success: true,
      data: {
        paid: false,
        session_id: session.id,
        url: session.url,
        amount: amountCents,
        quantity: pkg.credits,
        package_id: pkg.id,
        approx_pieces: pkg.approx_pieces,
      }
    });

  } catch (error) {
    console.error('Credit purchase error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create credit purchase'
    });
  }
});

/**
 * Upgrade subscription plan
 * POST /api/v1/stripe/upgrade-plan
 */
router.post('/upgrade-plan', async (req: Request, res: Response) => {
  try {
    const { user_id, new_plan_id, success_url, cancel_url } = upgradeSchema.parse(req.body);

    // Get user and current subscription
    const userResult = await sql`SELECT email FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get new plan details
    const planResult = await sql`
      SELECT * FROM subscription_plans WHERE id = ${new_plan_id}
    `;
    if (planResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Plan not found'
      });
    }

    const plan = planResult[0];
    const userEmail = userResult[0].email;

    // Create Stripe price ID dynamically or use pre-created ones
    // For now, we'll create a checkout session with plan details
    const session = await stripe.checkout.sessions.create({
      customer_email: userEmail,
      // Stripe collects the billing address at checkout, so nothing has to be
      // demanded at signup or gated before a purchase. It is REQUIRED rather
      // than auto: the reason we ask at all is tax and a valid invoice, and
      // 'auto' asks only where the card brand happens to require it.
      billing_address_collection: 'required',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
              description: `${plan.image_credits} images, ${plan.content_credits} content, ${plan.keyword_credits} keywords per month`,
            },
            unit_amount: plan.price_cents,
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: withSessionId(success_url),
      cancel_url: cancel_url,
      metadata: {
        user_id: user_id.toString(),
        plan_id: new_plan_id.toString(),
        upgrade_type: 'plan_change'
      }
    });

    res.json({
      success: true,
      data: {
        session_id: session.id,
        url: session.url,
        plan_name: plan.name,
        price: plan.price_cents / 100
      }
    });

  } catch (error) {
    console.error('Plan upgrade error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create plan upgrade'
    });
  }
});

/**
 * Stripe webhook handler
 * POST /api/v1/stripe/webhook
 * NOTE: Raw body middleware is configured in main server file (index.ts)
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  // ✅ IDEMPOTENCY CHECK: Prevent duplicate processing on Stripe retries
  try {
    // Check if this event was already processed
    const existingEvent = await sql`
      SELECT event_id, processed FROM stripe_webhook_events 
      WHERE event_id = ${event.id}
      LIMIT 1
    `;

    if (existingEvent.length > 0) {
      console.log(`ℹ️ Webhook event ${event.id} already processed - skipping (idempotency)`);
      return res.json({ received: true, skipped: true, reason: 'already_processed' });
    }

    // Log event as being processed (insert early to claim it)
    await sql`
      INSERT INTO stripe_webhook_events (event_id, event_type, processed)
      VALUES (${event.id}, ${event.type}, false)
      ON CONFLICT (event_id) DO NOTHING
    `;
  } catch (idempotencyError) {
    console.error('Idempotency check error:', idempotencyError);
    // Continue processing if idempotency check fails (don't block webhooks)
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        const userId = parseInt(session.metadata?.user_id || '0');
        const purchaseType = session.metadata?.purchase_type;

        // The address Stripe just collected, onto our row. This is what
        // replaced asking at signup and gating the purchase — the user gives
        // it once, at the moment it is actually needed, and we learn it here.
        // client_reference_id covers the sessions that carry the user there
        // instead of in metadata.
        const addressUserId = userId || parseInt(session.client_reference_id || '0');
        if (addressUserId) {
          await syncAddressFromStripe(addressUserId, session.customer_details?.address);
        }

        if (purchaseType === 'credit_topup') {
          // Idempotent (session-keyed) so a later /verify-session call can't double-credit.
          await applyCreditTopupOnce(session);
        } else {
          // Handle subscription/plan upgrade (checkout completed)
          const planId = parseInt(session.metadata?.plan_id || '1');

          // Update user's plan
          await sql`
            UPDATE users
            SET plan_id = ${planId}, updated_at = NOW()
            WHERE id = ${userId}
          `;

          console.log(`✅ Updated user ${userId} plan to ${planId} (will be activated on subscription.created)`);
        }
        break;
      }

      // The billing portal is where a user changes their address after the
      // fact (POST /billing-portal), and this is how we hear about it. Without
      // this case the portal would edit Stripe's copy and leave ours stale —
      // which is precisely the drift that made keeping our own form the wrong
      // answer to 'how does the user update their address?'.
      case 'customer.updated': {
        const customer = event.data.object as Stripe.Customer;
        const uid = parseInt(customer.metadata?.user_id || '0');
        if (uid) {
          const synced = await syncAddressFromStripe(uid, customer.address);
          if (synced) console.log('Address synced from Stripe for user ' + uid + '.');
        }
        break;
      }

      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        
        // ✅ CRITICAL: Only process if payment succeeded
        if (subscription.status !== 'active' && subscription.status !== 'trialing') {
          console.warn(`⚠️ Subscription ${subscription.id} status: ${subscription.status} - skipping activation (payment not confirmed)`);
          return res.json({ received: true, skipped: true, reason: 'payment_not_confirmed' });
        }
        
        // Get user_id from subscription metadata or find by customer
        const metadata = subscription.metadata;
        let userId = parseInt(metadata?.user_id || '0');

        if (!userId && subscription.customer) {
          // Try to find user by checking existing subscriptions or users table
          const userResult = await sql`
            SELECT id FROM users WHERE stripe_customer_id = ${subscription.customer as string}
          `;
          if (userResult.length > 0) {
            userId = userResult[0].id;
          }
        }

        if (userId) {
          // Get plan_id from metadata or user's current plan
          let planId = parseInt(metadata?.plan_id || '0');
          if (!planId) {
            const userResult = await sql`SELECT plan_id FROM users WHERE id = ${userId}`;
            planId = userResult.length > 0 ? userResult[0].plan_id : 1;
          }

          // Stripe's own period end. On 2025-10-29.clover it lives on the
          // subscription ITEM, which is why this goes through a helper — see
          // services/billing/subscription-period.
          const nextBillingTimestamp = periodEndOrWarn(subscription, 'subscription.created');

          await activateSubscriptionInDb({
            userId,
            planId,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: subscription.customer as string,
            nextBillingTimestamp,
            billingInterval:
              (subscription.items.data[0]?.price?.recurring?.interval === 'year') ? 'year' : 'month',
          });

          console.log(`✅ Subscription created for user ${userId}, plan ${planId}, credits refilled`);
        } else {
          console.warn(`⚠️ Could not determine user_id for subscription ${subscription.id}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        
        // Find user by subscription ID
        const subResult = await sql`
          SELECT user_id FROM subscriptions 
          WHERE stripe_subscription_id = ${subscription.id}
        `;

        if (subResult.length > 0) {
          const userId = subResult[0].user_id;
          // THE site that did the most damage. This event fires on every plan
          // change, and the old expression resolved to "now + 30 days" — so an
          // upgrade pushed the customer's billing date thirty days out from the
          // moment they clicked, every time. Two upgrades in an hour and the
          // date had drifted a fortnight from Stripe's anchor.
          const nextBillingTimestamp = periodEndOrWarn(subscription, 'subscription.updated');

          // ✅ Update subscription status from Stripe
          await sql`
            UPDATE subscriptions
            SET
              status = ${subscription.status},
              -- COALESCE: an unreadable period leaves the stored date alone.
              next_billing_date = COALESCE(
                TO_TIMESTAMP(${nextBillingTimestamp}::double precision),
                next_billing_date
              )
            WHERE stripe_subscription_id = ${subscription.id}
          `;

          // ✅ CRITICAL: Revoke PLAN credits if subscription becomes unpayable.
          // Purchased top-ups are preserved — the user paid for those separately.
          const badStatuses = ['incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'canceled'];
          if (badStatuses.includes(subscription.status)) {
            await suspendPlanCredits(userId, `Subscription ${subscription.status}`);
            console.warn(`⚠️ Plan credits revoked for user ${userId} - subscription status: ${subscription.status}`);
          }

          console.log(`✅ Subscription updated for user ${userId}, status: ${subscription.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        
        // Find user by subscription ID
        const subResult = await sql`
          SELECT user_id FROM subscriptions 
          WHERE stripe_subscription_id = ${subscription.id}
        `;

        if (subResult.length > 0) {
          const userId = subResult[0].user_id;

          // Downgrade to the FREE plan (was hardcoded plan_id=1 = Basic, a PAID
          // plan — which both mislabeled cancelled users and let them bypass the
          // free-plan trial gate forever). Plan (included) credits are revoked;
          // purchased top-ups are preserved — the user paid for those.
          const freePlanId = await getFreePlanId();
          await sql`
            UPDATE users SET plan_id = ${freePlanId}, updated_at = NOW()
            WHERE id = ${userId}
          `;
          await suspendPlanCredits(userId, 'Subscription cancelled');

          await sql`
            UPDATE subscriptions
            SET status = 'cancelled'
            WHERE user_id = ${userId}
          `;

          // Account Activity: "Subscription canceled" is written when the
          // customer asks; this is the day it actually stops. Keyed on the
          // Stripe subscription, so a redelivered webhook upserts. Dated to
          // Stripe's own end time when it has one. recordTransaction never throws.
          await recordTransaction(sql, {
            userId,
            type: 'plan_downgrade',
            description: describeSubscriptionEnded(),
            amountCents: null,
            status: 'succeeded',
            providerEventId: `subscription_ended:${subscription.id}`,
            providerObjectId: subscription.id,
            planId: freePlanId,
            occurredAt: subscription.ended_at ? new Date(subscription.ended_at * 1000) : null,
          });

          console.log(`⚠️ Subscription cancelled for user ${userId}, downgraded to free plan (purchased credits preserved)`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        
        // subscriptionIdFromInvoice, not invoice.subscription — that field does
        // not exist on this account's API version, which is what made this
        // entire branch dead code. See the helper for the full story.
        const paidSubscriptionId = subscriptionIdFromInvoice(invoice);

        if (paidSubscriptionId) {
          // Find user by subscription ID
          const subResult = await sql`
            SELECT user_id, plan_id, pending_plan_id, billing_interval, next_billing_date FROM subscriptions
            WHERE stripe_subscription_id = ${paidSubscriptionId}
          `;

          if (subResult.length > 0) {
            const { user_id } = subResult[0];
            let plan_id = subResult[0].plan_id;

            // ── A scheduled downgrade lands on this renewal ─────────────────
            // change-plan moves the Stripe price at once with no proration, and
            // records only pending_plan_id here — so this renewal is the first
            // one billed at the lower plan, and the day the downgrade happens.
            // Nothing applied it before: the row kept the old plan for good, the
            // refill below granted the OLD plan's credits, and "Plan downgraded"
            // never reached Account Activity. Applied BEFORE the refill so the
            // allotment and the renewal line both name the plan now in force.
            //
            // Guarded on pending_plan_id IS NOT NULL in the UPDATE itself, so a
            // redelivered webhook finds nothing to apply and writes no second row.
            if (isRenewalInvoice(invoice) && subResult[0].pending_plan_id != null) {
              const applied = await sql`
                UPDATE subscriptions
                SET previous_plan_id = plan_id,
                    plan_id = pending_plan_id,
                    pending_plan_id = NULL,
                    pending_plan_effective_date = NULL,
                    status = 'active'
                WHERE stripe_subscription_id = ${paidSubscriptionId}
                  AND pending_plan_id IS NOT NULL
                RETURNING previous_plan_id, plan_id
              `;
              if (applied.length > 0) {
                const fromId = applied[0].previous_plan_id;
                plan_id = applied[0].plan_id;
                await sql`UPDATE users SET plan_id = ${plan_id}, updated_at = NOW() WHERE id = ${user_id}`;

                const names = await sql`SELECT id, name FROM subscription_plans WHERE id IN (${fromId}, ${plan_id})`;
                const nameOf = (id: number) => (names as any[]).find((p) => p.id === id)?.name ?? null;
                await recordTransaction(sql, {
                  userId: user_id,
                  type: 'plan_downgrade',
                  description: describePlanDowngraded(nameOf(fromId), nameOf(plan_id)),
                  amountCents: null,
                  status: 'succeeded',
                  providerEventId: `plan_downgraded:${invoice.id}`,
                  providerObjectId: paidSubscriptionId,
                  planId: plan_id,
                });
                console.log(`⬇️ Scheduled downgrade applied for user ${user_id}: plan ${fromId} → ${plan_id}`);
              }
            }

            // ── Refill ONLY on a genuine renewal ────────────────────────────
            // Every invoice attached to a subscription lands here, including
            // the proration invoice an upgrade raises. Refilling on that one
            // would grant a full second allowance on top of the difference
            // upgradeIncludedCredits has already added, and re-stamp
            // cycle_started_at to mid-period. isRenewalInvoice keeps this to
            // billing_reason === 'subscription_cycle'.
            const planResult = await sql`SELECT * FROM subscription_plans WHERE id = ${plan_id}`;
            if (isRenewalInvoice(invoice) && planResult.length > 0) {
              await refillPlanCredits(user_id, planResult[0], 'Monthly plan credits refill');
              console.log(`✅ Monthly plan credits refilled for user ${user_id} (invoice paid)`);

              // ── Renewal receipt ──────────────────────────────────────────
              // Nothing was sent on renewal: the charge happened, the credits
              // were topped up, and the customer was told neither. A recurring
              // charge nobody confirms is the one people find on a statement
              // months later and dispute.
              //
              // Queued inside the isRenewalInvoice guard deliberately, so it
              // shares exactly the condition that decides a genuine renewal —
              // a proration invoice from an upgrade must not produce a second
              // "your plan renewed" email on top of the upgrade receipt.
              //
              // Keyed on the INVOICE, which is the billing event itself, so a
              // redelivered webhook cannot send it twice.
              const renewalCard = await getLocalDefaultPaymentMethod(sql, user_id).catch(() => null);
              const isYearly = String(subResult[0].billing_interval || 'month') === 'year';

              await queueBillingEmail(
                user_id,
                'billing.renewal',
                `renewal:${invoice.id}`,
                (firstName) => ({
                  firstName,
                  planName: planResult[0]?.name ?? 'your plan',
                  amountCharged: formatCents(invoice.amount_paid ?? 0, invoice.currency || 'usd'),
                  periodLabel: isYearly ? 'another year' : 'another month',
                  creditsNote: `Your ${isYearly ? 'annual' : 'monthly'} credit allowance has been added to your account.`,
                  nextBillingDate: subResult[0].next_billing_date
                    ? new Date(subResult[0].next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                    : null,
                  cardBrand: renewalCard?.brand ?? null,
                  cardLast4: renewalCard?.last4 ?? null,
                  receiptUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || null,
                  billingUrl: CMS_BILLING_URL,
                  timezone: 'UTC',
                }),
              );
            }

            // ── Record only the invoices no other path owns ─────────────────
            // Renewals and first invoices reach the ledger nowhere else, so
            // they are recorded here.
            //
            // Plan changes are NOT. The change-plan route already writes one
            // `plan_change:…` row on the day it happens, carrying the amount
            // actually collected and the receipt — see the long note at that
            // call site. It was written when `create_prorations` merely queued
            // pending invoice items and no invoice appeared until the next
            // cycle; chargeProrationNow now raises and pays one immediately, so
            // without this guard a single upgrade would produce three ledger
            // rows: our "Plan upgraded — Optimize → Scale (prorated)" plus
            // Stripe's two raw proration lines. That is the same four-line wall
            // the confirmation dialog was rebuilt to remove, reappearing in
            // Account Activity — and QA's spec lists exactly one line per event.
            //
            // planResult is already loaded above for the refill; passing the
            // name lets the row be described in our own wording instead of
            // Stripe's invoice-line text.
            const ownedElsewhere =
              invoice.billing_reason === 'subscription_update'
              || invoice.billing_reason === 'manual';

            if (!ownedElsewhere) {
              for (const txn of transactionsFromInvoice(
                invoice, user_id, plan_id, planResult[0]?.name ?? null,
              )) {
                await recordTransaction(sql, txn);
              }
            }

            // ── Settle whatever this invoice was carrying ───────────────────
            // A plan change whose proration could not be collected on the day
            // is recorded `pending` with no receipt. This is the invoice that
            // finally collects it, so this is where that row stops being
            // pending — otherwise it stays that way for good and Account
            // Activity shows a charge with a permanently blank Receipt column.
            //
            // Guarded on proration lines: an ordinary renewal carries no plan
            // change and must not mark one settled.
            if ((invoice.lines?.data ?? []).some(isProrationLine)) {
              const settled = await settlePendingPlanChanges(sql, {
                userId: user_id,
                subscriptionId: paidSubscriptionId,
                receiptUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || null,
                paidAt: new Date((invoice.created ?? 0) * 1000),
              });
              if (settled > 0) {
                console.log(`✅ Settled ${settled} pending plan change(s) for user ${user_id}`);
              }
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        
        // Same fix as the success branch above: this guard could never open.
        const failedSubscriptionId = subscriptionIdFromInvoice(invoice);

        if (failedSubscriptionId) {
          const subResult = await sql`
            SELECT s.user_id, s.next_billing_date, sp.name AS plan_name
            FROM   subscriptions s
            LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
            WHERE  s.stripe_subscription_id = ${failedSubscriptionId}
          `;

          if (subResult.length > 0) {
            const userId = subResult[0].user_id;
            
            // ✅ CRITICAL: Suspend subscription in database
            await sql`
              UPDATE subscriptions
              SET status = 'past_due', updated_at = NOW()
              WHERE user_id = ${userId}
            `;
            
            // ✅ CRITICAL: Revoke PLAN credits immediately on payment failure.
            // Purchased top-ups are preserved — the user paid for those separately.
            await suspendPlanCredits(userId, 'Payment failed');

            // BILL-004 — a failed payment is a billable event the customer
            // needs to see; it explains why their credits stopped.
            await recordTransaction(sql, {
              userId,
              type: 'payment_failed',
              description: describePaymentFailed(),
              amountCents: (invoice as any).amount_due ?? null,
              currency: invoice.currency || 'usd',
              status: 'failed',
              providerEventId: `invoice_failed:${invoice.id}`,
              providerObjectId: invoice.id as string,
            });

            // ── Dunning ──────────────────────────────────────────────────────
            // Nothing was sent here. The subscription was suspended and the
            // plan credits revoked SILENTLY, so the first a customer knew of a
            // failed card was their credits not working — with no email to
            // search for, and no way to tell a billing failure from a bug in
            // the product. That is the most expensive silence in this file.
            //
            // A failed card is almost always an expiry or a bank block rather
            // than a decision, so the copy treats it as a fixable annoyance
            // (see the template) and escalates only on the final attempt.
            //
            // Keyed on the invoice AND the attempt number: Stripe raises this
            // event once per retry, and each retry is a genuinely new thing to
            // tell the customer — but a redelivery of the same attempt is not.
            const attemptNumber = Number((invoice as any).attempt_count ?? 1);
            const nextAttempt = (invoice as any).next_payment_attempt as number | null | undefined;
            const failedCard = await getLocalDefaultPaymentMethod(sql, userId).catch(() => null);

            await queueBillingEmail(
              userId,
              'billing.payment_failed',
              `payment_failed:${invoice.id}:${attemptNumber}`,
              (firstName) => ({
                firstName,
                planName: subResult[0].plan_name || 'your',
                amountDue: formatCents((invoice as any).amount_due ?? 0, invoice.currency || 'usd'),
                cardBrand: failedCard?.brand ?? null,
                cardLast4: failedCard?.last4 ?? null,
                attemptNumber,
                nextAttemptDate: nextAttempt
                  ? new Date(nextAttempt * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                  : null,
                accessEndsOn: subResult[0].next_billing_date
                  ? new Date(subResult[0].next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                  : null,
                // States what suspendPlanCredits just did, rather than a
                // future tense that would be a lie — the credits are already
                // gone by the time this email is read, and the customer has
                // very likely noticed. Purchased credits genuinely survive, and
                // saying so prevents the panicked "I lost what I paid for"
                // ticket this exact moment generates.
                creditsNote:
                  'Your plan credits have been paused while this is outstanding. '
                  + 'Any credits you purchased separately are untouched and still usable, '
                  + 'and your plan allowance comes straight back once the payment goes through.',
                updatePaymentUrl: CMS_BILLING_URL,
                invoiceUrl: invoice.hosted_invoice_url || null,
              }),
            );

            console.warn(`⚠️ Payment failed for user ${userId} - subscription suspended, plan credits revoked`);
          }
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;

        // ── Refunds happen in the Stripe dashboard, not in this product ──────
        // There is no refund endpoint here and no admin screen for one; support
        // issues them directly in Stripe. So the only way a refund can reach the
        // customer's Account Activity is by listening for it, which is what this
        // does. Without it the money left the account with no explanation in the
        // one place the customer looks for explanations.
        const owner = await sql`
          SELECT id FROM users WHERE stripe_customer_id = ${charge.customer as string} LIMIT 1
        `;

        if (owner.length > 0) {
          // NEGATIVE, because the ledger's convention is that amountCents is
          // signed from the customer's perspective — a refund is money coming
          // back, and rendering it as a positive charge would read as a second
          // payment taken.
          const refunded = charge.amount_refunded ?? 0;

          await recordTransaction(sql, {
            userId: owner[0].id,
            type: 'refund',
            description: describeRefund(),
            amountCents: -Math.abs(refunded),
            currency: charge.currency || 'usd',
            status: 'refunded',
            // Keyed on the refunded TOTAL, not just the charge: Stripe fires
            // this event again for each partial refund, and each one is a
            // distinct row the customer should see. recordTransaction dedupes
            // on providerEventId, so a redelivery of the same event is a no-op
            // while a genuine second refund is not.
            providerEventId: `charge_refunded:${charge.id}:${refunded}`,
            providerObjectId: charge.id,
            receiptUrl: charge.receipt_url ?? null,
          });

          // ── Refund confirmation ──────────────────────────────────────────
          // Support issues refunds in the Stripe dashboard, so until now the
          // customer's only notice was Stripe's own charge email — if the
          // account had one configured — and a row appearing in Account
          // Activity if they went looking. Someone who asked for a refund is
          // already unhappy; leaving them to wonder whether it happened is the
          // cheapest unhappiness to remove.
          //
          // Keyed on the refunded total, the same key the ledger row uses, so
          // a partial refund followed by another sends two emails and a
          // redelivered event sends none.
          const refundCard = await getLocalDefaultPaymentMethod(sql, owner[0].id).catch(() => null);
          await queueBillingEmail(
            owner[0].id,
            'billing.refund',
            `refund:${charge.id}:${refunded}`,
            (firstName) => ({
              firstName,
              amountRefunded: formatCents(Math.abs(refunded), charge.currency || 'usd'),
              // Deliberately vague about the reason: this event carries no
              // reliable one, and a receipt that guesses why someone was
              // refunded is worse than a receipt that states only the fact.
              reasonLabel: 'your ImproveSEO account',
              cardBrand: refundCard?.brand ?? null,
              cardLast4: refundCard?.last4 ?? null,
              // Card networks, not us. Naming the window here is what stops
              // the "you said you refunded me three days ago" ticket.
              arrivalWindow: '5–10 business days',
              creditsNote: null,
              billingUrl: CMS_BILLING_URL,
            }),
          );

          console.log(`✅ Refund of ${refunded} recorded for user ${owner[0].id}`);
        } else {
          console.warn(
            `⚠️ charge.refunded for customer ${charge.customer} with no matching user row — not recorded.`,
          );
        }
        break;
      }

      case 'setup_intent.succeeded': {
        const setupIntent = event.data.object as Stripe.SetupIntent;

        // When a setup intent succeeds, it means a payment method was added
        if (setupIntent.customer && setupIntent.payment_method) {
          const customerId = setupIntent.customer as string;
          const paymentMethodId = setupIntent.payment_method as string;

          // BILL-001 — delegate to the shared helper, which also runs
          // synchronously on the upgrade path so the user is never blocked
          // waiting on this webhook. The original inline version only acted
          // when the customer had EXACTLY one card, so someone holding two
          // cards and no default could never get one set.
          //
          // The helper needs our user id, not just the Stripe customer id,
          // because it writes the local record too. A setup intent that we
          // cannot attribute to a user is logged rather than ignored silently:
          // it means a customer exists in Stripe with no matching row here,
          // which is a reconciliation problem worth seeing.
          const owner = await sql`
            SELECT id FROM users WHERE stripe_customer_id = ${customerId} LIMIT 1
          `;
          if (owner.length > 0) {
            await ensureDefaultPaymentMethod(owner[0].id, customerId, paymentMethodId);
          } else {
            console.warn(
              `⚠️ setup_intent.succeeded for customer ${customerId} with no matching user row — default not recorded locally.`,
            );
          }
        }
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    // ✅ Mark event as successfully processed
    try {
      await sql`
        UPDATE stripe_webhook_events 
        SET processed = true, processed_at = NOW()
        WHERE event_id = ${event.id}
      `;
    } catch (updateError) {
      console.error('Failed to update webhook log:', updateError);
      // Don't fail the webhook if logging fails
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    
    // ✅ Log the error in webhook events table
    try {
      await sql`
        UPDATE stripe_webhook_events 
        SET 
          processed = false, 
          error_message = ${error instanceof Error ? error.message : 'Unknown error'},
          processed_at = NOW()
        WHERE event_id = ${event.id}
      `;
    } catch (logError) {
      console.error('Failed to log webhook error:', logError);
    }

    res.status(500).json({
      success: false,
      error: 'Webhook processing failed'
    });
  }
});

/**
 * Verify a completed Stripe Checkout session and apply its effect idempotently.
 *
 * Called by the CMS when the user returns to the success URL after a redirect-based
 * checkout (e.g. buy-credits). This guarantees the purchase is reflected immediately,
 * even if the webhook is delayed or the endpoint is misconfigured. Safe to call
 * repeatedly — both the credit top-up and subscription activation are idempotent and
 * shared with the webhook handler.
 *
 * POST /api/v1/stripe/verify-session  { session_id }
 */
router.post('/verify-session', async (req: Request, res: Response) => {
  try {
    const { session_id } = z.object({ session_id: z.string().min(1) }).parse(req.body);

    const session = await stripe.checkout.sessions.retrieve(session_id);

    const paid =
      session.payment_status === 'paid' ||
      session.payment_status === 'no_payment_required' ||
      session.status === 'complete';

    if (!paid) {
      return res.json({
        success: false,
        status: session.payment_status,
        message: 'Payment has not completed yet.'
      });
    }

    const purchaseType = session.metadata?.purchase_type;

    if (purchaseType === 'credit_topup') {
      const applied = await applyCreditTopupOnce(session);
      // ── Say WHAT was bought, not only that it was applied ─────────────────
      // The CMS confirms a Checkout purchase with the same "Credits added"
      // dialog as a saved-card one, which states the pack, the charge and the
      // new balance. This used to return only { type, applied }, so every
      // Checkout purchase fell through to the dialog's last-resort line —
      // "Your credit purchase was successful." — which QA reported.
      //
      // Same shape as the saved-card branch of /buy-credits. Returned whether
      // or not THIS call applied the grant: the webhook usually wins the claim
      // before the browser is back, and the purchase happened either way.
      const topupUserId = parseInt(session.metadata?.user_id || '0');
      return res.json({
        success: true,
        type: 'credit_topup',
        applied,
        data: {
          paid: true,
          quantity: parseInt(session.metadata?.quantity || '0') || null,
          package_id: session.metadata?.package_id ?? null,
          amount: typeof session.amount_total === 'number' ? session.amount_total : null,
          currency: session.currency || 'usd',
          // Read back after the grant; a failed read drops one clause of the
          // confirmation, never the response.
          balance_after: topupUserId
            ? await getLiveBalance(topupUserId).then((b) => b.total).catch(() => null)
            : null,
        },
      });
    }

    // Redirect-based subscription checkout (create-checkout-session / upgrade-plan).
    if (session.mode === 'subscription' && session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription as string);

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        const userId = parseInt(session.metadata?.user_id || subscription.metadata?.user_id || '0');
        let planId = parseInt(session.metadata?.plan_id || subscription.metadata?.plan_id || '0');

        if (userId) {
          if (!planId) {
            const userRow = await sql`SELECT plan_id FROM users WHERE id = ${userId}`;
            planId = userRow.length > 0 ? userRow[0].plan_id : 0;
          }
          if (planId) {
            const nextBillingTimestamp = periodEndOrWarn(subscription, 'verify-session');
            await activateSubscriptionInDb({
              userId,
              planId,
              stripeSubscriptionId: subscription.id,
              stripeCustomerId: subscription.customer as string,
              nextBillingTimestamp,
              // From the PRICE Stripe actually billed, not from what we asked
              // for — if the two ever disagree, the provider is right.
              billingInterval:
                (subscription.items.data[0]?.price?.recurring?.interval === 'year') ? 'year' : 'month',
            });
          }
        }
      }
      return res.json({ success: true, type: 'subscription', status: subscription.status });
    }

    return res.json({ success: true, type: 'unknown' });
  } catch (error) {
    console.error('Verify session error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to verify session'
    });
  }
});

/**
 * Get subscription plans with comparison to user's current plan
 * GET /api/v1/stripe/plans
 */
router.get('/plans', async (req: Request, res: Response) => {
  try {
    const user_id = req.query.user_id ? parseInt(req.query.user_id as string) : null;
    
    const plans = await getAllSubscriptionPlans();
    
    let currentPlanId = null;
    if (user_id) {
      const subscription = await getUserSubscription(user_id);
      currentPlanId = subscription?.plan_id;
    }

    // What the customer is currently billed on, so the CMS can open the grid on
    // the right side of the monthly/yearly toggle instead of defaulting to
    // monthly and making an annual subscriber think their plan changed.
    const currentInterval = user_id
      ? (await getUserSubscription(user_id))?.billing_interval ?? 'month'
      : 'month';

    res.json({
      success: true,
      current_interval: currentInterval,
      plans: plans.map((plan: any) => ({
        ...plan,
        // Yearly is the same plan on a different interval — same credits, same
        // features. Both prices ship on the one row so the toggle needs no
        // second request and cannot show a stale price for one of them.
        price_cents_yearly: plan.price_cents_yearly ?? null,
        yearly_available: Boolean(plan.stripe_price_id_yearly),
        // Stated rather than left to the client to derive: the saving is a
        // selling point and must match what is actually charged.
        yearly_saving_cents: plan.price_cents_yearly != null
          ? Math.max(0, plan.price_cents * 12 - plan.price_cents_yearly)
          : null,
        is_current: plan.id === currentPlanId,
        // Comparisons stay on the MONTHLY price for both sides. Comparing a
        // yearly figure against a monthly one would read a plan upgrade paid
        // annually as a downgrade, and schedule it for period end instead of
        // applying it.
        can_upgrade: currentPlanId ? plan.price_cents > plans.find((p: any) => p.id === currentPlanId)?.price_cents : true,
        can_downgrade: currentPlanId ? plan.price_cents < plans.find((p: any) => p.id === currentPlanId)?.price_cents : false
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch plans'
    });
  }
});

/**
 * Create checkout session for plan subscription (from FREE to PAID)
 * POST /api/v1/stripe/subscribe-to-plan
 */
router.post('/subscribe-to-plan', async (req: Request, res: Response) => {
  try {
    const { user_id, plan_id, interval, idempotency_key } = z.object({
      user_id: z.number(),
      plan_id: z.number(),
      // Monthly or annual; monthly by default so an un-updated client is
      // unaffected.
      interval: z.enum(['month', 'year']).default('month'),
      // BILL-002 — generated once per confirm action by the CMS and reused
      // across retries, so a double-clicked button cannot create two
      // subscriptions and two charges.
      idempotency_key: z.string().min(8).max(200).optional()
    }).parse(req.body);

    // First subscription is always a purchase.

    // Get user and plan
    const [userResult, planResult] = await Promise.all([
      sql`SELECT email, id, stripe_customer_id FROM users WHERE id = ${user_id}`,
      sql`SELECT * FROM subscription_plans WHERE id = ${plan_id}`
    ]);

    if (userResult.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (planResult.length === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const user = userResult[0];
    const plan = planResult[0];

    // Don't allow subscribing to FREE plan via this endpoint
    if (plan.price_cents === 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot subscribe to free plan via this endpoint'
      });
    }

    // Validate plan has a Stripe Price for the requested interval
    const { priceId: subPriceId, interval: subInterval } = priceForPlan(plan, interval);
    if (!subPriceId) {
      return res.status(500).json({
        success: false,
        error: 'Stripe Price ID not configured for this plan. Please contact support.'
      });
    }

    // Check if user has stripe customer ID and payment method
    if (!user.stripe_customer_id) {
      return res.status(400).json({
        success: false,
        error: 'Please add a payment method in Settings first',
        requires_payment_method: true
      });
    }

    // Get customer's payment methods
    const paymentMethods = await stripe.paymentMethods.list({
      customer: user.stripe_customer_id,
      type: 'card'
    });

    if (paymentMethods.data.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Please add a payment method in Settings first',
        requires_payment_method: true
      });
    }

    // BUG 3 — the user has at least one card at this point (checked above), so
    // requiring them to go and nominate a default was a dead end that produced
    // "no default payment method chosen" right after they had added a card.
    // Promote one automatically and carry on; only bail if they truly have none.
    //
    // OLD:
    //   const customer = await stripe.customers.retrieve(user.stripe_customer_id) as Stripe.Customer;
    //   const defaultPaymentMethod = customer.invoice_settings?.default_payment_method;
    //   if (!defaultPaymentMethod) {
    //     return res.status(400).json({
    //       success: false,
    //       error: 'Please set a default payment method in Settings first',
    //       requires_default_payment_method: true
    //     });
    //   }
    const defaultPaymentMethod = await ensureDefaultPaymentMethod(user_id, user.stripe_customer_id);

    if (!defaultPaymentMethod) {
      return res.status(400).json({
        success: false,
        error: 'Add a card to start this subscription.',
        requires_payment_method: true
      });
    }

    console.log(`🎫 Creating subscription for user ${user_id} to ${plan.name}`);

    try {
      // Create subscription directly using saved payment method
      const subscription = await stripe.subscriptions.create({
        customer: user.stripe_customer_id,
        items: [{
          price: subPriceId,
        }],
        payment_behavior: 'error_if_incomplete', // Changed: Fail if payment fails
        payment_settings: {
          save_default_payment_method: 'on_subscription'
        },
        expand: ['latest_invoice.payment_intent'],
        metadata: {
          user_id: user_id.toString(),
          plan_id: plan_id.toString(),
          billing_interval: subInterval,
          upgrade_from_free: 'true'
        }
      }, idempotencyKeyFor('subscribe', user_id, idempotency_key));

      console.log(`✅ Subscription created: ${subscription.id}, status: ${subscription.status}`);

      // Only respond success if subscription is active or trialing
      if (subscription.status === 'active' || subscription.status === 'trialing') {
        // ✅ CRITICAL: Persist the subscription + refill credits synchronously here,
        // BEFORE responding. Do NOT rely on the customer.subscription.created webhook —
        // if the webhook endpoint is misconfigured/down the user would be charged but
        // receive nothing, and even when healthy the frontend reloads credits before the
        // async webhook lands. activateSubscriptionInDb is idempotent with the webhook.
        const nextBillingTimestamp = periodEndOrWarn(subscription, 'subscribe');

        try {
          await activateSubscriptionInDb({
            userId: user_id,
            planId: plan_id,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: user.stripe_customer_id,
            nextBillingTimestamp,
            billingInterval: subInterval,
          });
        } catch (dbError) {
          // Payment succeeded but our DB write failed. Surface a clear error and let the
          // webhook reconcile — but never report a misleading "credits added" success.
          console.error('❌ Subscription persisted in Stripe but DB activation failed:', dbError);
          return res.status(500).json({
            success: false,
            error: 'Your payment succeeded but we had trouble updating your account. Your credits will appear shortly — please refresh in a minute or contact support if they do not.',
            subscription_id: subscription.id
          });
        }

        // BILL-006 — first-subscription receipt. Keyed on the SUBSCRIPTION id,
        // so a retried request or a replayed webhook cannot send it twice.
        // Every figure comes from the completed billing event, never recomputed
        // in the template.
        const defaultPmForReceipt = await getLocalDefaultPaymentMethod(sql, user_id);
        await queueBillingEmail(
          user_id,
          'billing.upgrade',
          `subscription_create:${subscription.id}`,
          (firstName) => ({
            firstName,
            oldPlan: null,
            newPlan: plan.name,
            amountCharged: formatCents(plan.price_cents, 'usd'),
            lines: [{ description: `${plan.name} — first month`, amount: formatCents(plan.price_cents, 'usd') }],
            nextAmount: formatCents(plan.price_cents, 'usd'),
            // Null when Stripe gave us no period. The template drops the "Then
            // $X on <date>" row rather than printing a date we made up — a
            // receipt is the last place to guess at a billing date.
            nextBillingDate: nextBillingTimestamp !== null
              ? new Date(nextBillingTimestamp * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
              : null,
            cardBrand: defaultPmForReceipt?.brand ?? null,
            cardLast4: defaultPmForReceipt?.last4 ?? null,
            billingUrl: CMS_BILLING_URL,
            timezone: 'UTC',
          }),
        );

        res.json({
          success: true,
          message: 'Subscription created successfully! Credits have been added.',
          data: {
            subscription_id: subscription.id,
            status: subscription.status
          }
        });
      } else {
        // Subscription created but payment incomplete
        return res.status(402).json({
          success: false,
          error: 'Payment is required to activate subscription. Please update your payment method in Settings.',
          requires_payment_method: true,
          subscription_status: subscription.status
        });
      }

    } catch (stripeError: any) {
      console.error('Stripe subscription error:', stripeError);
      
      // ✅ Handle specific card errors with detailed messages
      if (stripeError.type === 'StripeCardError') {
        const cardErrorCode = stripeError.code;
        let userMessage = 'Payment failed. Please update your payment method in Settings.';
        let errorCategory = 'card_error';
        
        switch (cardErrorCode) {
          case 'card_declined':
            userMessage = 'Your card was declined. This usually happens due to insufficient funds or bank restrictions. Please try a different card or contact your bank.';
            errorCategory = 'card_declined';
            break;
          case 'expired_card':
            userMessage = 'Your card has expired. Please add a new card in Settings to continue.';
            errorCategory = 'expired_card';
            break;
          case 'incorrect_cvc':
            userMessage = 'The CVC code is incorrect. Please verify your card details and try again.';
            errorCategory = 'incorrect_cvc';
            break;
          case 'processing_error':
            userMessage = 'An error occurred while processing your card. Please try again or use a different card.';
            errorCategory = 'processing_error';
            break;
          case 'insufficient_funds':
            userMessage = 'Your card has insufficient funds. Please use a different payment method.';
            errorCategory = 'insufficient_funds';
            break;
          default:
            userMessage = stripeError.message || 'Payment failed. Please check your card details and try again.';
        }
        
        return res.status(402).json({
          success: false,
          error: userMessage,
          error_category: errorCategory,
          requires_payment_method: true,
          stripe_error_code: cardErrorCode
        });
      }
      
      if (stripeError.code === 'resource_missing') {
        return res.status(402).json({
          success: false,
          error: 'Payment method not found. Please add a payment method in Settings.',
          requires_payment_method: true,
          stripe_error: stripeError.message
        });
      }

      throw stripeError;
    }

  } catch (error) {
    console.error('Subscribe to plan error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create checkout session'
    });
  }
});

/**
 * Start a hosted Checkout for a FIRST subscription, card and all.
 * POST /api/v1/stripe/create-subscription-checkout
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * /subscribe-to-plan charges a card the customer has ALREADY saved; it answers
 * 400 requires_payment_method when there is none. That left a user with no card
 * on file having to complete a card-saving step (Elements or a hosted setup
 * session) purely so a second request could then charge it — two payment UIs,
 * two round trips, and an abandoned SetupIntent whenever they dropped out.
 *
 * Client decision: a user with no payment method goes STRAIGHT to checkout. One
 * hosted page collects the card, takes the first payment and creates the
 * subscription, which is also the flow Stripe hardens (3DS/SCA, wallets, local
 * payment methods) without us reimplementing any of it.
 *
 * ── How this differs from /create-checkout-session and /upgrade-plan ────────
 * Both of those bind the session with `customer_email`, which makes Stripe mint
 * a NEW customer for every checkout — the card then lands on a customer that is
 * not the one users.stripe_customer_id points at, so Settings shows no saved
 * card afterwards. This reuses (or creates, once) the user's real customer.
 * They also price with ad-hoc `price_data` rather than the plan's configured
 * Stripe price. This uses stripe_price_id, so what the customer is charged is
 * the price the plan is actually sold at.
 *
 * ── Activation ─────────────────────────────────────────────────────────────
 * Nothing is granted here. The session carries user_id + plan_id BOTH on itself
 * and on the subscription it creates, and activation happens in exactly the two
 * places it already did — /verify-session on return, and the webhook — which
 * are idempotent with each other. A checkout that is abandoned or declined
 * therefore leaves no trace in our database at all.
 */
router.post('/create-subscription-checkout', async (req: Request, res: Response) => {
  try {
    const { user_id, plan_id, success_url, cancel_url, interval, idempotency_key } = z.object({
      user_id: z.number(),
      plan_id: z.number(),
      success_url: z.string().url(),
      cancel_url: z.string().url(),
      // Monthly or annual. Defaults to monthly so an un-updated client keeps
      // its existing behaviour rather than silently switching interval.
      interval: z.enum(['month', 'year']).default('month'),
      // Same contract as /subscribe-to-plan: one key per confirm action, reused
      // across retries, so a double-clicked button cannot open two checkouts.
      idempotency_key: z.string().min(8).max(200).optional()
    }).parse(req.body);

    // A subscription is a purchase, so the same address rule applies here as on
    // every other money-moving endpoint. Checked BEFORE any Stripe object is
    // created, so a blocked user leaves nothing behind.

    const [userResult, planResult] = await Promise.all([
      sql`SELECT id, email, stripe_customer_id FROM users WHERE id = ${user_id}`,
      sql`SELECT * FROM subscription_plans WHERE id = ${plan_id}`
    ]);

    if (userResult.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (planResult.length === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const user = userResult[0];
    const plan = planResult[0];

    if (plan.price_cents === 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot subscribe to the free plan via checkout'
      });
    }

    // Resolves to the yearly price when asked for and configured, otherwise
    // monthly — `chosen` is what actually gets billed and is recorded below.
    const { priceId, interval: chosen } = priceForPlan(plan, interval);
    if (!priceId) {
      return res.status(500).json({
        success: false,
        error: 'Stripe Price ID not configured for this plan. Please contact support.'
      });
    }

    // ── The guard that keeps this endpoint safe ──────────────────────────────
    // Checkout in `mode: 'subscription'` CREATES a subscription. Running it for
    // someone who already has one would leave them holding two, billed twice,
    // with our single-row subscriptions table only able to remember the second.
    // A plan CHANGE is /change-plan's job — it prorates against the existing
    // subscription instead of starting a parallel one.
    const existing = await getUserSubscription(user_id);
    const liveStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
    if (existing?.stripe_subscription_id && liveStatuses.includes(String(existing.status))) {
      return res.status(409).json({
        success: false,
        error: 'You already have a subscription. Change your plan instead of starting a new one.',
        code: 'SUBSCRIPTION_EXISTS'
      });
    }

    // Reuse the customer we already know about; create one only the first time.
    // Same shape as /create-setup-intent, deliberately — one user must never end
    // up with two Stripe customers.
    let customerId = user.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user_id.toString() }
      });
      customerId = customer.id;
      await sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${user_id}`;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      // Stripe collects the billing address here — that is what replaced the
      // signup field, the dashboard reminder and the pre-purchase gate.
      billing_address_collection: 'required',
      // …and writes it back onto the Customer, so the address the user gave
      // at checkout is the one on the account afterwards. Without this the
      // Customer keeps whatever it had, and the next invoice is issued against a stale one.
      customer_update: { address: 'auto' },
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // The card is kept on the customer, so renewals and every later upgrade
      // run off a saved payment method rather than sending the user back here.
      payment_method_collection: 'always',
      success_url: withSessionId(success_url),
      cancel_url: cancel_url,
      client_reference_id: user_id.toString(),
      // On the SESSION for /verify-session, and on the SUBSCRIPTION for the
      // customer.subscription.created webhook. Both readers need the plan; the
      // webhook never sees the session, and without plan_id it would fall back
      // to the user's CURRENT (free) plan and grant the wrong credits.
      metadata: {
        user_id: user_id.toString(),
        plan_id: plan_id.toString(),
        billing_interval: chosen
      },
      subscription_data: {
        metadata: {
          user_id: user_id.toString(),
          plan_id: plan_id.toString(),
          billing_interval: chosen
        }
      }
    }, idempotencyKeyFor('subscription-checkout', user_id, idempotency_key));

    console.log(`🧾 Checkout session ${session.id} opened for user ${user_id} → ${plan.name}`);

    res.json({
      success: true,
      data: {
        session_id: session.id,
        url: session.url,
        plan_name: plan.name,
        price_cents: chosen === 'year' ? plan.price_cents_yearly : plan.price_cents,
        interval: chosen
      }
    });

  } catch (error) {
    console.error('Create subscription checkout error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start checkout'
    });
  }
});

/**
 * Preview what a plan change will cost, WITHOUT committing to it.
 * POST /api/v1/stripe/preview-plan-change
 *
 * Bug 6: the prorated amount was only revealed in the post-confirm success
 * message — the user committed to a charge before being told its size.
 *
 * ── Why a proration_date is returned, and why it matters ────────────────────
 * Stripe computes proration relative to an instant. Preview at 10:00:00 and
 * commit at 10:00:07 and the two amounts can differ, because a few more
 * seconds of the old plan have been consumed. Showing one number and charging
 * another — even by a cent — is exactly the kind of billing discrepancy that
 * generates support tickets and chargebacks.
 *
 * So the preview pins the instant it priced and hands it back; /change-plan
 * accepts that same timestamp and passes it to Stripe. The quote is then
 * honoured exactly. This is Stripe's documented pattern for upgrade previews.
 */
router.post('/preview-plan-change', async (req: Request, res: Response) => {
  try {
    const { user_id, new_plan_id } = z.object({
      user_id: z.number(),
      new_plan_id: z.number()
    }).parse(req.body);

    const currentSub = await getUserSubscription(user_id);
    const [currentPlanData, newPlanData, defaultPm] = await Promise.all([
      currentSub ? sql`SELECT * FROM subscription_plans WHERE id = ${currentSub.plan_id}` : Promise.resolve([] as any[]),
      sql`SELECT * FROM subscription_plans WHERE id = ${new_plan_id}`,
      // BILL-003 — "the specific payment method that will be charged (brand +
      // last four)" is part of the disclosure. Read locally rather than from
      // Stripe so a slow provider degrades the detail, never blocks the quote.
      getLocalDefaultPaymentMethod(sql, user_id),
    ]);

    if (newPlanData.length === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    const newPlan = newPlanData[0];
    const currentPlan = currentPlanData[0] ?? null;

    const paymentMethod = defaultPm
      ? { brand: defaultPm.brand, last4: defaultPm.last4 }
      : null;

    /**
     * Record the disclosure, then return it with its handle.
     *
     * Every exit from this endpoint goes through here, so there is no quote a
     * customer can act on that we did not first write down. The handle comes
     * back on confirm, which is what lets settleDisclosure compare what was
     * shown against what was charged.
     */
    const serve = async (quote: ProrationQuote) => {
      const disclosureId = await recordDisclosure(sql, {
        userId: user_id,
        fromPlanId: currentSub?.plan_id ?? null,
        toPlanId: new_plan_id,
        quote,
      });
      return res.json({
        success: true,
        data: { ...quote, disclosure_id: disclosureId ?? undefined },
      });
    };

    // ── First subscription: nothing to prorate, the full price is due ──────
    //
    // The status check is the part that was missing. A customer who subscribed,
    // cancelled, and came back to the free trial still HAS a subscriptions row
    // carrying a stripe_subscription_id — so this branch missed, and their next
    // purchase was priced as a mid-cycle plan CHANGE: prorated against a
    // subscription that is no longer running, which is both wrong and
    // unanswerable (there is no live period to prorate within, which is why the
    // amount could not be calculated at all).
    //
    // A subscription that is not live is not a subscription for pricing
    // purposes. Same shared status set the banner and the jobs use.
    if (!currentSub || !currentSub.stripe_subscription_id || !isLiveStatus(currentSub.status)) {
      return serve({
        is_upgrade: true,
        is_first_subscription: true,
        prorated: false,
        amount_due_cents: newPlan.price_cents,
        currency: 'usd',
        proration_date: null,
        effective: 'immediate',
        new_plan: newPlan.name,
        next_amount_cents: newPlan.price_cents,
        description: 'You will be charged the full plan price to start this subscription.',
        lines: [{ description: `${newPlan.name} — first month`, amount_cents: newPlan.price_cents }],
        payment_method: paymentMethod,
        // A first subscription pays a full month and receives a full month.
        // refillPlanCredits SETS the balance to the allotment rather than
        // adding to it, so the whole allotment is what lands.
        credits: {
          granted_now: grantForPlanSlug(newPlan.slug),
          full_difference: grantForPlanSlug(newPlan.slug),
          new_allotment: grantForPlanSlug(newPlan.slug),
          prorated: false,
        },
      });
    }

    const isUpgrade = newPlan.price_cents > currentPlan.price_cents;

    // ── Reactivation: re-picking the plan you are already on while cancelling ──
    if (new_plan_id === currentSub.plan_id && currentSub.cancel_at_period_end) {
      return serve({
        is_upgrade: false,
        is_reactivation: true,
        is_first_subscription: false,
        prorated: false,
        amount_due_cents: 0,
        currency: 'usd',
        proration_date: null,
        effective: 'immediate',
        next_billing_date: currentSub.next_billing_date,
        next_amount_cents: newPlan.price_cents,
        new_plan: newPlan.name,
        current_plan: currentPlan?.name ?? null,
        description: 'Your cancellation will be reversed and your plan continues as normal. Nothing is charged today.',
        lines: [],
        payment_method: paymentMethod,
      });
    }

    // ── Downgrade: scheduled, not prorated, so nothing is owed today ───────
    if (!isUpgrade) {
      // The balance the dialog reassures them about: "your current 1,240
      // credits will remain unaffected". Best effort — a failed read costs one
      // clause of the sentence, never the quote, and the CMS drops the clause
      // rather than printing "your current 0 credits" at someone who has some.
      let currentCredits: number | null = null;
      try {
        currentCredits = (await getLiveBalance(user_id)).total;
      } catch (balanceErr) {
        console.error('⚠️ Could not read the balance for the downgrade quote:', balanceErr);
      }

      return serve({
        current_credits: currentCredits,
        is_upgrade: false,
        is_first_subscription: false,
        prorated: false,
        amount_due_cents: 0,
        currency: 'usd',
        proration_date: null,
        effective: 'period_end',
        effective_date: currentSub.next_billing_date,
        next_billing_date: currentSub.next_billing_date,
        next_amount_cents: newPlan.price_cents,
        current_plan: currentPlan?.name ?? null,
        new_plan: newPlan.name,
        description: 'No charge today. Your new plan starts at the end of the current billing period.',
        lines: [],
        payment_method: paymentMethod,
        // Nothing is granted today — the current plan's credits stay as they
        // are until the period ends. Naming the date stops "your allotment
        // becomes 220" reading as "your balance drops to 220 right now".
        credits: {
          granted_now: 0,
          full_difference: 0,
          new_allotment: grantForPlanSlug(newPlan.slug),
          prorated: false,
          effective_date: currentSub.next_billing_date,
        },
      });
    }

    // Same precondition the commit path enforces — fail here rather than
    // quoting a change that /change-plan will then refuse.
    if (!newPlan.stripe_price_id) {
      return res.status(500).json({
        success: false,
        error: 'Stripe Price ID not configured for the selected plan. Please contact support.'
      });
    }

    const stripeSubscription = await stripe.subscriptions.retrieve(currentSub.stripe_subscription_id);
    const itemId = stripeSubscription.items.data[0]?.id;
    if (!itemId) {
      return res.status(500).json({ success: false, error: 'Subscription has no billable items' });
    }

    // Every figure below comes from Stripe. See services/billing/proration.ts
    // for why none of it is computed here. The period start lets the quote be
    // priced from the start of today's billing day rather than to the second
    // (dayAlignedProrationDate).
    const quote = await previewUpgrade(stripe, {
      customerId: stripeSubscription.customer as string,
      subscriptionId: currentSub.stripe_subscription_id,
      subscriptionItemId: itemId,
      newPriceId: newPlan.stripe_price_id,
      periodStart: periodStartOf(stripeSubscription),
    });

    // ── The period this quote is priced against ──────────────────────────────
    //
    // From the SUBSCRIPTION WE JUST RETRIEVED, not from our own column. Stripe
    // prorated the amounts above against this instant, so every date and day
    // count in the dialog has to be measured from the same one — that is the
    // whole defect QA hit: correct cents next to a day count and a renewal date
    // taken off a stale, separately-derived value, which made the cents look
    // wrong. The stored column is the fallback, for the case where Stripe's
    // payload has no period at all.
    const periodEnd = periodEndOf(stripeSubscription);
    const periodEndIso = periodEnd !== null
      ? new Date(periodEnd * 1000).toISOString()
      : (currentSub.next_billing_date ?? null);

    // The other half of the transaction. The money above is prorated by Stripe;
    // the credits are prorated by us, and until now the customer was told about
    // the first and left to guess the second.
    const creditGrant = await previewUpgradeCreditGrant(
      user_id,
      newPlan,
      periodEndIso,
    );

    // ── What the dialog needs to explain the bill ────────────────────────────
    //
    // Grouped by the change that produced each pair of lines, so a second
    // upgrade in the same period reads as two decisions rather than four
    // accounting entries, and named from each line's price because Stripe's
    // description says only "ImproveSEO Subscription". The prices also pick out
    // this change's pair when an earlier one shares today's proration instant.
    const changes = await nameChangeGroups(
      sql,
      groupProrationLines(quote.lines, quote.prorationDate, {
        newPriceId: newPlan.stripe_price_id,
        currentPriceId: stripeSubscription.items.data[0]?.price?.id ?? null,
      }),
    );

    // The balance the grant lands on. Read here rather than in the dialog: that
    // component's rule is that it computes nothing, because a figure it worked
    // out itself is a figure that can disagree with the invoice.
    let balanceAfter: number | null = null;
    try {
      balanceAfter = (await getLiveBalance(user_id)).total + creditGrant.granted_now;
    } catch (balanceErr) {
      // Costs one clause of the copy, never the quote.
      console.error('⚠️ Could not read the balance for the upgrade preview:', balanceErr);
    }

    // Whole days left, for "the N days left in this period" — measured from the
    // SAME instant Stripe priced (the start of today's billing day), so the
    // label and the amounts describe one window. Ceil only matters in the
    // fallback where the period start was unknown and pricing stayed per-second.
    const daysRemaining = periodEndIso
      ? Math.max(0, Math.ceil(
        (new Date(periodEndIso).getTime() - quote.prorationDate * 1000) / 86_400_000,
      ))
      : null;

    return serve({
      is_upgrade: true,
      is_first_subscription: false,
      prorated: true,
      // Net of the credit for unused time on the old plan and the charge for
      // the new one. Legitimately negative at some cycle positions.
      amount_due_cents: quote.amountDueCents,
      currency: quote.currency,
      proration_date: quote.prorationDate,
      effective: 'immediate',
      // Stripe's anchor, so "Then $X per month, starting …" names the day the
      // amounts above were actually prorated to.
      next_billing_date: periodEndIso,
      next_amount_cents: newPlan.price_cents,
      current_plan: currentPlan?.name ?? null,
      new_plan: newPlan.name,
      description: quote.amountDueCents > 0
        ? 'You will be charged this prorated amount now, covering the rest of the current billing period. Your credits are topped up straight away.'
        : 'No charge is due now — the unused portion of your current plan covers the change.',
      lines: quote.lines,
      changes,
      days_remaining: daysRemaining,
      payment_method: paymentMethod,
      credits: {
        granted_now: creditGrant.granted_now,
        full_difference: creditGrant.full_difference,
        new_allotment: creditGrant.new_allotment,
        previous_allotment: creditGrant.previous_allotment,
        balance_after: balanceAfter,
        prorated: creditGrant.prorated,
      },
    });

  } catch (error) {
    console.error('Preview plan change error:', error);
    // BILL-003 — the CMS BLOCKS confirmation on this failure, so the message
    // has to explain that nothing has happened rather than sounding like a
    // charge may have gone through.
    res.status(400).json({
      success: false,
      error: 'We could not work out what this change will cost. Nothing has been charged. Please try again in a moment.'
    });
  }
});

/**
 * Change subscription plan (upgrade or downgrade)
 * POST /api/v1/stripe/change-plan
 */
router.post('/change-plan', async (req: Request, res: Response) => {
  // Hoisted to the route scope: both are set inside the Stripe branch below but
  // read again when the response is built, so the confirmation the customer
  // sees quotes the same figures the ledger row recorded.
  let proratedCents: number | null = null;
  let charge: Awaited<ReturnType<typeof chargeProrationNow>> | null = null;
  // The upgrade's ledger row, kept so the credits it granted can be settled
  // into it once changePlan reports them — see where it is written. Held as
  // the whole input rather than just its key: re-listing the fields for the
  // second call is how a settle ends up contradicting the row it settles.
  let upgradeLedgerRow: RecordTransactionInput | null = null;
  try {
    // `proration_date` is the timestamp returned by /preview-plan-change. When
    // present it is replayed to Stripe so the customer is charged exactly the
    // amount they were quoted (bug 6). Optional — a caller that skips the
    // preview still works, it just prices at "now".
    const { user_id, new_plan_id, proration_date, idempotency_key, disclosure_id } = z.object({
      user_id: z.number(),
      new_plan_id: z.number(),
      proration_date: z.number().int().positive().optional(),
      // BILL-002 — see idempotencyKeyFor. An upgrade raises a real invoice, so
      // a double submit here charges twice without this.
      idempotency_key: z.string().min(8).max(200).optional(),
      // BILL-003 — the quote the customer accepted, so the charge can be
      // reconciled against what they were shown.
      disclosure_id: z.string().uuid().optional()
    }).parse(req.body);

    // Get current subscription
    const currentSub = await getUserSubscription(user_id);
    
    // If no subscription = FREE tier user trying to upgrade
    // The status check mirrors preview-plan-change: a cancelled or paused row
    // is not a subscription to CHANGE, it is a subscription to start. Without
    // it the quote and the commit disagreed — the preview correctly priced a
    // returning customer at full price while this path tried to prorate them
    // against a dead subscription.
    if (!currentSub || !isLiveStatus(currentSub.status)) {
      return res.status(400).json({
        success: false,
        error: 'No active subscription. Use /subscribe-to-plan endpoint for first subscription.',
        requires_checkout: true
      });
    }

    // Get plan details
    const [currentPlanData, newPlanData] = await Promise.all([
      sql`SELECT * FROM subscription_plans WHERE id = ${currentSub.plan_id}`,
      sql`SELECT * FROM subscription_plans WHERE id = ${new_plan_id}`
    ]);

    if (newPlanData.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'New plan not found'
      });
    }

    const currentPlan = currentPlanData[0];
    const newPlan = newPlanData[0];
    const isUpgrade = newPlan.price_cents > currentPlan.price_cents;

    // Billing-address gate, applied to UPGRADES ONLY on this endpoint.
    //
    // An upgrade raises a real invoice immediately, so it is a purchase and
    // needs an address. A downgrade does not charge — it queues a change for
    // period end — and blocking it would stop a user without an address from
    // REDUCING their spend, which is the wrong way round. Reactivation below is
    // likewise not a new charge. Cancelling has its own endpoint and is never
    // gated, so nobody can be trapped in a subscription.

    // ── RE-PICKING THE PLAN A DOWNGRADE IS ALREADY QUEUED FOR ─────────────────
    // Scale → Optimize is scheduled, and Optimize is chosen a second time. This
    // was accepted in full: the same price was re-sent to Stripe, changePlan
    // re-wrote an identical row, a second billing_disclosures row was spent on
    // the quote, and the caller got a fresh "downgrade scheduled" confirmation
    // indistinguishable from the first one.
    //
    // It reads like the guard below should have caught it, and it does not:
    // that one is nested inside `new_plan_id === currentSub.plan_id`, and during
    // a pending downgrade `plan_id` is still the CURRENT plan — so for the
    // queued plan the comparison is false and the whole block is skipped.
    //
    // Answered as "nothing changed", in the same shape as that guard, rather
    // than as an error: the customer asked for a state the account is already
    // in, which is not a failure. `cancel_at_period_end` is excluded because a
    // subscription that is winding down needs the reactivation path below, not
    // this one.
    if (
      currentSub.pending_plan_id === new_plan_id
      && new_plan_id !== currentSub.plan_id
      && !currentSub.cancel_at_period_end
    ) {
      return res.json({
        success: true,
        message: `Your plan is already scheduled to move to ${newPlan.name}. Nothing has changed and you were not charged.`,
        immediate: false,
        unchanged: true,
        new_plan: newPlan.name,
        effective_date: currentSub.pending_plan_effective_date || currentSub.next_billing_date,
      });
    }

    // BUG 10 — REACTIVATION. Re-picking the plan you are already on while a
    // cancellation is scheduled is the most natural way to "resubscribe", and
    // it was the one path that silently did the wrong thing: same price means
    // isUpgrade === false, so it fell into the DOWNGRADE branch, queued a
    // pointless pending_plan change, and never cleared cancel_at_period_end —
    // leaving the "Cancellation Scheduled" banner up forever.
    //
    // Treat it as what the user means: keep the subscription running. No
    // proration, no credit grant — nothing about the plan is changing.
    if (new_plan_id === currentSub.plan_id) {
      // ── RE-PICKING THE PLAN YOU ALREADY HOLD ──────────────────────────────
      // Two cases, and both used to end up in the DOWNGRADE branch because the
      // prices are equal so isUpgrade is false:
      //
      //   cancelling  → the user pressed "Reactivate". They were answered with
      //                 "Plan downgrade scheduled…", which is not what they
      //                 asked for and not what happened.
      //   not cancelling → a no-op, which was turned into a scheduled DOWNGRADE
      //                 TO THE PLAN THEY ARE ON. Two accounts were found sitting
      //                 in that state, queued to "change" to their own plan.
      //
      // Neither is a downgrade. Handled here, before the price comparison can
      // mislabel them.
      if (!currentSub.cancel_at_period_end && !currentSub.pending_plan_id) {
        return res.json({
          success: true,
          message: `You are already on ${newPlan.name}. Nothing has changed and you were not charged.`,
          immediate: true,
          unchanged: true,
          new_plan: newPlan.name,
        });
      }

      // BILL-005 — clears the flag on the subscription AND releases any leftover
      // schedule object. A schedule survives a subscriptions.update, and one
      // carrying a cancellation will still end the subscription weeks later,
      // with the customer having every reason to think they resubscribed.
      const { releasedSchedules } = await clearScheduledCancellation(
        { sql, stripe },
        {
          userId: user_id,
          stripeSubscriptionId: currentSub.stripe_subscription_id,
          stripeCustomerId: currentSub.stripe_customer_id,
        },
      );

      // ── FULL RESET, not just the cancel flag ──────────────────────────────
      // Clearing cancel_at_period_end alone left status at 'pending_downgrade'
      // with pending_plan_id still set, so after reactivating, the account was
      // STILL queued to change plan — Settings announced a change to Grow, the
      // Reactivate button stayed on screen, and the plan was simultaneously
      // "ending" and "changing". Reactivate means: keep THIS plan running.
      //
      // users.plan_id is written in the same statement set because the header
      // badge reads its plan from `users` while this page reads `subscriptions`
      // — and a path that updates one without the other is how an account came
      // to show "Scale" and "Free Trial" at the same time.
      await sql.begin(async (tx) => {
        await tx`
          UPDATE subscriptions
          SET    status = 'active',
                 cancel_at_period_end = FALSE,
                 cancelled_at = NULL,
                 pending_plan_id = NULL,
                 pending_plan_effective_date = NULL
          WHERE  user_id = ${user_id}
        `;
        await tx`UPDATE users SET plan_id = ${currentSub.plan_id}, updated_at = NOW() WHERE id = ${user_id}`;
      });

      console.log(
        `✅ Reactivated subscription for user ${user_id} (${newPlan.name})` +
        (releasedSchedules.length ? ` — released ${releasedSchedules.length} orphaned schedule(s)` : ''),
      );

      // Account Activity: the counterpart to the cancellation row written by
      // /cancel-subscription. Without it the ledger shows an account being
      // cancelled and then simply continuing to bill, with nothing explaining
      // why. No money moves — see the cancellation row for why that is null
      // rather than 0 — and the key matches the cancellation's period so the
      // pair reads as one reversible decision.
      await recordTransaction(sql, {
        userId: user_id,
        type: 'plan_grant',
        description: describeSubscriptionReactivated(newPlan.name),
        amountCents: null,
        status: 'succeeded',
        providerEventId: `reactivate:${currentSub.stripe_subscription_id ?? user_id}:${currentSub.next_billing_date ?? 'na'}`,
        planId: currentSub.plan_id ?? null,
      });

      // The balance, so the confirmation can say the credits survived — the
      // thing people most fear losing when they undo a cancellation. Best
      // effort: a failed read costs one sentence, never the reactivation.
      let reactivationCredits: number | null = null;
      try {
        reactivationCredits = (await getLiveBalance(user_id)).total;
      } catch (balanceErr) {
        console.error('⚠️ Could not read the balance for the reactivation notice:', balanceErr);
      }

      return res.json({
        success: true,
        // Shared wording with the CMS's own Reactivate Plan button — see
        // services/billing/descriptions.ts. Reactivation is reachable from two
        // places and must read identically from both.
        message: reactivationConfirmation({
          planName: newPlan.name,
          nextBillingDate: currentSub.next_billing_date,
          credits: reactivationCredits,
        }),
        immediate: true,
        reactivated: true,
        effective_date: new Date().toISOString(),
        new_plan: newPlan.name,
      });
    }

    // ── BILL-005, widened: releasing the schedule is not only for reactivation ──
    //
    // The branch above only fires when the chosen plan IS the current one. A
    // customer who cancels Optimize and then picks Scale is making the same
    // statement — "I am staying" — but took the ordinary change path, which
    // cleared cancel_at_period_end in OUR row and left the schedule standing at
    // the provider.
    //
    // The visible symptom was a "Cancellation Scheduled" banner that would not
    // go away. The unseen one is worse: the schedule still ends the
    // subscription at period end, so a customer who deliberately resubscribed
    // onto a HIGHER plan is cancelled weeks later anyway.
    //
    // Runs before the subscriptions.update below, because a schedule left in
    // place can override the very change we are about to make.
    if (currentSub.cancel_at_period_end) {
      const { releasedSchedules } = await clearScheduledCancellation(
        { sql, stripe },
        {
          userId: user_id,
          stripeSubscriptionId: currentSub.stripe_subscription_id,
          stripeCustomerId: currentSub.stripe_customer_id,
        },
      );
      console.log(
        `✅ Cleared scheduled cancellation for user ${user_id} — changing to ${newPlan.name}` +
        (releasedSchedules.length ? ` (released ${releasedSchedules.length} orphaned schedule(s))` : ''),
      );
    }

    // Validate that Stripe Price IDs are configured
    if (!newPlan.stripe_price_id) {
      return res.status(500).json({
        success: false,
        error: 'Stripe Price ID not configured for the selected plan. Please contact support.'
      });
    }

    // BILL-001 — an UPGRADE raises a prorated invoice immediately, so it needs a
    // chargeable card exactly as much as a first subscription does. This path
    // never checked. A subscriber whose default card had been detached (or who
    // had cards but no default, the original bug) reached
    // subscriptions.update, which failed at invoice time and surfaced as a raw
    // Stripe message under a 500 — reading as our fault, and offering the user
    // nothing to do about it.
    //
    // Downgrades are exempt: proration_behavior is 'none' and nothing is
    // charged today, so demanding a card would block a user trying to reduce
    // their spend, which is the worst possible moment to do it.
    if (isUpgrade) {
      const customerRow = await sql`SELECT stripe_customer_id FROM users WHERE id = ${user_id}`;
      const customerId = customerRow[0]?.stripe_customer_id as string | undefined;
      const defaultPm = customerId
        ? await ensureDefaultPaymentMethod(user_id, customerId)
        : null;
      if (!defaultPm) {
        return res.status(400).json({
          success: false,
          error: 'Add a card to complete this upgrade.',
          requires_payment_method: true,
        });
      }
    }

    // Update Stripe subscription if exists
    if (currentSub.stripe_subscription_id) {
      try {
        console.log(`🔄 Updating Stripe subscription ${currentSub.stripe_subscription_id}`);
        console.log(`📊 ${isUpgrade ? 'UPGRADE' : 'DOWNGRADE'}: ${currentPlan.name} → ${newPlan.name}`);

        // Retrieve current subscription to get the subscription item ID
        const stripeSubscription = await stripe.subscriptions.retrieve(
          currentSub.stripe_subscription_id
        );

        if (!stripeSubscription.items.data[0]) {
          throw new Error('No subscription items found');
        }

        // Update subscription with new price.
        //
        // proration_date (bug 6): replaying the timestamp the user was quoted
        // at guarantees Stripe charges the amount shown in the confirm dialog.
        // Without it Stripe prices at "now", which drifts from the preview by
        // however long the user spent reading it.
        //
        // cancel_at_period_end (bug 10): a user who cancelled and then picked a
        // new plan is plainly not cancelling any more. Clearing it here is what
        // makes the stale "Cancellation Scheduled" banner go away for real —
        // the CMS reads this state back, so it cannot be fixed frontend-side.
        //
        // OLD:
        //   await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
        //     items: [{ id: stripeSubscription.items.data[0].id, price: newPlan.stripe_price_id }],
        //     proration_behavior: isUpgrade ? 'create_prorations' : 'none',
        //     billing_cycle_anchor: 'unchanged'
        //   });
        // BILL-003 — replaying the quoted timestamp is what makes the preview
        // BINDING: without it Stripe prices at commit time, which drifts from
        // the quote by however long the customer spent reading the dialog, and
        // "the displayed total matches the amount charged to the cent" is then
        // not true.
        //
        // This was previously behind BILLING_PRORATION_DATE_ENABLED, default
        // off, because Stripe REJECTS a proration_date outside the current
        // period — so a stale dialog would turn into a failed upgrade. A flag
        // is the wrong answer to that: it makes the accurate behaviour the
        // exception, and leaves the ticket's central criterion unmet in
        // production.
        //
        // The right answer is to handle the rejection. We send the quoted
        // timestamp; if Stripe refuses it as out of range (the period renewed
        // while the dialog was open), we retry once with the start of today's
        // billing day in the NEW period. The customer gets an exact quote in the
        // overwhelmingly common case and a working upgrade in the rare stale
        // one, instead of one or the other by configuration.
        //
        // Never plain "now": that is per-second proration, whose odd cents are
        // what dayAlignedProrationDate exists to remove. A caller that skipped
        // the preview is priced the same whole-day way.
        const alignedToday = () => dayAlignedProrationDate(
          periodStartOf(stripeSubscription),
          Math.floor(Date.now() / 1000),
        );
        const applyPlanChange = (prorationDate: number) =>
          stripe.subscriptions.update(currentSub.stripe_subscription_id!, {
            items: [{
              id: stripeSubscription.items.data[0].id,
              price: newPlan.stripe_price_id, // ✅ Change the price
            }],
            proration_behavior: isUpgrade ? 'create_prorations' : 'none',
            billing_cycle_anchor: 'unchanged', // Keep same billing date
            cancel_at_period_end: false,
            ...(isUpgrade ? { proration_date: prorationDate } : {}),
          }, idempotencyKeyFor('change-plan', user_id, idempotency_key));

        try {
          await applyPlanChange(proration_date ?? alignedToday());
        } catch (prorationError: any) {
          // Only an out-of-range proration_date is retried. Anything else —
          // a declined card, a missing price — must surface, or a real failure
          // would be silently retried into a second charge attempt.
          const isStaleQuote =
            prorationError?.type === 'StripeInvalidRequestError'
            && /proration_date/i.test(String(prorationError?.message || ''));

          if (!isStaleQuote || !proration_date) throw prorationError;

          console.warn(
            `⚠️ Quoted proration_date ${proration_date} was rejected as out of range for user ${user_id}; ` +
            'repricing from the start of today in the current period. The customer may be charged ' +
            'differently from the quote — settleDisclosure below will record it if so.',
          );
          await applyPlanChange(alignedToday());
        }

        console.log(`✅ Stripe subscription updated successfully`);

        // BILL-005 — choosing a plan is an unambiguous "I am staying", so any
        // schedule left over from an earlier cancellation must go too. The
        // update above clears cancel_at_period_end but does NOT touch a
        // schedule object, which is the silent failure this ticket names.
        if (currentSub.stripe_customer_id) {
          await releaseOrphanedSchedules(stripe, currentSub.stripe_customer_id);
        }

        // BILL-003 — close out the disclosure with what Stripe ACTUALLY billed,
        // and shout if it differs from what the customer was shown by more than
        // rounding.
        //
        // Computed once and reused by the ledger write below, so the audit row
        // and the customer-visible transaction can never quote two figures.
        if (isUpgrade) {
          try {
            const upcoming = await stripe.invoices.createPreview({
              customer: stripeSubscription.customer as string,
              subscription: currentSub.stripe_subscription_id,
            });
            proratedCents = (upcoming.lines?.data ?? [])
              .filter(isProrationLine)
              .reduce((sum: number, line: any) => sum + (line.amount || 0), 0);
            if (disclosure_id) await settleDisclosure(sql, disclosure_id, proratedCents);
          } catch (settleErr) {
            // Never fail a completed plan change over an audit write.
            console.error('⚠️ Could not reconcile the disclosure after the change:', settleErr);
          }
        }

        // ── Bill the proration NOW, because that is what we told the customer ──
        //
        // `create_prorations` above only ATTACHES the adjustment as a pending
        // invoice item; Stripe bills it on the next regular invoice. That
        // contradicted every message the product showed:
        //
        //   preview  "You will be charged this prorated amount now"
        //   dialog   "Prorated charge applied"
        //   ledger   "(prorated, billed on your next invoice)", status pending
        //
        // Three statements about one payment, and only the last was true. The
        // customer reported exactly that. Nothing settled the pending row
        // either — when the next invoice paid, its lines arrived under a
        // different idempotency namespace and became SEPARATE rows, so the
        // upgrade appeared twice and the first copy stayed pending forever.
        //
        // Invoicing here makes the first two true and removes the need for the
        // third. If it fails, the plan change still stands (Stripe has already
        // applied it), the charge falls back to the next invoice, and the row
        // below records `pending` — which is then accurate, not contradictory.
        if (isUpgrade && stripeSubscription.customer) {
          charge = await chargeProrationNow(stripe, {
            customerId: stripeSubscription.customer as string,
            subscriptionId: currentSub.stripe_subscription_id!,
            // Namespaced off the caller's key so a retried plan change cannot
            // bill the proration a second time.
            idempotencyKey: idempotency_key
              ? `charge-proration:${user_id}:${idempotency_key}`
              : undefined,
          });
          // A "paid" $0 against a proration the preview says is owed means the
          // invoice collected nothing — the failure chargeProrationNow had
          // before it included pending items. Report it as not collected, so
          // the ledger says pending instead of claiming a payment that did not
          // happen; Stripe still bills the item on the renewal invoice.
          if (charge.paid && charge.amountCents === 0 && (proratedCents ?? 0) > 0) {
            console.error(
              `🚨 Upgrade invoice for user ${user_id} collected $0 while ${proratedCents} was owed; `
              + 'recording the charge as pending.',
            );
            charge = { ...charge, paid: false, error: 'invoice collected nothing' };
          }
          if (charge.paid) {
            console.log(`💳 Prorated charge of ${charge.amountCents} collected for user ${user_id}`);
            // What Stripe actually took beats the preview's estimate.
            if (charge.amountCents > 0) proratedCents = charge.amountCents;
          } else {
            console.warn(
              `⚠️ Prorated charge not collected for user ${user_id} (${charge.error}); `
              + 'it stays pending and Stripe will bill it on the next invoice.',
            );
          }
        }

        // ── BILL-004 — record the ledger row HERE, not only from the webhook ──
        //
        // recordTransaction was called from applyCreditTopupOnce and from two
        // webhook handlers, but never from this route. A plan change therefore
        // reached "Recent Transactions" only if `invoice.payment_succeeded` was
        // delivered — so the list showed a credit top-up and nothing at all for
        // the upgrade that had just been paid for.
        //
        // Two reasons that is the wrong dependency, and they are the same two
        // that made activateSubscriptionInDb synchronous:
        //   • a misconfigured or down webhook endpoint means the customer is
        //     charged and the event is never recorded — permanently, since
        //     nothing re-derives it;
        //   • Stripe cannot reach localhost, so the behaviour was untestable in
        //     development, which is why it went unnoticed.
        //
        // ── WHY THIS IS NOT READ FROM AN INVOICE ────────────────────────────
        // The obvious implementation — list the subscription's latest invoice
        // and run transactionsFromInvoice over it — was written first and does
        // NOT work here. `proration_behavior: 'create_prorations'` (above) does
        // not raise an invoice today: it attaches the adjustments as PENDING
        // invoice items, to be billed on the next regular invoice. So the most
        // recent invoice is the previous cycle's, already in the ledger, and
        // re-recording it merely hit the ON CONFLICT branch and inserted
        // nothing. That is exactly what the first attempt did.
        //
        // So the row written here describes the PLAN CHANGE, not an invoice:
        // status 'pending', because the money is owed but not yet billed, and a
        // key in its own namespace (`plan_change:…`) that can never collide
        // with the webhook's per-line `invoice_line:<id>` keys. When the next
        // invoice is paid, those lines land as their own settled rows and this
        // one has already told the customer what happened, on the day it did.
        //
        // `proratedCents` comes from the same preview that settled the
        // disclosure, so the ledger and the audit trail cannot disagree.
        try {
          if (isUpgrade) {
            upgradeLedgerRow = {
              userId: user_id,
              type: 'plan_upgrade',
              description: describePlanUpgraded(currentPlan.name, newPlan.name),
              amountCents: proratedCents,
              currency: charge?.currency || 'usd',
              // The status now REPORTS the charge rather than asserting one.
              // It reads 'pending' only in the fallback case where collection
              // genuinely did not happen, so a customer never again sees a row
              // marked pending for money that has already left their account.
              status: charge?.paid === false ? 'pending' : 'succeeded',
              // The paid invoice, so the row carries a real receipt like every
              // other settled charge does.
              receiptUrl: charge?.receiptUrl ?? null,
              // Namespaced and pinned to the moment of the change, so a second
              // upgrade in the same cycle records separately.
              providerEventId:
                `plan_change:${currentSub.stripe_subscription_id}:${new_plan_id}:${Math.floor(Date.now() / 1000)}`,
              providerObjectId: charge?.invoiceId || currentSub.stripe_subscription_id,
              planId: new_plan_id,
            };
            await recordTransaction(sql, upgradeLedgerRow);
          } else {
            // A downgrade raises no invoice — proration_behavior is 'none' and
            // nothing is charged today. It is still an event the customer needs
            // to find when asking "why did my plan change?", so it gets a $0
            // row keyed on the subscription and the date it was scheduled.
            await recordTransaction(sql, {
              userId: user_id,
              type: 'plan_downgrade',
              description: describePlanDowngradeScheduled(
                currentPlan.name, newPlan.name, currentSub.next_billing_date,
              ),
              amountCents: 0,
              currency: 'usd',
              providerEventId: `plan_downgrade:${currentSub.stripe_subscription_id}:${new_plan_id}`,
              providerObjectId: currentSub.stripe_subscription_id,
              planId: new_plan_id,
            });
          }
        } catch (ledgerError) {
          // recordTransaction never throws; this guards anything around it.
          // A ledger write must not fail a plan change that already succeeded.
          console.error('⚠️ Could not record the plan change in the ledger:', ledgerError);
        }

        if (isUpgrade) {
          console.log(`💳 Prorated charge will be created automatically by Stripe`);
        } else {
          console.log(`📅 Downgrade scheduled for next billing date`);
        }

      } catch (stripeError) {
        console.error('❌ Stripe update error:', stripeError);

        // BILL-001 — a declined card is not a server error. This used to return
        // 500 with `Stripe error: <raw message>`, which told the customer their
        // upgrade had broken rather than that their bank had said no, and gave
        // them nothing to do next. Card problems are now reported the same way
        // they are on the first-subscription path: 402, a specific message, and
        // a flag telling the CMS to keep the user in the flow with the card
        // form open.
        const friendly = describePaymentError(stripeError);
        if (friendly) {
          return res.status(friendly.status).json({ success: false, ...friendly });
        }

        // Genuinely our problem or Stripe's. Nothing was written to our
        // database, so the customer's plan is unchanged.
        return res.status(500).json({
          success: false,
          error: 'We could not complete the plan change. Nothing was charged. Please try again, or contact support if it keeps happening.',
        });
      }
    }

    // Update database (only after Stripe succeeds)
    const { creditsGranted } = await changePlan(user_id, new_plan_id, isUpgrade);

    // ── Settle the granted credits into the row written above ───────────────
    // Account Activity showed "—" in the Credits column for every plan change,
    // because the ledger row is written BEFORE the grant runs — deliberately,
    // so a proration that was collected is recorded even if the database write
    // that follows it fails — and nothing ever went back to say how many
    // credits the change produced.
    //
    // The same input object is re-sent with the figure added, so the upsert
    // matches on its key and fills the column in place. Re-sending the object
    // rather than a fresh one keeps the settle from disagreeing with the row
    // it settles: a second literal here would be a second chance to state the
    // status or the amount differently.
    if (upgradeLedgerRow && creditsGranted > 0) {
      await recordTransaction(sql, {
        ...upgradeLedgerRow,
        creditType: ISEO_CREDIT_TYPE,
        creditDelta: creditsGranted,
      });
    }

    // Read AFTER the grant, so the confirmation quotes the balance the user
    // will actually see when the page refreshes behind the dialog.
    let creditsTotal: number | null = null;
    try {
      creditsTotal = (await getLiveBalance(user_id)).total;
    } catch (balanceErr) {
      // A missing total costs one sentence of the confirmation; it must never
      // fail an upgrade that has already been paid for.
      console.error('⚠️ Could not read the balance for the upgrade confirmation:', balanceErr);
    }
    console.log(`✅ Database updated successfully`);

    // BILL-006 — plan change receipt. Keyed on the disclosure the customer
    // accepted when one exists (so the receipt is tied to the exact quote they
    // agreed to), otherwise on the subscription plus the new plan.
    //
    // The amount is stated as the DISCLOSED total rather than a figure invented
    // here: BILL-003 already recorded what the customer was shown, and a
    // receipt that contradicts the confirmation dialog is worse than no
    // receipt. Where no disclosure exists we say the charge is prorated and
    // point at the invoice rather than guessing a number.
    if (isUpgrade) {
      const disclosed = disclosure_id
        ? await sql`SELECT total_due_cents, currency, line_items FROM billing_disclosures WHERE disclosure_id = ${disclosure_id} LIMIT 1`
        : [];
      const d = disclosed[0] as any;
      const pmForReceipt = await getLocalDefaultPaymentMethod(sql, user_id);

      await queueBillingEmail(
        user_id,
        'billing.upgrade',
        disclosure_id
          ? `plan_change:${disclosure_id}`
          : `plan_change:${currentSub.stripe_subscription_id}:${new_plan_id}`,
        (firstName) => ({
          firstName,
          oldPlan: currentPlan?.name ?? null,
          newPlan: newPlan.name,
          amountCharged: d
            ? formatCents(Number(d.total_due_cents), d.currency || 'usd')
            : 'A prorated amount for the remainder of this billing period',
          lines: d?.line_items
            ? (typeof d.line_items === 'string' ? JSON.parse(d.line_items) : d.line_items)
              .map((l: any) => ({ description: l.description, amount: formatCents(l.amount_cents, d.currency || 'usd') }))
            : [],
          nextAmount: formatCents(newPlan.price_cents, 'usd'),
          nextBillingDate: currentSub.next_billing_date
            ? new Date(currentSub.next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : null,
          cardBrand: pmForReceipt?.brand ?? null,
          cardLast4: pmForReceipt?.last4 ?? null,
          billingUrl: CMS_BILLING_URL,
          timezone: 'UTC',
        }),
      );
    } else {
      // Downgrade confirmation.
      //
      // This branch did not exist: the receipt was inside `if (isUpgrade)`, so
      // the one plan change that REDUCES what someone gets was the only change
      // we never confirmed in writing. It is also the change most likely to be
      // queried later ("I thought I'd cancelled", "what happens to my
      // credits?"), and the answer to both is in this email.
      //
      // Keyed on the subscription plus the target plan and the date it takes
      // effect: downgrading twice to the same plan in one period is one email,
      // while a later downgrade to a different plan sends its own.
      const effectiveDate = currentSub.next_billing_date
        ? new Date(currentSub.next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : 'your next billing date';

      await queueBillingEmail(
        user_id,
        'billing.downgrade',
        `plan_downgrade:${currentSub.stripe_subscription_id}:${new_plan_id}:${currentSub.next_billing_date ?? 'na'}`,
        (firstName) => ({
          firstName,
          oldPlan: currentPlan?.name ?? 'your previous plan',
          newPlan: newPlan.name,
          effectiveDate,
          nextAmount: formatCents(newPlan.price_cents, 'usd'),
          // Answers the question support actually gets, rather than restating
          // the plan change: nothing is taken away today.
          creditsNote:
            `The credits already on your account stay there — this change does not remove any. `
            + `From ${effectiveDate} your monthly allowance becomes the ${newPlan.name} allowance.`,
          billingUrl: CMS_BILLING_URL,
          timezone: 'UTC',
        }),
      );
    }

    // ── One description of this change, rendered two ways ───────────────────
    // The parameters are built ONCE and both the paragraphs and the plain
    // string are derived from them. Passing them twice — once for `message`,
    // once for `message_parts` — is two chances to describe the same plan
    // change differently, and the customer would see whichever the CMS happened
    // to render.
    const confirmationParts = isUpgrade
      ? planUpgradeConfirmationParts({
        planName: newPlan.name,
        // null when collection did not happen, so the copy says "will appear
        // on your next invoice" instead of asserting a charge that did not
        // occur. `charge` is null only on the non-upgrade paths.
        chargedCents: charge && !charge.paid ? null : (proratedCents ?? 0),
        currency: charge?.currency || 'usd',
        nextBillingDate: currentSub.next_billing_date,
        creditsGranted,
        creditsTotal,
      })
      // Was `Plan downgrade scheduled for ${currentSub.next_billing_date}.` —
      // a Date interpolated straight into a template string, which showed the
      // customer "Sun Sep 20 2026 00:00:00 GMT+0000 (Coordinated Universal
      // Time)". Now formatted, and it answers what happens to their credits.
      : planDowngradeConfirmationParts({
        fromPlan: currentPlan.name,
        toPlan: newPlan.name,
        nextBillingDate: currentSub.next_billing_date,
        nextAmountCents: newPlan.price_cents,
        currency: 'usd',
      });

    res.json({
      success: true,
      // The plain string, flattened from the paragraphs below, for any client
      // that does not render segments.
      message: confirmationParts
        .map((paragraph) => paragraph.map((seg) => seg.text).join(''))
        .join('\n'),
      // The same message as PARAGRAPHS, with the facts emphasised — the plan
      // name, the amount charged, the credits added. A CMS that does not know
      // about message_parts keeps rendering the string exactly as before.
      message_parts: confirmationParts,
      immediate: isUpgrade,
      effective_date: isUpgrade ? new Date().toISOString() : currentSub.next_billing_date,
      new_plan: newPlan.name
    });

  } catch (error) {
    console.error('Change plan error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to change plan'
    });
  }
});

/**
 * Pause subscription
 * POST /api/v1/stripe/pause-subscription
 */
router.post('/pause-subscription', async (req: Request, res: Response) => {
  try {
    const { user_id } = z.object({
      user_id: z.number()
    }).parse(req.body);

    const subscription = await getUserSubscription(user_id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'No active subscription found'
      });
    }

    // Pause in Stripe
    if (subscription.stripe_subscription_id) {
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        pause_collection: {
          behavior: 'void'
        }
      });
    }

    // Pause in database
    await pauseSubscription(user_id, subscription.stripe_subscription_id);

    // Confirm it. A pause stops money moving, so the absence of any
    // confirmation leaves the customer unsure whether it took — and the
    // expensive version of that doubt is them cancelling instead, to be sure.
    //
    // `pause_collection.behavior: 'void'` above is open-ended: Stripe is not
    // given a `resumes_at`, so there is no automatic restart date and the
    // template says so rather than inventing one.
    await queueBillingEmail(
      user_id,
      'billing.paused',
      `pause:${subscription.stripe_subscription_id ?? user_id}:${subscription.next_billing_date ?? 'na'}`,
      (firstName) => ({
        firstName,
        planName: subscription.plan_name || 'your',
        resumesOn: null,
        creditsNote:
          'The credits already on your account stay there and remain usable while the subscription is paused. '
          + 'Your monthly allowance simply stops arriving until you resume.',
        billingUrl: CMS_BILLING_URL,
      }),
    );

    res.json({
      success: true,
      message: 'Subscription paused successfully. Billing has been stopped.'
    });

  } catch (error) {
    console.error('Pause subscription error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to pause subscription'
    });
  }
});

/**
 * Resume subscription
 * POST /api/v1/stripe/resume-subscription
 */
router.post('/resume-subscription', async (req: Request, res: Response) => {
  try {
    const { user_id } = z.object({
      user_id: z.number()
    }).parse(req.body);

    const subscription = await getUserSubscription(user_id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'No subscription found'
      });
    }

    // Resume in Stripe.
    //
    // The response is now kept rather than discarded: resuming starts a new
    // collection period, so the `next_billing_date` on our row is stale by
    // definition at this moment. The confirmation email has to quote the date
    // Stripe just decided on, not the one from before the pause.
    let resumedPeriodEnd: number | null = null;
    if (subscription.stripe_subscription_id) {
      const resumed = await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        pause_collection: null as any
      });
      resumedPeriodEnd = periodEndOrWarn(resumed, 'resume');
    }

    // Resume in database
    await resumeSubscription(user_id);

    // Keyed on the period being resumed INTO, so resuming after a later pause
    // sends its own email while a double-click sends one.
    await queueBillingEmail(
      user_id,
      'billing.resumed',
      `resume:${subscription.stripe_subscription_id ?? user_id}:${resumedPeriodEnd ?? 'na'}`,
      (firstName) => ({
        firstName,
        planName: subscription.plan_name || 'your',
        nextAmount: formatCents(Number(subscription.plan_price ?? 0), 'usd'),
        // Falls back to a phrase rather than a fabricated date when Stripe gave
        // us no period — a billing date is the last thing to guess at.
        nextBillingDate: resumedPeriodEnd !== null
          ? new Date(resumedPeriodEnd * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
          : 'your next billing date',
        creditsNote: 'Your monthly credit allowance starts arriving again from your next billing date.',
        billingUrl: CMS_BILLING_URL,
        timezone: 'UTC',
      }),
    );

    res.json({
      success: true,
      message: 'Subscription resumed successfully. Billing will continue.'
    });

  } catch (error) {
    console.error('Resume subscription error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to resume subscription'
    });
  }
});

/**
 * Cancel subscription (at period end)
 * POST /api/v1/stripe/cancel-subscription
 */
router.post('/cancel-subscription', async (req: Request, res: Response) => {
  try {
    const { user_id } = z.object({
      user_id: z.number()
    }).parse(req.body);

    const subscription = await getUserSubscription(user_id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: 'No active subscription found'
      });
    }

    // Cancel in Stripe at period end
    if (subscription.stripe_subscription_id) {
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        cancel_at_period_end: true
      });
    }

    // Mark in database
    await cancelSubscription(user_id);

    // The cancellation belongs in Account Activity. It moves no money, so
    // amountCents is null — the ledger's contract for a credit-only or
    // informational event; a 0 would render as "$0.00" and read as a charge.
    // Keyed on the period it ends, so cancelling and reactivating twice within
    // one period produces one row rather than a pile of identical ones.
    await recordTransaction(sql, {
      userId: user_id,
      type: 'plan_downgrade',
      description: describeSubscriptionCancelled(subscription.plan_name),
      amountCents: null,
      status: 'succeeded',
      providerEventId: `cancel:${subscription.stripe_subscription_id ?? user_id}:${subscription.next_billing_date ?? 'na'}`,
      planId: subscription.plan_id ?? null,
    });

    // BUG 11 — confirm the cancellation in writing, with the date access ends.
    // This is the email customers most expect and its absence reads as "did my
    // cancellation actually go through?".
    const accessUntil = subscription.next_billing_date
      ? new Date(subscription.next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'the end of your current billing period';

    // BILL-006 — cancellation confirmation, keyed on the subscription plus the
    // period it ends, so cancelling twice in one period sends one email while a
    // genuine later cancellation still sends its own.
    const remainingCredits = await sql`
      SELECT COALESCE(SUM(amount), 0)::int AS total FROM credit_balances WHERE user_id = ${user_id}
    `;
    const remaining = Number((remainingCredits[0] as any)?.total ?? 0);

    await queueBillingEmail(
      user_id,
      'billing.cancellation',
      `cancel:${subscription.stripe_subscription_id}:${subscription.next_billing_date ?? 'na'}`,
      (firstName) => ({
        firstName,
        planName: subscription.plan_name || 'your',
        accessUntil,
        creditsNote: remaining > 0
          ? `You have ${remaining.toLocaleString()} credits remaining. They stay usable until ${accessUntil}; any credits you purchased separately remain on your account afterwards.`
          : 'You have no remaining credits on your account.',
        resubscribeUrl: `${CMS_BILLING_URL}?view=plans`,
        billingUrl: CMS_BILLING_URL,
        timezone: 'UTC',
      }),
    );

    res.json({
      success: true,
      message: `Subscription will be cancelled on ${subscription.next_billing_date}. You can continue using your credits until then.`,
      data: {
        cancellation_date: subscription.next_billing_date
      }
    });

  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel subscription'
    });
  }
});

/**
 * Billing history — what the CMS "Recent Transactions" list shows.
 * GET /api/v1/stripe/billing-history/:user_id?limit=20&cursor=...
 *
 * BILL-004. This now reads OUR ledger (billing_transactions) rather than
 * assembling a view from live Stripe invoices at request time.
 *
 * The previous version merged Stripe invoices with credit_transactions rows on
 * every request. That was a reasonable stopgap for an endpoint that did not
 * exist at all, but it is not a billing history:
 *
 *   • It cannot be read when Stripe is slow or unreachable.
 *   • It cannot be paginated coherently — two sources, two orderings, sliced
 *     after merging, so "page 2" is not the continuation of page 1.
 *   • Its labels come from a free-text `reason` column, so rewording a string
 *     silently rewrites history.
 *   • It could not answer "did this event produce a record?", because there
 *     was no record to look for.
 *
 * The ledger is written by both the webhook and the request path, upserting on
 * the provider event id, so whichever arrives first wins and the other is a
 * no-op. See services/billing/transactions.ts.
 */
router.get('/billing-history/:user_id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.user_id);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }

    const limit = Math.min(parseInt(String(req.query.limit || '20')) || 20, 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;

    const page = await readLedger(sql, userId, { limit, cursor });

    res.json({
      success: true,
      data: page.events,
      meta: {
        has_more: page.has_more,
        next_cursor: page.next_cursor,
        // Lets the CMS distinguish "no billing activity yet" from a failure —
        // very different things to tell a paying customer.
        source: 'ledger',
      },
    });

  } catch (error) {
    console.error('Billing history error:', error);
    res.status(500).json({
      success: false,
      error: 'We could not load your billing history. Please try again in a moment.'
    });
  }
});

/**
 * Get user's payment methods
 * GET /api/v1/stripe/payment-methods/:user_id
 */
router.get('/payment-methods/:user_id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.user_id);

    // Get user's Stripe customer ID
    const userResult = await sql`SELECT stripe_customer_id FROM users WHERE id = ${userId}`;
    if (userResult.length === 0 || !userResult[0].stripe_customer_id) {
      return res.json({
        success: true,
        payment_methods: []
      });
    }

    const customerId = userResult[0].stripe_customer_id;

    // BILL-001 — self-heal on read: if the customer has cards but no default
    // (the webhook never landed, or their old default was detached), promote
    // one now so Settings shows a default and the upgrade path can't fail.
    // Idempotent, and its fast path does no writes and takes no lock when both
    // sides already agree — which is the case on almost every read.
    await ensureDefaultPaymentMethod(userId, customerId);

    // Get payment methods from Stripe
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card'
    });

    // Get default payment method (re-read AFTER the heal above)
    const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
    const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;

    res.json({
      success: true,
      payment_methods: paymentMethods.data.map(pm => ({
        id: pm.id,
        brand: pm.card?.brand,
        last4: pm.card?.last4,
        exp_month: pm.card?.exp_month,
        exp_year: pm.card?.exp_year,
        // 'apple_pay' | 'google_pay' | 'link' | … | null for a card keyed in
        // directly. A wallet payment IS a card payment method here — Stripe
        // saves the underlying card and the wallet is only how it was
        // presented — so without this the list showed a bare
        // "VISA •••• 4242" and the customer had no way to tell their Apple Pay
        // card had been saved at all. That ambiguity is exactly what QA hit.
        wallet: pm.card?.wallet?.type ?? null,
        is_default: pm.id === defaultPaymentMethodId
      }))
    });

  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch payment methods'
    });
  }
});

/**
 * Send the user to Stripe's billing portal.
 * POST /api/v1/stripe/billing-portal
 *
 * ── THE ANSWER TO "HOW DOES A USER UPDATE THEIR ADDRESS?" ───────────────────
 * Stripe now collects the billing address at checkout, which is what let the
 * signup field, the dashboard reminder and the pre-purchase gate go away. That
 * left one question: what happens when the address later changes.
 *
 * The portal is the answer, rather than keeping our own form and writing
 * through to Stripe. A form of ours would be a second place the address lives,
 * and the two would drift the moment a user edited it in a Stripe-hosted
 * receipt or an invoice — leaving the one WE hold on invoices being wrong in
 * exactly the situation it matters. The portal edits the Customer directly, so
 * there is one copy and Stripe owns it.
 *
 * It also carries what a payment surface has to and we would otherwise build:
 * card management, invoice history, and SCA where the region demands it.
 *
 * A customer is created on demand, so this works for an account that has never
 * paid — otherwise "update my address" would be unavailable to exactly the
 * people who have not been to checkout yet.
 */
router.post('/billing-portal', async (req: Request, res: Response) => {
  try {
    const { user_id, return_url } = z.object({
      user_id: z.number(),
      return_url: z.string().url(),
    }).parse(req.body);

    const rows = await sql`SELECT email, stripe_customer_id FROM users WHERE id = ${user_id}`;
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = rows[0];
    let customerId = user.stripe_customer_id as string | null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email as string,
        metadata: { user_id: user_id.toString() },
      });
      customerId = customer.id;
      await sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${user_id}`;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url,
    });

    return res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('Billing portal session error:', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to open the billing portal',
    });
  }
});

/**
 * Create setup session for adding payment method
 * POST /api/v1/stripe/create-setup-session
 */
router.post('/create-setup-session', async (req: Request, res: Response) => {
  try {
    const { user_id, success_url, cancel_url } = z.object({
      user_id: z.number(),
      success_url: z.string().url(),
      cancel_url: z.string().url()
    }).parse(req.body);

    // Get or create Stripe customer
    const userResult = await sql`SELECT email, stripe_customer_id FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = userResult[0];
    let customerId = user.stripe_customer_id;

    // Create customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          user_id: user_id.toString()
        }
      });
      customerId = customer.id;

      // Save customer ID
      await sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${user_id}`;
    }

    // Create setup session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      // Stripe collects the billing address here — that is what replaced the
      // signup field, the dashboard reminder and the pre-purchase gate.
      billing_address_collection: 'required',
      // …and writes it back onto the Customer, so the address the user gave
      // at checkout is the one on the account afterwards. Without this the
      // Customer keeps whatever it had, and a card added here would leave the account with none.
      customer_update: { address: 'auto' },
      payment_method_types: ['card'],
      mode: 'setup',
      success_url: success_url,
      cancel_url: cancel_url
    });

    res.json({
      success: true,
      url: session.url
    });

  } catch (error) {
    console.error('Create setup session error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create setup session'
    });
  }
});

/**
 * Create a SetupIntent for collecting a card IN-PAGE via Stripe Elements.
 * POST /api/v1/stripe/create-setup-intent
 *
 * Backend half of bug 4 (inline card entry at upgrade). The frontend Elements
 * work is scheduled separately — credits.md flags it as the larger piece — but
 * this endpoint is the whole server-side requirement, so that follow-up is
 * purely a CMS change.
 *
 * Differs from /create-setup-session, which returns a hosted Checkout URL and
 * therefore navigates the user away from the page. This returns a
 * client_secret to confirm in place.
 *
 * usage: 'off_session' so the saved card can be charged for future renewals
 * without the customer present — a card saved on-session only would fail at
 * the next automatic renewal.
 */
router.post('/create-setup-intent', async (req: Request, res: Response) => {
  try {
    const { user_id } = z.object({ user_id: z.number() }).parse(req.body);

    const userResult = await sql`SELECT email, stripe_customer_id FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = userResult[0];
    let customerId = user.stripe_customer_id as string | null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user_id.toString() },
      });
      customerId = customer.id;
      await sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${user_id}`;
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { user_id: user_id.toString() },
    });

    res.json({
      success: true,
      data: {
        client_secret: setupIntent.client_secret,
        customer_id: customerId,
      },
    });

  } catch (error) {
    console.error('Create setup intent error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create setup intent'
    });
  }
});

/**
 * Ensure the customer has a default payment method.
 * POST /api/v1/stripe/ensure-default-payment-method
 *
 * Called by the CMS the moment the user returns from adding a card
 * (?setup=success), so the default is in place immediately instead of whenever
 * the setup_intent.succeeded webhook happens to arrive. Idempotent.
 */
router.post('/ensure-default-payment-method', async (req: Request, res: Response) => {
  try {
    const { user_id } = z.object({ user_id: z.number() }).parse(req.body);

    const userResult = await sql`SELECT stripe_customer_id FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0 || !userResult[0].stripe_customer_id) {
      return res.json({ success: true, data: { default_payment_method: null } });
    }

    const customerId = userResult[0].stripe_customer_id as string;
    const defaultPm = await ensureDefaultPaymentMethod(user_id, customerId);

    // Keep the live subscription (if any) pointed at the customer default.
    const sub = await getUserSubscription(user_id);
    if (defaultPm && sub?.stripe_subscription_id) {
      await alignSubscriptionPaymentMethod(sub.stripe_subscription_id);
    }

    res.json({ success: true, data: { default_payment_method: defaultPm } });

  } catch (error) {
    console.error('Ensure default payment method error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set a default payment method'
    });
  }
});

/**
 * Remove payment method
 * DELETE /api/v1/stripe/payment-method/:user_id/:payment_method_id
 */
router.delete('/payment-method/:user_id/:payment_method_id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.user_id);
    const paymentMethodId = req.params.payment_method_id;

    // Verify user owns this payment method
    const userResult = await sql`SELECT stripe_customer_id FROM users WHERE id = ${userId}`;
    if (userResult.length === 0 || !userResult[0].stripe_customer_id) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const customerId = userResult[0].stripe_customer_id as string;

    // Ownership check. Without this, any authenticated caller could detach an
    // arbitrary payment method id belonging to another customer — the handler
    // previously looked up the user only to prove they existed, then detached
    // whatever id was in the URL.
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== customerId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to remove this payment method'
      });
    }

    // Detach payment method from customer
    await stripe.paymentMethods.detach(paymentMethodId);

    // BILL-001 (same class) — removing the DEFAULT card left the customer with
    // cards but no default, which is exactly the state that made upgrades fail.
    // Promote a replacement immediately, and clear the local record if that was
    // their last card so nothing points at a detached payment method.
    await ensureDefaultPaymentMethod(userId, customerId);

    res.json({
      success: true,
      message: 'Payment method removed successfully'
    });

  } catch (error) {
    console.error('Remove payment method error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to remove payment method'
    });
  }
});

/**
 * Set default payment method
 * POST /api/v1/stripe/set-default-payment-method
 */
router.post('/set-default-payment-method', async (req: Request, res: Response) => {
  try {
    const { user_id, payment_method_id } = z.object({
      user_id: z.number(),
      payment_method_id: z.string()
    }).parse(req.body);

    // Get user's Stripe customer ID
    const userResult = await sql`SELECT stripe_customer_id FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0 || !userResult[0].stripe_customer_id) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const customerId = userResult[0].stripe_customer_id as string;

    // Ownership check, the same class of hole that was closed on DELETE. Without
    // it a caller can nominate any payment method id; Stripe would reject an
    // unattached one, but relying on the provider to enforce our authorisation
    // is not an access-control model.
    const pm = await stripe.paymentMethods.retrieve(payment_method_id);
    if (pm.customer !== customerId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to use this payment method'
      });
    }

    // BILL-001 — write BOTH sides. This endpoint previously updated Stripe
    // only, so a user choosing a card in Settings immediately put our record
    // out of step with the provider: exactly the divergence the ticket is
    // about, just arrived at deliberately instead of by a race.
    //
    // Stripe first here (unlike the promotion path) because this is an explicit
    // user choice: if Stripe rejects it, there is nothing to record.
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: payment_method_id
      }
    });

    await sql`
      UPDATE users
      SET    default_payment_method_id = ${pm.id},
             default_payment_method_brand = ${pm.card?.brand ?? null},
             default_payment_method_last4 = ${pm.card?.last4 ?? null},
             default_payment_method_exp_month = ${pm.card?.exp_month ?? null},
             default_payment_method_exp_year = ${pm.card?.exp_year ?? null},
             default_payment_method_set_at = NOW(),
             updated_at = NOW()
      WHERE  id = ${user_id}
    `;

    // A subscription created with its own default_payment_method does not
    // inherit a later customer-level change, so a renewal could still be
    // attempted against the card the user just replaced.
    const sub = await getUserSubscription(user_id);
    if (sub?.stripe_subscription_id) {
      await alignSubscriptionPaymentMethod(sub.stripe_subscription_id);
    }

    res.json({
      success: true,
      message: 'Default payment method updated',
      data: {
        default_payment_method: {
          id: pm.id,
          brand: pm.card?.brand ?? null,
          last4: pm.card?.last4 ?? null,
        },
      },
    });

  } catch (error) {
    console.error('Set default payment method error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set default payment method'
    });
  }
});

export default router;
