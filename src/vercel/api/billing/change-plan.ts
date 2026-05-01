// packages/functions/src/vercel/api/billing/change-plan.ts

/**
 * @fileoverview Vercel Change Plan Handler
 * @description Next.js API route wrapper for changePlan
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { StripeBackConfig } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { updateUserSubscription } from '../../../shared/billing/helpers/updateUserSubscription.js';
import { handleError } from '../../../shared/errorHandling.js';
import { stripe, validateStripeEnvironment } from '../../../shared/utils.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';
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
  req: NextApiRequest,
  res: NextApiResponse,
  data: { userId: string; newPriceId: string; billingConfigKey: string },
  context: { uid: string },
  billingConfig: StripeBackConfig
) {
  validateStripeEnvironment();

  // C7/W5: Use context.uid — ignore client-supplied userId to prevent IDOR.
  const userId = context.uid;
  const { newPriceId, billingConfigKey } = data;

  // Validate new plan
  const billingItem = billingConfig[billingConfigKey];
  if (!billingItem || billingItem.type !== 'StripeSubscription') {
    throw handleError(new Error('Invalid plan'));
  }

  if (billingItem.priceId !== newPriceId) {
    throw handleError(new Error('Price ID mismatch'));
  }

  // Get current subscription
  const user = await getFirebaseAdminAuth().getUser(userId);
  const subscriptionId = user.customClaims?.subscription?.subscriptionId;

  if (!subscriptionId) {
    throw handleError(new Error('No active subscription'));
  }

  // Update in Stripe
  const subscription = (await stripe.subscriptions.retrieve(
    subscriptionId
  )) as Stripe.Subscription;
  const updatedSubscription = (await stripe.subscriptions.update(
    subscriptionId,
    {
      items: [{ id: subscription.items.data[0]?.id, price: newPriceId }],
      proration_behavior: 'create_prorations',
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

  // Update Firebase Auth
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

  return res.status(200).json({
    success: true,
    newTier: billingItem.tier,
    newPrice: billingItem.price,
  });
}

/**
 * Change subscription plan function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
const changePlan = (billingConfig: StripeBackConfig) => {
  return createVercelBaseFunction(
    'POST',
    changePlanSchema,
    'change_plan',
    (req, res, data, context) =>
      changePlanLogic(req, res, data, context, billingConfig)
  );
};

export default changePlan;
