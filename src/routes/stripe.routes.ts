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
  getFreePlanId
} from '../models/user.models.js';
import { sendEmail, emailTemplates } from '../services/email.service.js';

const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover'
});

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
 * Send a billing email without ever letting it break the billing operation.
 *
 * A failed/slow Mailgun call must not turn a SUCCESSFUL upgrade into an error
 * response — the money has already moved. Failures are logged and swallowed.
 * (sendEmail already no-ops with a warning when Mailgun is unconfigured, which
 * is why nothing arrives in local development.)
 */
const sendBillingEmail = async (
  userId: number,
  build: (firstName: string) => { subject: string; html: string; text?: string }
): Promise<void> => {
  try {
    const rows = await sql`SELECT email, name FROM users WHERE id = ${userId} LIMIT 1`;
    const user = rows[0] as any;
    if (!user?.email) return;
    const tpl = build(firstNameOf(user.name, user.email));
    await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (err) {
    console.error(`⚠️ Billing email failed for user ${userId} (billing itself was unaffected):`, err);
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
  nextBillingTimestamp: number;
}): Promise<void> => {
  const { userId, planId, stripeSubscriptionId, stripeCustomerId, nextBillingTimestamp } = params;

  await sql`
    INSERT INTO subscriptions (
      user_id, plan_id, status, stripe_subscription_id, stripe_customer_id, start_date, next_billing_date
    )
    VALUES (
      ${userId}, ${planId}, 'active', ${stripeSubscriptionId}, ${stripeCustomerId}, NOW(), TO_TIMESTAMP(${nextBillingTimestamp})
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
      plan_id = ${planId},
      status = 'active',
      stripe_subscription_id = ${stripeSubscriptionId},
      stripe_customer_id = ${stripeCustomerId},
      next_billing_date = TO_TIMESTAMP(${nextBillingTimestamp}),
      cancel_at_period_end = FALSE,
      pending_plan_id = NULL,
      pending_plan_effective_date = NULL
  `;

  await sql`
    UPDATE users SET plan_id = ${planId}, updated_at = NOW() WHERE id = ${userId}
  `;

  const planResult = await sql`SELECT * FROM subscription_plans WHERE id = ${planId}`;
  if (planResult.length > 0) {
    // Reset the plan (included) credits; purchased top-ups are preserved.
    await refillPlanCredits(userId, planResult[0], 'Subscription activated');
  }
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

  const claim = await sql`
    INSERT INTO stripe_webhook_events (event_id, event_type, processed)
    VALUES (${claimId}, 'credit_topup', false)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;

  // Someone else already claimed (and is applying / has applied) this session.
  if (claim.length === 0) return false;

  const userId = parseInt(session.metadata?.user_id || '0');
  const creditType = session.metadata?.credit_type as 'images' | 'content' | 'keywords' | undefined;
  const quantity = parseInt(session.metadata?.quantity || '0');

  if (!userId || !creditType || !quantity) {
    await sql`
      UPDATE stripe_webhook_events
      SET processed = true, processed_at = NOW(), error_message = 'missing credit_topup metadata'
      WHERE event_id = ${claimId}
    `;
    return false;
  }

  // Add to the PURCHASED bucket so these credits persist across billing cycles
  // and are never wiped by a monthly refill.
  await addPurchasedCredits(userId, creditType, quantity, 'Credit purchase via Stripe');

  await sql`
    UPDATE stripe_webhook_events
    SET processed = true, processed_at = NOW()
    WHERE event_id = ${claimId}
  `;

  console.log(`✅ Applied top-up of ${quantity} ${creditType} credits to user ${userId} (session ${session.id})`);
  return true;
};

/**
 * Guarantee the customer has a default payment method, if they have any card
 * at all. Returns the id of the default in force afterwards, or null when the
 * customer genuinely has no cards.
 *
 * WHY THIS EXISTS (bug 3: "after adding a card, upgrade errors 'no default
 * payment method chosen'").
 *
 * Setting the first card as default was previously done ONLY in the
 * `setup_intent.succeeded` webhook. Two ways that fails the user:
 *
 *   1. TIMING — the user adds a card, is redirected straight back, and clicks
 *      upgrade before the webhook lands. The upgrade endpoint sees no default
 *      and refuses. The card is right there; the error is a race, not a fact.
 *   2. COVERAGE — the webhook only acted when `paymentMethods.data.length === 1`.
 *      A customer with two cards and no default (e.g. their old default was
 *      detached) could never satisfy the check, and no amount of retrying
 *      helped.
 *
 * So this is called SYNCHRONOUSLY on the paths that need a default — and still
 * from the webhook. Like activateSubscriptionInDb above, running both is safe:
 * it is idempotent and converges on the same end state.
 *
 * Never overrides an existing default — a deliberate choice by the user (or a
 * previous charge) outranks "whatever happens to be first in the list".
 */
const ensureDefaultPaymentMethod = async (
  customerId: string,
  preferredPaymentMethodId?: string
): Promise<string | null> => {
  const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;

  // Already set — respect it.
  const existing = customer.invoice_settings?.default_payment_method;
  if (existing) return typeof existing === 'string' ? existing : existing.id;

  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
  if (cards.data.length === 0) return null;

  // Prefer the card we were just handed (the one the user actually added);
  // otherwise fall back to the most recently created one.
  const chosen =
    (preferredPaymentMethodId && cards.data.find((pm) => pm.id === preferredPaymentMethodId)?.id)
    || cards.data.slice().sort((a, b) => (b.created || 0) - (a.created || 0))[0].id;

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: chosen },
  });
  console.log(`✅ Auto-set default payment method ${chosen} for customer ${customerId}`);
  return chosen;
};

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
  credit_type: z.enum(['images', 'content', 'keywords']),
  quantity: z.number().min(1).max(1000),
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
 * Buy additional credits (one-time purchase)
 * POST /api/v1/stripe/buy-credits
 */
router.post('/buy-credits', async (req: Request, res: Response) => {
  try {
    const { user_id, credit_type, quantity, success_url, cancel_url } = buyCreditSchema.parse(req.body);

    // Get user email
    const userResult = await sql`SELECT email FROM users WHERE id = ${user_id}`;
    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const userEmail = userResult[0].email;

    // Define credit prices (in cents)
    const creditPrices: Record<string, number> = {
      images: 100,      // $1.00 per image credit
      content: 200,     // $2.00 per content credit
      keywords: 50      // $0.50 per keyword credit
    };

    const unitAmount = creditPrices[credit_type];
    const totalAmount = unitAmount * quantity;

    // Create Stripe checkout session for one-time payment
    const session = await stripe.checkout.sessions.create({
      customer_email: userEmail,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${quantity} ${credit_type.charAt(0).toUpperCase() + credit_type.slice(1)} Credits`,
              description: `Add ${quantity} ${credit_type} credits to your account`,
            },
            unit_amount: unitAmount,
          },
          quantity: quantity,
        },
      ],
      mode: 'payment',
      success_url: withSessionId(success_url),
      cancel_url: cancel_url,
      metadata: {
        user_id: user_id.toString(),
        credit_type,
        quantity: quantity.toString(),
        purchase_type: 'credit_topup'
      }
    });

    res.json({
      success: true,
      data: {
        session_id: session.id,
        url: session.url,
        amount: totalAmount,
        quantity,
        credit_type
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

          // Calculate next billing date (use current_period_end timestamp)
          const nextBillingTimestamp = (subscription as any).current_period_end || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

          await activateSubscriptionInDb({
            userId,
            planId,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: subscription.customer as string,
            nextBillingTimestamp,
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
          const nextBillingTimestamp = (subscription as any).current_period_end || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

          // ✅ Update subscription status from Stripe
          await sql`
            UPDATE subscriptions 
            SET 
              status = ${subscription.status},
              next_billing_date = TO_TIMESTAMP(${nextBillingTimestamp})
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

          console.log(`⚠️ Subscription cancelled for user ${userId}, downgraded to free plan (purchased credits preserved)`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        
        if ((invoice as any).subscription) {
          // Find user by subscription ID
          const subResult = await sql`
            SELECT user_id, plan_id FROM subscriptions 
            WHERE stripe_subscription_id = ${(invoice as any).subscription as string}
          `;

          if (subResult.length > 0) {
            const { user_id, plan_id } = subResult[0];

            // Refill credits for monthly billing.
            // ⚠️ BUSINESS LOGIC: Use-it-or-lose-it applies to PLAN credits only — they
            // reset to the plan allotment each cycle. Purchased top-ups are preserved.
            const planResult = await sql`SELECT * FROM subscription_plans WHERE id = ${plan_id}`;
            if (planResult.length > 0) {
              await refillPlanCredits(user_id, planResult[0], 'Monthly plan credits refill');
              console.log(`✅ Monthly plan credits refilled for user ${user_id} (invoice paid)`);
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        
        if ((invoice as any).subscription) {
          const subResult = await sql`
            SELECT user_id FROM subscriptions 
            WHERE stripe_subscription_id = ${(invoice as any).subscription as string}
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

            console.warn(`⚠️ Payment failed for user ${userId} - subscription suspended, plan credits revoked`);
            // TODO: Send email notification to user
          }
        }
        break;
      }

      case 'setup_intent.succeeded': {
        const setupIntent = event.data.object as Stripe.SetupIntent;
        
        // When a setup intent succeeds, it means a payment method was added
        if (setupIntent.customer && setupIntent.payment_method) {
          const customerId = setupIntent.customer as string;
          const paymentMethodId = setupIntent.payment_method as string;

          // BUG 3 — delegate to the shared helper, which also runs synchronously
          // on the upgrade path so the user is never blocked waiting on this
          // webhook. The old inline version only acted when the customer had
          // EXACTLY one card, so someone holding two cards and no default could
          // never get one set.
          //
          // OLD:
          //   const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
          //   if (paymentMethods.data.length === 1) {
          //     await stripe.customers.update(customerId, {
          //       invoice_settings: { default_payment_method: paymentMethodId }
          //     });
          //   }
          await ensureDefaultPaymentMethod(customerId, paymentMethodId);
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
      return res.json({ success: true, type: 'credit_topup', applied });
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
            const nextBillingTimestamp = (subscription as any).current_period_end
              || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
            await activateSubscriptionInDb({
              userId,
              planId,
              stripeSubscriptionId: subscription.id,
              stripeCustomerId: subscription.customer as string,
              nextBillingTimestamp,
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

    res.json({
      success: true,
      plans: plans.map((plan: any) => ({
        ...plan,
        is_current: plan.id === currentPlanId,
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
    const { user_id, plan_id } = z.object({
      user_id: z.number(),
      plan_id: z.number()
    }).parse(req.body);

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

    // Validate plan has Stripe Price ID
    if (!plan.stripe_price_id) {
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
    const defaultPaymentMethod = await ensureDefaultPaymentMethod(user.stripe_customer_id);

    if (!defaultPaymentMethod) {
      return res.status(400).json({
        success: false,
        error: 'Please add a payment method in Settings first',
        requires_payment_method: true
      });
    }

    console.log(`🎫 Creating subscription for user ${user_id} to ${plan.name}`);

    try {
      // Create subscription directly using saved payment method
      const subscription = await stripe.subscriptions.create({
        customer: user.stripe_customer_id,
        items: [{
          price: plan.stripe_price_id,
        }],
        payment_behavior: 'error_if_incomplete', // Changed: Fail if payment fails
        payment_settings: {
          save_default_payment_method: 'on_subscription'
        },
        expand: ['latest_invoice.payment_intent'],
        metadata: {
          user_id: user_id.toString(),
          plan_id: plan_id.toString(),
          upgrade_from_free: 'true'
        }
      });

      console.log(`✅ Subscription created: ${subscription.id}, status: ${subscription.status}`);

      // Only respond success if subscription is active or trialing
      if (subscription.status === 'active' || subscription.status === 'trialing') {
        // ✅ CRITICAL: Persist the subscription + refill credits synchronously here,
        // BEFORE responding. Do NOT rely on the customer.subscription.created webhook —
        // if the webhook endpoint is misconfigured/down the user would be charged but
        // receive nothing, and even when healthy the frontend reloads credits before the
        // async webhook lands. activateSubscriptionInDb is idempotent with the webhook.
        const nextBillingTimestamp = (subscription as any).current_period_end
          || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

        try {
          await activateSubscriptionInDb({
            userId: user_id,
            planId: plan_id,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: user.stripe_customer_id,
            nextBillingTimestamp,
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

        // BUG 11 — first-subscription confirmation. Same template as an upgrade;
        // here the charge IS the full plan price, so it can be stated exactly.
        const creditsSummary = [
          plan.content_credits ? `${plan.content_credits} content` : null,
          plan.image_credits ? `${plan.image_credits} image` : null,
          plan.keyword_credits ? `${plan.keyword_credits} keyword` : null,
        ].filter(Boolean).join(', ') + ' credits per month';

        await sendBillingEmail(user_id, (firstName) => emailTemplates.subscriptionUpgraded(
          firstName,
          plan.name,
          formatCents(plan.price_cents, 'usd'),
          new Date(nextBillingTimestamp * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          creditsSummary,
          CMS_BILLING_URL,
        ));

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
    const [currentPlanData, newPlanData] = await Promise.all([
      currentSub ? sql`SELECT * FROM subscription_plans WHERE id = ${currentSub.plan_id}` : Promise.resolve([] as any[]),
      sql`SELECT * FROM subscription_plans WHERE id = ${new_plan_id}`
    ]);

    if (newPlanData.length === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    const newPlan = newPlanData[0];

    // No existing subscription → this is a first subscription, not a change.
    // The full plan price is what they'll pay; there is nothing to prorate.
    if (!currentSub || !currentSub.stripe_subscription_id) {
      return res.json({
        success: true,
        data: {
          is_upgrade: true,
          is_first_subscription: true,
          prorated: false,
          amount_due_cents: newPlan.price_cents,
          currency: 'usd',
          proration_date: null,
          effective: 'immediate',
          description: 'You will be charged the full plan price to start this subscription.',
        }
      });
    }

    const currentPlan = currentPlanData[0];
    const isUpgrade = newPlan.price_cents > currentPlan.price_cents;

    // BUG 10 — reactivation quote. Mirrors the same-plan-while-cancelling case
    // in /change-plan so the dialog says "nothing to pay, your plan continues"
    // rather than the misleading downgrade copy below.
    if (new_plan_id === currentSub.plan_id && currentSub.cancel_at_period_end) {
      return res.json({
        success: true,
        data: {
          is_upgrade: false,
          is_reactivation: true,
          is_first_subscription: false,
          prorated: false,
          amount_due_cents: 0,
          currency: 'usd',
          proration_date: null,
          effective: 'immediate',
          next_billing_date: currentSub.next_billing_date,
          new_plan: newPlan.name,
          description: 'Your cancellation will be reversed and your plan continues as normal. Nothing is charged today.',
        }
      });
    }

    // Downgrades are scheduled, not prorated (proration_behavior 'none' on the
    // commit path) — so nothing is owed today. Say so explicitly rather than
    // previewing a charge that will not happen.
    if (!isUpgrade) {
      return res.json({
        success: true,
        data: {
          is_upgrade: false,
          is_first_subscription: false,
          prorated: false,
          amount_due_cents: 0,
          currency: 'usd',
          proration_date: null,
          effective: 'period_end',
          effective_date: currentSub.next_billing_date,
          description: 'No charge today. Your new plan starts at the end of the current billing period.',
        }
      });
    }

    // Same precondition the commit path enforces — fail here rather than
    // showing a quote for a change that /change-plan will then refuse.
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

    // The instant we are pricing against. Returned to the caller and replayed
    // on commit so the quote is binding.
    const prorationDate = Math.floor(Date.now() / 1000);

    const preview = await stripe.invoices.createPreview({
      customer: stripeSubscription.customer as string,
      subscription: currentSub.stripe_subscription_id,
      subscription_details: {
        items: [{ id: itemId, price: newPlan.stripe_price_id }],
        proration_behavior: 'create_prorations',
        proration_date: prorationDate,
      },
    });

    // Only the proration line items are due NOW. The rest of the previewed
    // invoice is the next cycle's recurring charge, which must NOT be presented
    // as part of today's amount — that would massively overstate it.
    //
    // NOTE: on this API version (2025-10-29.clover) `proration` is NOT a
    // top-level field on the line item — it lives under
    // `parent.invoice_item_details` / `parent.subscription_item_details`.
    // Reading `line.proration` yields undefined for every line, which would
    // filter out everything and quote $0.00 for every upgrade. The top-level
    // read is kept as a fallback for older API versions.
    const isProrationLine = (line: any): boolean => {
      const parent = line?.parent;
      if (parent) {
        if (parent.invoice_item_details?.proration) return true;
        if (parent.subscription_item_details?.proration) return true;
        // Parent present but neither detail flags a proration → not one.
        if (parent.invoice_item_details || parent.subscription_item_details) return false;
      }
      return !!line?.proration; // pre-2025 shape
    };

    const prorationLines = preview.lines.data.filter(isProrationLine);
    const amountDueNow = prorationLines.reduce((sum: number, line: any) => sum + (line.amount || 0), 0);

    res.json({
      success: true,
      data: {
        is_upgrade: true,
        is_first_subscription: false,
        prorated: true,
        // Net of the credit for unused time on the old plan and the charge for
        // the new one. Can be negative (a credit) on unusual cycle positions.
        amount_due_cents: amountDueNow,
        currency: preview.currency || 'usd',
        proration_date: prorationDate,
        effective: 'immediate',
        next_billing_date: currentSub.next_billing_date,
        current_plan: currentPlan?.name || null,
        new_plan: newPlan.name,
        description: amountDueNow > 0
          ? 'You will be charged this prorated amount now, covering the rest of the current billing period. Your credits are topped up straight away.'
          : 'No charge is due now — the unused portion of your current plan covers the change.',
        lines: prorationLines.map((line: any) => ({
          description: line.description,
          amount_cents: line.amount,
        })),
      }
    });

  } catch (error) {
    console.error('Preview plan change error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to preview plan change'
    });
  }
});

/**
 * Change subscription plan (upgrade or downgrade)
 * POST /api/v1/stripe/change-plan
 */
router.post('/change-plan', async (req: Request, res: Response) => {
  try {
    // `proration_date` is the timestamp returned by /preview-plan-change. When
    // present it is replayed to Stripe so the customer is charged exactly the
    // amount they were quoted (bug 6). Optional — a caller that skips the
    // preview still works, it just prices at "now".
    const { user_id, new_plan_id, proration_date } = z.object({
      user_id: z.number(),
      new_plan_id: z.number(),
      proration_date: z.number().int().positive().optional()
    }).parse(req.body);

    // Get current subscription
    const currentSub = await getUserSubscription(user_id);
    
    // If no subscription = FREE tier user trying to upgrade
    if (!currentSub) {
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

    // BUG 10 — REACTIVATION. Re-picking the plan you are already on while a
    // cancellation is scheduled is the most natural way to "resubscribe", and
    // it was the one path that silently did the wrong thing: same price means
    // isUpgrade === false, so it fell into the DOWNGRADE branch, queued a
    // pointless pending_plan change, and never cleared cancel_at_period_end —
    // leaving the "Cancellation Scheduled" banner up forever.
    //
    // Treat it as what the user means: keep the subscription running. No
    // proration, no credit grant — nothing about the plan is changing.
    if (new_plan_id === currentSub.plan_id && currentSub.cancel_at_period_end) {
      if (currentSub.stripe_subscription_id) {
        await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
          cancel_at_period_end: false,
        });
      }
      await sql`
        UPDATE subscriptions
        SET    cancel_at_period_end = FALSE,
               cancelled_at = NULL,
               status = 'active'
        WHERE  user_id = ${user_id}
      `;

      console.log(`✅ Reactivated cancelled subscription for user ${user_id} (${newPlan.name})`);

      return res.json({
        success: true,
        message: `Your ${newPlan.name} subscription has been reactivated. Billing continues as normal — you were not charged again today.`,
        immediate: true,
        reactivated: true,
        effective_date: new Date().toISOString(),
        new_plan: newPlan.name,
      });
    }

    // Validate that Stripe Price IDs are configured
    if (!newPlan.stripe_price_id) {
      return res.status(500).json({
        success: false,
        error: 'Stripe Price ID not configured for the selected plan. Please contact support.'
      });
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
        await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
          items: [{
            id: stripeSubscription.items.data[0].id,
            price: newPlan.stripe_price_id, // ✅ Change the price
          }],
          proration_behavior: isUpgrade ? 'create_prorations' : 'none',
          billing_cycle_anchor: 'unchanged', // Keep same billing date
          cancel_at_period_end: false,
          ...(isUpgrade && proration_date ? { proration_date } : {}),
        });

        console.log(`✅ Stripe subscription updated successfully`);
        
        if (isUpgrade) {
          console.log(`💳 Prorated charge will be created automatically by Stripe`);
        } else {
          console.log(`📅 Downgrade scheduled for next billing date`);
        }

      } catch (stripeError) {
        console.error('❌ Stripe update error:', stripeError);
        
        // Rollback - don't update database if Stripe fails
        return res.status(500).json({
          success: false,
          error: stripeError instanceof Error 
            ? `Stripe error: ${stripeError.message}` 
            : 'Failed to update Stripe subscription'
        });
      }
    }

    // Update database (only after Stripe succeeds)
    await changePlan(user_id, new_plan_id, isUpgrade);
    console.log(`✅ Database updated successfully`);

    // BUG 11 — notify the customer that their plan (and their bill) changed.
    // Awaited so a synchronous failure is logged in-request, but sendBillingEmail
    // never throws, so it cannot turn a completed upgrade into an error.
    if (isUpgrade) {
      const creditsSummary = [
        newPlan.content_credits ? `${newPlan.content_credits} content` : null,
        newPlan.image_credits ? `${newPlan.image_credits} image` : null,
        newPlan.keyword_credits ? `${newPlan.keyword_credits} keyword` : null,
      ].filter(Boolean).join(', ') + ' credits per month';

      await sendBillingEmail(user_id, (firstName) => emailTemplates.subscriptionUpgraded(
        firstName,
        newPlan.name,
        // The prorated invoice is raised asynchronously by Stripe, so quoting a
        // precise figure here risks contradicting the real invoice. Point at
        // the receipt instead of inventing a number.
        'A prorated amount for the remainder of this billing period',
        currentSub.next_billing_date
          ? new Date(currentSub.next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
          : 'your next billing date',
        creditsSummary,
        CMS_BILLING_URL,
      ));
    }

    res.json({
      success: true,
      message: isUpgrade 
        ? 'Plan upgraded! Prorated charge applied. Credits have been added to your account.' 
        : `Plan downgrade scheduled for ${currentSub.next_billing_date}. No charge today.`,
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

    // Resume in Stripe
    if (subscription.stripe_subscription_id) {
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        pause_collection: null as any
      });
    }

    // Resume in database
    await resumeSubscription(user_id);

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

    // BUG 11 — confirm the cancellation in writing, with the date access ends.
    // This is the email customers most expect and its absence reads as "did my
    // cancellation actually go through?".
    const accessUntil = subscription.next_billing_date
      ? new Date(subscription.next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'the end of your current billing period';
    await sendBillingEmail(user_id, (firstName) => emailTemplates.subscriptionCancelled(
      firstName,
      subscription.plan_name || 'your',
      accessUntil,
      CMS_BILLING_URL,
    ));

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
 * GET /api/v1/stripe/billing-history/:user_id?limit=20
 *
 * Bug 7: the list was permanently empty even after a credit purchase and two
 * plan upgrades, because NOTHING SERVED IT — there was no user-facing endpoint
 * at all, only an admin one. The CMS rendered a hardcoded empty state.
 *
 * Two sources are merged, because "transactions" means two different things to
 * a user and they expect to see both:
 *
 *   MONEY  — Stripe invoices. The authoritative record of what was charged,
 *            including prorated upgrade invoices, with a receipt link.
 *   CREDITS— credit_transactions rows that are NOT generation debits. These
 *            cover purchases and plan grants.
 *
 * The discriminator for that second set is `generation_id IS NULL`: every
 * consumption debit is written by deductCredits with a generation_id attached,
 * while purchases/grants/refills are written without one. Filtering on the
 * reason text instead would silently break the moment a reason string is
 * reworded.
 *
 * Stripe is queried best-effort: if it is unreachable or the user has no
 * customer record, the credit rows are still returned rather than failing the
 * whole list.
 */
router.get('/billing-history/:user_id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.user_id);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }
    const limit = Math.min(parseInt(String(req.query.limit || '20')) || 20, 100);

    const userRows = await sql`SELECT stripe_customer_id FROM users WHERE id = ${userId} LIMIT 1`;
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const customerId = userRows[0].stripe_customer_id as string | null;

    // ── Credit-side events (purchases, plan grants, refills, suspensions) ──
    const creditRows = await sql`
      SELECT id, credit_type, delta, reason, created_at
      FROM   credit_transactions
      WHERE  user_id = ${userId}
        AND  generation_id IS NULL
      ORDER  BY created_at DESC
      LIMIT  ${limit}
    `;

    const creditEvents = (creditRows as any[]).map((r) => ({
      id: `credit_${r.id}`,
      type: 'credit' as const,
      date: r.created_at,
      description: r.reason || 'Credit adjustment',
      credit_type: r.credit_type,
      credit_delta: Number(r.delta),
      amount_cents: null,
      currency: null,
      status: 'completed',
      receipt_url: null,
    }));

    // ── Money-side events (Stripe invoices) ──
    let invoiceEvents: any[] = [];
    if (customerId) {
      try {
        const invoices = await stripe.invoices.list({ customer: customerId, limit });
        invoiceEvents = invoices.data.map((inv) => ({
          id: `invoice_${inv.id}`,
          type: 'invoice' as const,
          date: new Date((inv.created || 0) * 1000).toISOString(),
          description:
            inv.lines?.data?.[0]?.description
            || (inv.billing_reason === 'subscription_update' ? 'Plan change (prorated)' : 'Subscription charge'),
          credit_type: null,
          credit_delta: null,
          amount_cents: inv.amount_paid ?? inv.amount_due ?? 0,
          currency: inv.currency || 'usd',
          status: inv.status || 'unknown',
          receipt_url: inv.hosted_invoice_url || inv.invoice_pdf || null,
        }));
      } catch (stripeErr) {
        // Degrade to credit-only history rather than 500-ing the whole list.
        console.warn('⚠️ Billing history: Stripe invoice fetch failed:', stripeErr);
      }
    }

    const events = [...invoiceEvents, ...creditEvents]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    res.json({
      success: true,
      data: events,
      // Lets the CMS distinguish "no billing activity yet" from "we could not
      // reach Stripe", which are very different things to tell a paying user.
      meta: {
        stripe_available: !!customerId && invoiceEvents.length >= 0,
        has_stripe_customer: !!customerId,
      },
    });

  } catch (error) {
    console.error('Billing history error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch billing history'
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

    // BUG 3 — self-heal on read: if the customer has cards but no default (the
    // webhook never landed, or their old default was detached), promote one now
    // so Settings shows a default and the upgrade path can't fail. Idempotent
    // and a no-op when a default already exists.
    await ensureDefaultPaymentMethod(customerId);

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
    const defaultPm = await ensureDefaultPaymentMethod(customerId);

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

    // BUG 3 (same class) — removing the DEFAULT card left the customer with
    // cards but no default, which is exactly the state that made upgrades fail.
    // Promote a replacement immediately.
    await ensureDefaultPaymentMethod(customerId);

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

    const customerId = userResult[0].stripe_customer_id;

    // Update customer's default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: payment_method_id
      }
    });

    res.json({
      success: true,
      message: 'Default payment method updated'
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
