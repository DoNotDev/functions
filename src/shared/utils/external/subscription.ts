// packages/functions/src/shared/utils/external/subscription.ts

/**
 * @fileoverview Subscription utility functions
 * @description Functions for managing user subscriptions and billing
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  SubscriptionStatus,
  SubscriptionClaims,
} from '@donotdev/core/server';
import { SUBSCRIPTION_STATUS } from '@donotdev/core/server';
import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
} from '@donotdev/firebase/server';

/**
 * Maps Stripe price ID to subscription tier
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getTierFromPriceId(priceId: string): string {
  const tierMapping: Record<string, string> = {
    // Monthly subscriptions
    price_pro_monthly: 'pro',
    price_ai_monthly: 'ai',

    // Yearly subscriptions
    price_pro_yearly: 'pro',
    price_ai_yearly: 'ai',

    // Add your actual Stripe price IDs here
  };

  return tierMapping[priceId] || 'free';
}

/**
 * Validates subscription status and updates Firebase custom claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function updateFirebaseUserSubscription(
  firebaseUid: string,
  subscription: any
): Promise<void> {
  if (!firebaseUid) {
    throw new Error('Firebase UID is required to update subscription');
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const tier = getTierFromPriceId(priceId);

  // Validate status: must be a framework value OR a valid custom consumer value (non-empty string)
  // Default to 'incomplete' if invalid/empty
  const frameworkStatuses = Object.values(SUBSCRIPTION_STATUS);
  const rawStatus = subscription.status || '';
  const isValidFrameworkStatus = frameworkStatuses.includes(rawStatus as any);
  const isValidCustomStatus =
    typeof rawStatus === 'string' && rawStatus.trim().length > 0;

  const status: SubscriptionStatus =
    isValidFrameworkStatus || isValidCustomStatus
      ? (rawStatus as SubscriptionStatus)
      : SUBSCRIPTION_STATUS.INCOMPLETE;

  const subscriptionClaims: SubscriptionClaims = {
    tier,
    subscriptionId: subscription.id,
    customerId: subscription.customer,
    status,
    subscriptionEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
    updatedAt: new Date().toISOString(),
  };

  try {
    const auth = getFirebaseAdminAuth();
    const db = getFirebaseAdminFirestore();

    // Read existing claims and merge to avoid overwriting other claims
    const user = await auth.getUser(firebaseUid);
    const currentClaims = user.customClaims || {};

    // Update Firebase Auth custom claims
    await auth.setCustomUserClaims(firebaseUid, {
      ...currentClaims,
      subscription: subscriptionClaims,
    });

    // Also save to Firestore for redundancy and querying
    await db
      .collection('subscriptions')
      .doc(firebaseUid)
      .set(
        {
          ...subscriptionClaims,
          priceId,
          createdAt: subscription.created
            ? new Date(subscription.created * 1000).toISOString()
            : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

    console.log(`Subscription updated for user ${firebaseUid}:`, {
      tier,
      status: subscription.status,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error('Failed to update user subscription:', error);
    throw new Error('Failed to update user subscription');
  }
}

/**
 * Cancels user subscription and resets to free tier
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function cancelUserSubscription(
  firebaseUid: string,
  subscription: any
): Promise<void> {
  if (!firebaseUid) {
    throw new Error('Firebase UID is required to cancel subscription');
  }

  const subscriptionClaims: SubscriptionClaims = {
    tier: 'free',
    subscriptionId: null,
    customerId: subscription.customer,
    status: 'canceled',
    subscriptionEnd: null,
    cancelAtPeriodEnd: false,
    updatedAt: new Date().toISOString(),
  };

  try {
    const auth = getFirebaseAdminAuth();
    const db = getFirebaseAdminFirestore();

    // Read existing claims and merge to avoid overwriting other claims
    const user = await auth.getUser(firebaseUid);
    const currentClaims = user.customClaims || {};

    // Update Firebase Auth custom claims
    await auth.setCustomUserClaims(firebaseUid, {
      ...currentClaims,
      subscription: subscriptionClaims,
    });

    // Update Firestore
    await db
      .collection('subscriptions')
      .doc(firebaseUid)
      .update({
        ...subscriptionClaims,
        updatedAt: new Date().toISOString(),
      });

    console.log(`Subscription canceled for user ${firebaseUid}:`, {
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error('Failed to cancel user subscription:', error);
    throw new Error('Failed to cancel user subscription');
  }
}

/**
 * Gets user's current subscription from Firebase
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getUserSubscription(
  firebaseUid: string
): Promise<SubscriptionClaims | null> {
  try {
    const auth = getFirebaseAdminAuth();
    const user = await auth.getUser(firebaseUid);
    return (user.customClaims?.subscription as SubscriptionClaims) || null;
  } catch (error) {
    console.error('Failed to get user subscription:', error);
    return null;
  }
}
