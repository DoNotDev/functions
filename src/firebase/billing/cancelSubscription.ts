// packages/functions/src/firebase/billing/cancelSubscription.ts

/**
 * @fileoverview Cancel Subscription Function
 * @description Cancels user's subscription at period end (doesn't delete immediately)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { cancelUserSubscription } from '../../shared/billing/helpers/subscriptionManagement.js';
import { initStripe } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { STRIPE_CONFIG } from '../config/constants.js';
import { stripeSecretKey } from '../config/secrets.js';

import type { CallableRequest } from 'firebase-functions/v2/https';

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
  data: { userId: string },
  context: { uid: string; request: CallableRequest }
) {
  // W15: initStripe must be called before using the stripe proxy in v2.
  initStripe(stripeSecretKey.value());

  // C7: Ignore client-supplied userId — always use the verified uid from the
  // auth context. A client passing another user's ID would otherwise allow
  // cancelling any user's subscription (IDOR).
  const userId = context.uid;

  const authProvider = {
    async getUser(uid: string) {
      return getFirebaseAdminAuth().getUser(uid);
    },
    async setCustomUserClaims(uid: string, claims: Record<string, unknown>) {
      await getFirebaseAdminAuth().setCustomUserClaims(uid, claims);
    },
  };

  return await cancelUserSubscription(userId, authProvider);
}

/**
 * Cancel subscription function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function cancelSubscription() {
  return createBaseFunction(
    STRIPE_CONFIG,
    cancelSubscriptionSchema,
    'cancel_subscription',
    cancelSubscriptionLogic
  );
}
