// packages/functions/src/firebase/billing/changePlan.ts

/**
 * @fileoverview Change Subscription Plan Function
 * @description Upgrades or downgrades user's subscription plan with prorated billing
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { StripeBackConfig } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { updateUserSubscription } from '../../shared/billing/helpers/updateUserSubscription.js';
import { handleError } from '../../shared/errorHandling.js';
import {
  stripe,
  validateStripeEnvironment,
  initStripe,
} from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { STRIPE_CONFIG } from '../config/constants.js';
import { stripeSecretKey } from '../config/secrets.js';

import type { CallableRequest } from 'firebase-functions/v2/https';
import type Stripe from 'stripe';

const changePlanSchema = v.object({
  userId: v.string(),
  newPriceId: v.string(),
  billingConfigKey: v.string(),
});

/**
 * Business logic for changing subscription plan
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function changePlanLogic(
  data: { userId: string; newPriceId: string; billingConfigKey: string },
  context: { uid: string; request: CallableRequest },
  billingConfig: StripeBackConfig
) {
  // W15: initStripe must be called before using the stripe proxy in v2.
  initStripe(stripeSecretKey.value());
  validateStripeEnvironment();

  // C7: Ignore client-supplied userId — always use the verified uid from the
  // auth context to prevent IDOR.
  const userId = context.uid;
  const { newPriceId, billingConfigKey } = data;

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
  const user = await getFirebaseAdminAuth().getUser(userId);
  const currentClaims = user.customClaims || {};
  const subscriptionId = currentClaims.subscription?.subscriptionId;

  if (!subscriptionId) {
    throw handleError(new Error('No active subscription found'));
  }

  // Get current subscription from Stripe
  const subscription = (await stripe.subscriptions.retrieve(
    subscriptionId
  )) as Stripe.Subscription;

  // Update subscription in Stripe
  const updatedSubscription = (await stripe.subscriptions.update(
    subscriptionId,
    {
      items: [
        {
          id: subscription.items.data[0]?.id,
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
  const status = validStatuses.includes(updatedSubscription.status as any)
    ? (updatedSubscription.status as (typeof validStatuses)[number])
    : 'incomplete';

  // Update Firebase Auth claims
  await updateUserSubscription(
    userId,
    {
      tier: billingItem.tier,
      status,
      subscriptionEnd: new Date(
        (updatedSubscription as any).current_period_end * 1000
      ).toISOString(),
      cancelAtPeriodEnd: (updatedSubscription as any).cancel_at_period_end,
      subscriptionId: updatedSubscription.id,
      customerId: updatedSubscription.customer as string,
    },
    {
      async getUser(uid: string) {
        return getFirebaseAdminAuth().getUser(uid);
      },
      async setCustomUserClaims(uid: string, claims: Record<string, any>) {
        await getFirebaseAdminAuth().setCustomUserClaims(uid, claims);
      },
    }
  );

  return {
    success: true,
    newTier: billingItem.tier,
    newPrice: billingItem.price,
  };
}

/**
 * Change subscription plan function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function changePlan(billingConfig: StripeBackConfig) {
  return createBaseFunction<
    v.InferOutput<typeof changePlanSchema>,
    { success: boolean; newTier: string; newPrice: number }
  >(STRIPE_CONFIG, changePlanSchema, 'change_plan', (data, context) =>
    changePlanLogic(data, context, billingConfig)
  );
}
