// packages/functions/src/shared/billing/webhookHandler.ts

/**
 * @fileoverview Stripe webhook handler
 * @description Handles Stripe webhook events for subscription management
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  validateStripeBackConfig,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_TIERS,
} from '@donotdev/core/server';
import type { StripeBackConfig } from '@donotdev/core/server';

import { handleError } from '../errorHandling.js';
import { logger } from '../logger.js';
import { createIdempotencyStore } from './idempotency.js';
import { calculateSubscriptionEndDate } from '../utils/external/date.js';

import type {
  SubscriptionData,
  AuthProvider,
} from './helpers/updateUserSubscription.js';
import type Stripe from 'stripe';

// W7: Lazy singleton — resolving at import time reads env vars / Firebase Admin
// before they are fully injected (e.g., defineSecret values on Firebase Functions v2).
// Resolved on first use instead.
let _idempotencyStore: ReturnType<typeof createIdempotencyStore> | null = null;
function getIdempotencyStore() {
  if (!_idempotencyStore) {
    _idempotencyStore = createIdempotencyStore();
  }
  return _idempotencyStore;
}

/**
 * Platform-agnostic auth provider interface for webhook handlers
 */
export interface WebhookAuthProvider {
  getUser(userId: string): Promise<{
    customClaims?: Record<string, unknown>;
  }>;
  setCustomUserClaims(
    userId: string,
    claims: Record<string, unknown>
  ): Promise<void>;
}

/**
 * Subscription update function type
 */
export type UpdateSubscriptionFn = (
  userId: string,
  data: SubscriptionData,
  authProvider: AuthProvider
) => Promise<void>;

/**
 * Process webhook with automatic idempotency detection
 *
 * @param rawBody - Raw request body
 * @param signature - Stripe signature
 * @param webhookSecret - Stripe webhook secret
 * @param stripe - Stripe instance
 * @param billingConfig - Billing configuration
 * @param updateSubscription - Function to update user subscription
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function processWebhook(
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
  stripe: Stripe,
  billingConfig: unknown,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: WebhookAuthProvider | null
): Promise<{ success: boolean; message: string }> {
  try {
    // Validate billing config
    const config = validateStripeBackConfig(billingConfig);

    // Verify webhook signature
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret
    );

    // Log event processing (non-critical, so we don't throw)
    logger.info('[Webhook] Processing event', {
      eventType: event.type,
      eventId: event.id,
      operation: 'webhook_processing',
    });

    // ✅ CHECK+RESERVE: Atomic idempotency (eliminates TOCTOU race between check and mark)
    if (await getIdempotencyStore().checkAndReserve(event.id)) {
      logger.info('[Webhook] Already processed', { eventId: event.id });
      return { success: true, message: 'Event already processed' };
    }

    // G59: Warn when authProvider is null — subscription update events will fail
    if (!authProvider) {
      logger.warn(
        '[Webhook] authProvider is null — subscription-related events will fail',
        {
          eventType: event.type,
          eventId: event.id,
        }
      );
    }

    // Route to handler
    await routeEvent(event, config, updateSubscription, stripe, authProvider);

    return { success: true, message: 'Webhook processed' };
  } catch (error) {
    throw handleError(error);
  }
}

/**
 * Route events to appropriate handlers
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function routeEvent(
  event: Stripe.Event,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  stripe: Stripe,
  authProvider: WebhookAuthProvider | null
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session,
        config,
        updateSubscription,
        authProvider
      );
      break;

    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(
        event.data.object as Stripe.Invoice,
        config,
        updateSubscription,
        stripe,
        authProvider
      );
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        config,
        updateSubscription,
        authProvider
      );
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.Invoice, config);
      break;

    default:
      // W23: Use structured logger instead of console.log in production
      logger.debug('[Webhook] Unhandled event type', { type: event.type });
  }
}

/**
 * Handle checkout completed with graceful hook execution
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: WebhookAuthProvider | null
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
async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  stripe: Stripe,
  authProvider: WebhookAuthProvider | null
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
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: WebhookAuthProvider | null
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
async function handlePaymentFailed(
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

/**
 * Calculate subscription end date with proper edge case handling
 * Fixes issues like Jan 31 + 1 month = March 3 (should be Feb 28/29)
 */
// Removed - now using calculateSubscriptionEndDate from @donotdev/core/server
