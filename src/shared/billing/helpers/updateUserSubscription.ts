// packages/functions/src/shared/billing/helpers/updateUserSubscription.ts

/**
 * @fileoverview User subscription update utilities
 * @description Functions for updating user subscription data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// Removed Firebase-specific import

/**
 * Subscription data structure
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface SubscriptionData {
  tier: string;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';
  subscriptionEnd: string | null;
  cancelAtPeriodEnd?: boolean;
  subscriptionId?: string | null;
  customerId?: string;
}

/**
 * Platform-agnostic auth provider interface
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface AuthProvider {
  getUser(userId: string): Promise<{
    customClaims?: Record<string, unknown>;
  }>;
  setCustomUserClaims(
    userId: string,
    claims: Record<string, unknown>
  ): Promise<void>;
}

/**
 * Platform-agnostic subscription update using dependency injection
 * Works on Firebase Functions, Vercel, AWS Lambda, etc.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function updateUserSubscription(
  userId: string,
  subscriptionData: SubscriptionData,
  authProvider: AuthProvider
): Promise<void> {
  const user = await authProvider.getUser(userId);
  const currentClaims = user.customClaims || {};

  if (!subscriptionData.tier || !subscriptionData.status) {
    throw new Error('Invalid subscription data: missing tier or status');
  }

  // G57: Warn when customerId is undefined — falling back to userId loses the
  // Stripe customer ID, which makes future Stripe API calls unreliable.
  if (!subscriptionData.customerId) {
    console.warn(
      `[updateUserSubscription] customerId is undefined for user ${userId}. ` +
        `Falling back to userId. This may cause issues with Stripe API calls.`
    );
  }

  const subscriptionClaims = {
    tier: subscriptionData.tier,
    subscriptionId: subscriptionData.subscriptionId || null,
    customerId: subscriptionData.customerId || userId,
    status: subscriptionData.status,
    // Keep as ISO string - no conversion needed
    subscriptionEnd: subscriptionData.subscriptionEnd,
    cancelAtPeriodEnd: subscriptionData.cancelAtPeriodEnd || false,
    updatedAt: new Date().toISOString(),
    isDefault: false,
  };

  const updatedClaims = {
    ...currentClaims,
    subscription: subscriptionClaims,
  };

  await authProvider.setCustomUserClaims(userId, updatedClaims);
}
