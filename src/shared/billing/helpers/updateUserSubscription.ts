// packages/functions/src/shared/billing/helpers/updateUserSubscription.ts

/**
 * @fileoverview User subscription update utilities
 * @description Functions for updating user subscription data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { SubscriptionClaimsSchema } from '@donotdev/core/server';
import type { BillingAuthProvider, SubscriptionUpdate } from '@donotdev/core/server';

/**
 * Platform-agnostic subscription update using dependency injection
 * Works on Firebase Functions, Vercel, AWS Lambda, etc.
 * Validates canonical auth claims; one-time payments may have no billing customer.
 * Billing identifiers are preserved when supplied, never fabricated from a user ID.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function updateUserSubscription(
  userId: string,
  subscriptionData: SubscriptionUpdate,
  authProvider: BillingAuthProvider
): Promise<void> {
  const user = await authProvider.getUser(userId);
  const currentClaims = user.customClaims || {};

  if (!subscriptionData.tier || !subscriptionData.status) {
    throw new Error('Invalid subscription data: missing tier or status');
  }

  const subscriptionClaims = v.parse(SubscriptionClaimsSchema, {
    tier: subscriptionData.tier,
    subscriptionId: subscriptionData.subscriptionId ?? null,
    customerId: subscriptionData.customerId ?? null,
    status: subscriptionData.status,
    // Keep as ISO string - no conversion needed
    subscriptionEnd: subscriptionData.subscriptionEnd,
    cancelAtPeriodEnd: subscriptionData.cancelAtPeriodEnd ?? false,
    updatedAt: new Date().toISOString(),
    isDefault: false,
  });

  const updatedClaims = {
    ...currentClaims,
    subscription: subscriptionClaims,
  };

  await authProvider.setCustomUserClaims(userId, updatedClaims);
}
