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
  cancelSubscription
} from '../models/user.models.js';

const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover'
});

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
      success_url: `${success_url}?session_id={CHECKOUT_SESSION_ID}`,
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
      success_url: `${success_url}?session_id={CHECKOUT_SESSION_ID}`,
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
      success_url: `${success_url}?session_id={CHECKOUT_SESSION_ID}`,
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

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        
        const userId = parseInt(session.metadata?.user_id || '0');
        const purchaseType = session.metadata?.purchase_type;

        if (purchaseType === 'credit_topup') {
          // Handle credit purchase
          const creditType = session.metadata?.credit_type as 'images' | 'content' | 'keywords';
          const quantity = parseInt(session.metadata?.quantity || '0');

          await sql`
            UPDATE credit_balances
            SET amount = amount + ${quantity}, updated_at = NOW()
            WHERE user_id = ${userId} AND credit_type = ${creditType}
          `;

          await sql`
            INSERT INTO credit_transactions (user_id, credit_type, delta, reason)
            VALUES (${userId}, ${creditType}, ${quantity}, 'Credit purchase via Stripe')
          `;

          console.log(`✅ Added ${quantity} ${creditType} credits to user ${userId}`);
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

          // Update or create subscription (user_id is UNIQUE)
          await sql`
            INSERT INTO subscriptions (
              user_id, 
              plan_id, 
              status, 
              stripe_subscription_id,
              stripe_customer_id,
              start_date,
              next_billing_date
            )
            VALUES (
              ${userId}, 
              ${planId}, 
              'active', 
              ${subscription.id},
              ${subscription.customer as string},
              NOW(),
              TO_TIMESTAMP(${nextBillingTimestamp})
            )
            ON CONFLICT (user_id) 
            DO UPDATE SET 
              plan_id = ${planId},
              status = 'active',
              stripe_subscription_id = ${subscription.id},
              stripe_customer_id = ${subscription.customer as string},
              next_billing_date = TO_TIMESTAMP(${nextBillingTimestamp})
          `;

          // Refill credits based on new plan
          const planResult = await sql`SELECT * FROM subscription_plans WHERE id = ${planId}`;
          if (planResult.length > 0) {
            const plan = planResult[0];

            await sql`
              INSERT INTO credit_balances (user_id, credit_type, amount)
              VALUES 
                (${userId}, 'images', ${plan.image_credits}),
                (${userId}, 'content', ${plan.content_credits}),
                (${userId}, 'keywords', ${plan.keyword_credits})
              ON CONFLICT (user_id, credit_type)
              DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()
            `;

            console.log(`✅ Subscription created for user ${userId}, plan ${planId}, credits refilled`);
          }
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

          await sql`
            UPDATE subscriptions 
            SET 
              status = ${subscription.status},
              next_billing_date = TO_TIMESTAMP(${nextBillingTimestamp})
            WHERE stripe_subscription_id = ${subscription.id}
          `;

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

          // Downgrade to basic plan
          await sql`
            UPDATE users SET plan_id = 1, updated_at = NOW()
            WHERE id = ${userId}
          `;

          await sql`
            UPDATE subscriptions 
            SET status = 'cancelled'
            WHERE user_id = ${userId}
          `;

          console.log(`⚠️ Subscription cancelled for user ${userId}, downgraded to basic plan`);
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

            // Refill credits for monthly billing
            const planResult = await sql`SELECT * FROM subscription_plans WHERE id = ${plan_id}`;
            if (planResult.length > 0) {
              const plan = planResult[0];

              await sql`
                INSERT INTO credit_balances (user_id, credit_type, amount)
                VALUES 
                  (${user_id}, 'images', ${plan.image_credits}),
                  (${user_id}, 'content', ${plan.content_credits}),
                  (${user_id}, 'keywords', ${plan.keyword_credits})
                ON CONFLICT (user_id, credit_type)
                DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()
              `;

              console.log(`✅ Monthly credits refilled for user ${user_id} (invoice paid)`);
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
            console.warn(`⚠️ Payment failed for user ${userId}, subscription may be at risk`);
            // You could send an email notification here
          }
        }
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({
      success: false,
      error: 'Webhook processing failed'
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
 * Change subscription plan (upgrade or downgrade)
 * POST /api/v1/stripe/change-plan
 */
router.post('/change-plan', async (req: Request, res: Response) => {
  try {
    const { user_id, new_plan_id } = z.object({
      user_id: z.number(),
      new_plan_id: z.number()
    }).parse(req.body);

    // Get current subscription
    const currentSub = await getUserSubscription(user_id);
    if (!currentSub) {
      return res.status(404).json({
        success: false,
        error: 'No active subscription found'
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

        // Update subscription with new price
        await stripe.subscriptions.update(currentSub.stripe_subscription_id, {
          items: [{
            id: stripeSubscription.items.data[0].id,
            price: newPlan.stripe_price_id, // ✅ Change the price
          }],
          proration_behavior: isUpgrade ? 'create_prorations' : 'none',
          billing_cycle_anchor: 'unchanged' // Keep same billing date
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

export default router;
