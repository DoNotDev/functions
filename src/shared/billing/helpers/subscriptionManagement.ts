// packages/functions/src/shared/billing/helpers/subscriptionManagement.ts

/**
 * @fileoverview Shared Subscription Management Logic
 * @description Platform-agnostic subscription management functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import { SUBSCRIPTION_STATUS } from '@donotdev/core/server';
import type {
  BillingAuthProvider,
  StripeBackConfig,
} from '@donotdev/core/server';

import { updateUserSubscription } from './updateUserSubscription.js';
import { handleError } from '../../errorHandling.js';
import { stripe, validateStripeEnvironment } from '../stripeClient.js';
import { isOneOf, pinnedSubscriptionPeriod } from '../stripePinned.js';

/**
 * Cancel user subscription at period end
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function cancelUserSubscription(
  userId: string,
  authProvider: BillingAuthProvider
): Promise<{ success: boolean; endsAt: string }> {
  validateStripeEnvironment();

  // Get user's current subscription
  const user = await authProvider.getUser(userId);
  const currentClaims = user.customClaims || {};
  const subscription = currentClaims.subscription as
    | { subscriptionId?: string; tier?: string }
    | undefined;
  const subscriptionId = subscription?.subscriptionId;

  if (!subscriptionId) {
    throw handleError(new Error('No active subscription found'));
  }

  // Cancel at period end (don't delete immediately)
  const updatedSubscription = (await stripe.subscriptions.update(
    subscriptionId,
    {
      cancel_at_period_end: true,
    }
  )) as Stripe.Subscription;

  // Filter status to valid SubscriptionStatus values
  const validStatuses = [
    'active',
    'canceled',
    'past_due',
    'trialing',
    'incomplete',
  ] as const;
  const status = isOneOf(validStatuses, updatedSubscription.status)
    ? updatedSubscription.status
    : 'incomplete';

  // Update Firebase Auth claims
  await updateUserSubscription(
    userId,
    {
      tier: subscription?.tier || 'free',
      status,
      subscriptionEnd: new Date(
        pinnedSubscriptionPeriod(updatedSubscription).current_period_end * 1000
      ).toISOString(),
      cancelAtPeriodEnd: true,
      subscriptionId: updatedSubscription.id,
      customerId: updatedSubscription.customer as string,
    },
    authProvider
  );

  return {
    success: true,
    endsAt: new Date(
      pinnedSubscriptionPeriod(updatedSubscription).current_period_end * 1000
    ).toISOString(),
  };
}

/**
 * Change user subscription plan
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function changeUserPlan(
  userId: string,
  newPriceId: string,
  billingConfigKey: string,
  billingConfig: StripeBackConfig,
  authProvider: BillingAuthProvider
): Promise<{ success: boolean; newTier: string; newPrice: number }> {
  validateStripeEnvironment();

  // Validate new plan exists in config
  const billingItem = billingConfig[billingConfigKey];
  if (!billingItem || billingItem.type !== 'StripeSubscription') {
    throw handleError(new Error('Invalid plan'));
  }

  // Validate price ID matches config
  if (billingItem.priceId !== newPriceId) {
    throw handleError(new Error('Price ID mismatch with configuration'));
  }

  // Get current subscription
  const user = await authProvider.getUser(userId);
  const currentClaims = user.customClaims || {};
  const subscription = currentClaims.subscription as
    | { subscriptionId?: string }
    | undefined;
  const subscriptionId = subscription?.subscriptionId;

  if (!subscriptionId) {
    throw handleError(new Error('No active subscription found'));
  }

  // Get current subscription from Stripe
  const currentSubscription = (await stripe.subscriptions.retrieve(
    subscriptionId
  )) as Stripe.Subscription;

  // Update subscription in Stripe
  const updatedSubscription = (await stripe.subscriptions.update(
    subscriptionId,
    {
      items: [
        {
          id: currentSubscription.items.data[0]?.id,
          price: newPriceId,
        },
      ],
      proration_behavior: 'create_prorations', // Pro-rate the change
    }
  )) as Stripe.Subscription;

  // Filter status to valid SubscriptionStatus values
  const validStatuses = [
    'active',
    'canceled',
    'past_due',
    'trialing',
    'incomplete',
  ] as const;
  const status = isOneOf(validStatuses, updatedSubscription.status)
    ? updatedSubscription.status
    : 'incomplete';

  // Update Firebase Auth claims
  await updateUserSubscription(
    userId,
    {
      tier: billingItem.tier,
      status,
      subscriptionEnd: new Date(
        pinnedSubscriptionPeriod(updatedSubscription).current_period_end * 1000
      ).toISOString(),
      cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
      subscriptionId: updatedSubscription.id,
      customerId: updatedSubscription.customer as string,
    },
    authProvider
  );

  return {
    success: true,
    newTier: billingItem.tier,
    newPrice: billingItem.price,
  };
}

/**
 * Create Stripe Customer Portal session
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function createCustomerPortalSession(
  userId: string,
  authProvider: BillingAuthProvider,
  returnUrl?: string
): Promise<{ url: string }> {
  validateStripeEnvironment();

  // Get customer ID from user claims
  const user = await authProvider.getUser(userId);
  const currentClaims = user.customClaims || {};
  const subscription = currentClaims.subscription as
    | { customerId?: string }
    | undefined;
  const customerId = subscription?.customerId;

  if (!customerId) {
    throw handleError(new Error('No customer found'));
  }

  // Validate returnUrl domain
  if (returnUrl) {
    const parsed = new URL(returnUrl);
    const frontendUrl = new URL(process.env.FRONTEND_URL || '');
    if (parsed.origin !== frontendUrl.origin) {
      throw new Error('Invalid return URL: must match frontend domain');
    }
  }

  // Create portal session
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || `${process.env.FRONTEND_URL}/billing`,
  });

  return {
    url: session.url,
  };
}
