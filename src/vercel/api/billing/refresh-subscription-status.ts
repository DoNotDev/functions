// packages/functions/src/vercel/api/billing/refresh-subscription-status.ts

/**
 * @fileoverview Refresh subscription status API handler
 * @description Vercel API route for refreshing user subscription status
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { RefreshSubscriptionRequest } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { stripe, validateStripeEnvironment } from '../../../shared/utils.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';

const refreshSubscriptionStatusSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
});

// Helper function
function getTierFromPriceId(priceId?: string): string {
  const priceToTierMap: Record<string, string> = {
    // Add your actual price IDs here
    // 'price_1234567890': 'pro',
    // 'price_0987654321': 'enterprise',
  };

  return priceToTierMap[priceId || ''] || 'free';
}

/**
 * Business logic for refreshing subscription status
 * Base function handles: validation, auth, rate limiting, monitoring
 */
async function refreshSubscriptionStatusLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: RefreshSubscriptionRequest,
  context: { uid: string }
) {
  // Validate environment
  validateStripeEnvironment();

  // W5: Ignore client-supplied userId — use the verified uid from the auth context
  // to prevent IDOR (any authenticated user overwriting any user's subscription claims).
  const userId = context.uid;

  // Get user from Firebase
  const user = await getFirebaseAdminAuth().getUser(userId);
  const currentClaims = user.customClaims || {};

  // Check if user has a subscription
  if (!currentClaims.subscriptionId) {
    return {
      success: true,
      subscription: null,
      message: 'User has no active subscription',
    };
  }

  // Retrieve subscription from Stripe
  const subscription = (await stripe.subscriptions.retrieve(
    currentClaims.subscriptionId as string
  )) as Stripe.Subscription;

  // Update user claims with fresh subscription data
  const subscriptionClaims = {
    tier: getTierFromPriceId(subscription.items.data[0]?.price.id),
    subscriptionId: subscription.id,
    customerId: subscription.customer,
    status: subscription.status,
    currentPeriodEnd: new Date(
      (subscription as any).current_period_end * 1000
    ).toISOString(),
  };

  await getFirebaseAdminAuth().setCustomUserClaims(userId, {
    ...currentClaims,
    ...subscriptionClaims,
  });

  return {
    success: true,
    subscription: subscriptionClaims,
    message: 'Subscription status updated successfully',
  };
}

/**
 * Vercel API handler for refreshing subscription status
 * Base function handles all common concerns automatically
 */
const refreshSubscriptionStatus = (
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) => {
  const schema = customSchema || refreshSubscriptionStatusSchema;
  return createVercelBaseFunction(
    'POST',
    schema,
    'refresh_subscription_status',
    refreshSubscriptionStatusLogic
  );
};

export default refreshSubscriptionStatus;
