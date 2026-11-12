// packages/functions/src/shared/utils/external/subscription.ts

/**
 * @fileoverview Subscription utility functions
 * @description Functions for managing user subscriptions and billing
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { SubscriptionClaims } from '@donotdev/core/server';
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
 * Cancels user subscription and resets to free tier
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function cancelUserSubscription(
  firebaseUid: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: exported signature; narrowing it is a breaking change for importers (deferred to a major, any-audit 2026-11-11)
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
