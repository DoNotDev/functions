// packages/functions/src/firebase/billing/refreshSubscriptionStatus.ts

/**
 * @fileoverview Refresh subscription status Firebase function
 * @description Firebase callable function for refreshing user subscription status
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { RefreshSubscriptionRequest } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { stripe, validateStripeEnvironment } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { STRIPE_CONFIG } from '../config/constants.js';

import type { CallableRequest } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';

/**
 * Schema for refreshing subscription status
 */
const refreshSubscriptionStatusSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
});

/**
 * Business logic for refreshing subscription status
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function refreshSubscriptionStatusLogic(
  data: RefreshSubscriptionRequest,
  context: {
    uid: string;
    request: CallableRequest<RefreshSubscriptionRequest>;
  }
) {
  // Validate environment
  validateStripeEnvironment();

  // C7: Ignore client-supplied userId — always use the verified uid from the
  // auth context to prevent IDOR (any user refreshing any user's subscription).
  const userId = context.uid;

  // Get user from Firebase
  const user = await getFirebaseAdminAuth().getUser(userId);
  const currentClaims = user.customClaims || {};

  // Get subscription from Stripe
  const subscriptionId = currentClaims.subscription?.subscriptionId;
  if (!subscriptionId) {
    throw new Error('No active subscription found');
  }

  const subscription = (await stripe.subscriptions.retrieve(
    subscriptionId
  )) as Stripe.Subscription;

  // Update user's custom claims
  const updatedClaims = {
    ...currentClaims,
    subscription: {
      ...currentClaims.subscription,
      status: subscription.status,
      currentPeriodStart: new Date(
        (subscription as any).current_period_start * 1000
      ).toISOString(),
      currentPeriodEnd: new Date(
        (subscription as any).current_period_end * 1000
      ).toISOString(),
      cancelAtPeriodEnd: (subscription as any).cancel_at_period_end,
    },
  };

  await getFirebaseAdminAuth().setCustomUserClaims(userId, updatedClaims);

  return {
    success: true,
    userId,
    status: subscription.status,
    currentPeriodEnd: new Date(
      (subscription as any).current_period_end * 1000
    ).toISOString(),
    cancelAtPeriodEnd: (subscription as any).cancel_at_period_end,
  };
}

/**
 * Refreshes user's subscription status from Stripe
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const refreshSubscriptionStatus = (
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) => {
  const schema = customSchema || refreshSubscriptionStatusSchema;
  return createBaseFunction(
    STRIPE_CONFIG,
    schema,
    'refresh_subscription_status',
    refreshSubscriptionStatusLogic
  );
};
