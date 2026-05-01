// packages/functions/src/vercel/api/billing/cancel.ts

/**
 * @fileoverview Vercel Cancel Subscription Handler
 * @description Next.js API route wrapper for cancelSubscription
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { cancelUserSubscription } from '../../../shared/billing/helpers/subscriptionManagement.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';

const cancelSubscriptionSchema = v.object({
  userId: v.string(),
});

/**
 * Business logic for canceling subscription
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function cancelSubscriptionLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: { userId: string },
  context: { uid: string }
) {
  // C7/W5: Use context.uid — ignore client-supplied userId to prevent IDOR.
  const userId = context.uid;

  const authProvider = {
    async getUser(uid: string) {
      return getFirebaseAdminAuth().getUser(uid);
    },
    async setCustomUserClaims(uid: string, claims: Record<string, unknown>) {
      await getFirebaseAdminAuth().setCustomUserClaims(uid, claims);
    },
  };

  const result = await cancelUserSubscription(userId, authProvider);

  return res.status(200).json({
    success: result.success,
    cancelAtPeriodEnd: true,
    endsAt: result.endsAt,
  });
}

/**
 * Cancel subscription function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
const cancelSubscription = () => {
  return createVercelBaseFunction(
    'POST',
    cancelSubscriptionSchema,
    'cancel_subscription',
    cancelSubscriptionLogic
  );
};

export default cancelSubscription;
