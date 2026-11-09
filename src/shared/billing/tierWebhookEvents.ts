// packages/functions/src/shared/billing/tierWebhookEvents.ts

/**
 * @fileoverview Stripe webhook handlers for tier items
 * @description StripePayment / StripeSubscription event handlers routed by
 * `processWebhook`: checkout grant (payment_status aware), renewal,
 * cancellation and payment failure.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import {
  calculateSubscriptionEndDate,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_TIERS,
} from '@donotdev/core/server';
import type { BillingAuthProvider, StripeBackConfig, UpdateSubscriptionFn } from '@donotdev/core/server';

import { handleError } from '../errorHandling.js';
import { logger } from '../logger.js';
import type { OrderSessionEventType } from './orderWebhook.js';

/**
 * Checkout Session event of a StripePayment / StripeSubscription item.
 * Grants only once the payment is settled (Stripe fulfillment guide,
 * https://docs.stripe.com/checkout/fulfillment):
 * - `completed` + `paid` / `no_payment_required` → grant
 * - `completed` + `unpaid` (delayed method, e.g. SEPA debit) → log, wait
 * - `async_payment_succeeded` → grant
 * - `async_payment_failed` → log (nothing was granted)
 * - `expired` → ignored
 *
 * @throws When `payment_status` is not a known value, or when the grant fails
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export async function handleTierCheckoutEvent(
  eventType: OrderSessionEventType,
  session: Stripe.Checkout.Session,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: BillingAuthProvider | null
): Promise<void> {
  const logContext = {
    sessionId: session.id,
    billingConfigKey: session.metadata?.billingConfigKey,
    userId: session.metadata?.userId,
    paymentStatus: session.payment_status,
  };
  switch (eventType) {
    case 'checkout.session.completed':
      if (session.payment_status === 'unpaid') {
        logger.info('[Webhook] Purchase awaiting async payment', {
          ...logContext,
          operation: 'purchase_payment_pending',
        });
        return;
      }
      if (
        session.payment_status !== 'paid' &&
        session.payment_status !== 'no_payment_required'
      ) {
        throw handleError(
          new Error(
            `Checkout session ${session.id} has unknown payment_status ${String(session.payment_status)}`
          )
        );
      }
      await grantCheckoutPurchase(
        session,
        config,
        updateSubscription,
        authProvider
      );
      return;
    case 'checkout.session.async_payment_succeeded':
      await grantCheckoutPurchase(
        session,
        config,
        updateSubscription,
        authProvider
      );
      return;
    case 'checkout.session.async_payment_failed':
      logger.warn('[Webhook] Async purchase payment failed, nothing granted', {
        ...logContext,
        operation: 'purchase_payment_failed',
      });
      return;
    case 'checkout.session.expired':
      logger.debug('[Webhook] Checkout session expired', logContext);
      return;
  }
}

/**
 * Grant the tier bought in a paid Checkout Session, then run the item hook.
 * Idempotent: it writes the same subscription state again on a replay.
 */
async function grantCheckoutPurchase(
  session: Stripe.Checkout.Session,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: BillingAuthProvider | null
): Promise<void> {
  const { userId, billingConfigKey } = session.metadata || {};

  if (!userId || !billingConfigKey) {
    throw handleError(
      new Error(
        `Missing required metadata: userId=${userId}, billingConfigKey=${billingConfigKey}`
      )
    );
  }

  const billingItem = config[billingConfigKey];
  if (!billingItem) {
    throw handleError(
      new Error(`Unknown billing config key: ${billingConfigKey}`)
    );
  }

  logger.info('[Webhook] Processing purchase', {
    userId,
    configKey: billingConfigKey,
    type: billingItem.type,
    operation: 'purchase_processing',
  });

  // Update subscription
  if (billingItem.type === 'StripePayment') {
    if (!authProvider) {
      throw handleError(
        new Error('Auth provider required for subscription updates')
      );
    }
    await updateSubscription(
      userId,
      {
        tier: billingItem.tier,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        subscriptionEnd: calculateSubscriptionEndDate(billingItem.duration),
        customerId: session.customer as string,
      },
      authProvider
    );

    // Execute hook with graceful error handling
    if (billingItem.onPurchaseSuccess) {
      try {
        await billingItem.onPurchaseSuccess(userId, session.metadata || {});
      } catch (error) {
        // Hook failures are non-critical - payment already processed
        // Log for manual intervention but don't fail the webhook
        logger.error('[Webhook] Hook failed (non-critical)', {
          error: error instanceof Error ? error : new Error(String(error)),
          hookName: 'onPurchaseSuccess',
          userId,
          operation: 'hook_execution',
        });
      }
    }
  }

  if (billingItem.type === 'StripeSubscription') {
    if (!authProvider) {
      throw handleError(
        new Error('Auth provider required for subscription updates')
      );
    }
    await updateSubscription(
      userId,
      {
        tier: billingItem.tier,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        subscriptionEnd: calculateSubscriptionEndDate(billingItem.duration),
        subscriptionId: session.subscription as string,
        customerId: session.customer as string,
      },
      authProvider
    );

    // Execute hook with graceful error handling
    if (billingItem.onSubscriptionCreated) {
      try {
        await billingItem.onSubscriptionCreated(userId, session.metadata || {});
      } catch (error) {
        // Hook failures are non-critical - subscription already created
        // Log for manual intervention but don't fail the webhook
        logger.error('[Webhook] Hook failed (non-critical)', {
          error: error instanceof Error ? error : new Error(String(error)),
          hookName: 'onSubscriptionCreated',
          userId,
          operation: 'hook_execution',
        });
      }
    }
  }

  logger.info('[Webhook] Purchase processed', {
    userId,
    configKey: billingConfigKey,
    operation: 'purchase_processed',
  });
}

/**
 * Handle subscription renewal
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  stripe: Stripe,
  authProvider: BillingAuthProvider | null
): Promise<void> {
  const subscriptionId = (invoice as any).subscription as string;
  if (!subscriptionId) return;

  // ✅ FIX: Fetch subscription to get metadata
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const { userId, billingConfigKey } = subscription.metadata || {};
  if (!userId || !billingConfigKey) {
    // G60: Log when subscription metadata is missing — silent return loses the event
    logger.error(
      '[Webhook] Subscription metadata missing userId or billingConfigKey',
      {
        subscriptionId,
        hasUserId: !!userId,
        hasBillingConfigKey: !!billingConfigKey,
        operation: 'invoice_payment_succeeded_metadata_missing',
      }
    );
    return;
  }

  const billingItem = config[billingConfigKey];
  if (!billingItem || billingItem.type !== 'StripeSubscription') return;

  // Renew subscription
  if (!authProvider) {
    throw handleError(
      new Error('Auth provider required for subscription updates')
    );
  }
  await updateSubscription(
    userId,
    {
      tier: billingItem.tier,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionEnd: calculateSubscriptionEndDate(billingItem.duration),
      subscriptionId: subscriptionId,
      customerId: invoice.customer as string,
    },
    authProvider
  );

  // Execute hook with graceful error handling
  if (billingItem.onSubscriptionRenewed) {
    try {
      await billingItem.onSubscriptionRenewed(
        userId,
        subscription.metadata || {}
      );
    } catch (error) {
      // Hook failures are non-critical - subscription already renewed
      // Log for manual intervention but don't fail the webhook
      logger.error('[Webhook] Hook failed (non-critical)', {
        error: error instanceof Error ? error : new Error(String(error)),
        hookName: 'onSubscriptionRenewed',
        userId,
        operation: 'hook_execution',
      });
    }
  }

  logger.info('[Webhook] Subscription renewed', {
    userId,
    billingConfigKey,
    operation: 'subscription_renewed',
  });
}

/**
 * Handle subscription cancellation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: BillingAuthProvider | null
): Promise<void> {
  const { userId, billingConfigKey } = subscription.metadata || {};
  if (!userId || !billingConfigKey) return;

  const billingItem = config[billingConfigKey];
  if (!billingItem || billingItem.type !== 'StripeSubscription') return;

  // Update to cancelled
  if (!authProvider) {
    throw handleError(
      new Error('Auth provider required for subscription updates')
    );
  }
  await updateSubscription(
    userId,
    {
      tier: SUBSCRIPTION_TIERS.FREE,
      status: SUBSCRIPTION_STATUS.CANCELED,
      subscriptionEnd: new Date(
        (subscription as any).current_period_end * 1000
      ).toISOString(),
      subscriptionId: subscription.id,
      customerId: subscription.customer as string,
    },
    authProvider
  );

  // Execute hook with graceful error handling
  if (billingItem.onSubscriptionCancelled) {
    try {
      await billingItem.onSubscriptionCancelled(
        userId,
        subscription.metadata || {}
      );
    } catch (error) {
      // Hook failures are non-critical - subscription already cancelled
      // Log for manual intervention but don't fail the webhook
      logger.error('[Webhook] Hook failed (non-critical)', {
        error: error instanceof Error ? error : new Error(String(error)),
        hookName: 'onSubscriptionCancelled',
        userId,
        operation: 'hook_execution',
      });
    }
  }

  logger.info('[Webhook] Subscription cancelled', {
    userId,
    billingConfigKey,
    operation: 'subscription_cancelled',
  });
}

/**
 * Handle payment failure
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function handlePaymentFailed(
  invoice: Stripe.Invoice,
  config: StripeBackConfig
): Promise<void> {
  const { userId, billingConfigKey } = invoice.metadata || {};
  if (!userId || !billingConfigKey) {
    logger.warn('[Webhook] Payment failed - missing metadata', {
      invoiceId: invoice.id,
      hasUserId: !!userId,
      hasBillingConfigKey: !!billingConfigKey,
      operation: 'payment_failed_metadata_missing',
    });
    return;
  }

  const billingItem = config[billingConfigKey];
  if (!billingItem) {
    logger.error('[Webhook] Payment failed - unknown billing config', {
      error: new Error(`Unknown billing config key: ${billingConfigKey}`),
      userId,
      billingConfigKey,
      operation: 'payment_failed_unknown_config',
    });
    return;
  }

  // Execute hooks with graceful error handling
  if (billingItem.type === 'StripePayment' && billingItem.onPurchaseFailure) {
    try {
      // Pass the actual metadata - we've already validated it exists
      await billingItem.onPurchaseFailure(userId, invoice.metadata || {});
    } catch (error) {
      // Hook failures are non-critical - payment already failed
      // Log for manual intervention but don't fail the webhook
      logger.error('[Webhook] Hook failed (non-critical)', {
        error: error instanceof Error ? error : new Error(String(error)),
        hookName: 'onPurchaseFailure',
        userId,
        operation: 'hook_execution',
      });
    }
  }

  if (
    billingItem.type === 'StripeSubscription' &&
    billingItem.onPaymentFailed
  ) {
    try {
      await billingItem.onPaymentFailed(userId, invoice.metadata || {});
    } catch (error) {
      // Hook failures are non-critical - payment already failed
      // Log for manual intervention but don't fail the webhook
      logger.error('[Webhook] Hook failed (non-critical)', {
        error: error instanceof Error ? error : new Error(String(error)),
        hookName: 'onPaymentFailed',
        userId,
        operation: 'hook_execution',
      });
    }
  }

  logger.warn('[Webhook] Payment failed', {
    userId,
    billingConfigKey,
    operation: 'payment_failed',
  });
}
