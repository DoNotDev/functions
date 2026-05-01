// packages/functions/src/supabase/billing/refreshSubscriptionStatus.ts

/**
 * @fileoverview Refresh Subscription Status — Supabase Edge Function
 * @description Direct Stripe lookup + claim update via Supabase Admin.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  initStripe,
  stripe,
  validateStripeEnvironment,
} from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { createSupabaseAuthProvider } from '../helpers/authProvider.js';

import type Stripe from 'stripe';

// =============================================================================
// Schema
// =============================================================================

const refreshSubscriptionSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
});

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler for refreshing subscription status.
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createRefreshSubscriptionStatus() {
  return createSupabaseHandler(
    'refresh-subscription-status',
    refreshSubscriptionSchema,
    async (data, ctx) => {
      initStripe(getStripeKey());
      validateStripeEnvironment();

      const authProvider = createSupabaseAuthProvider(ctx.supabaseAdmin);
      const user = await authProvider.getUser(data.userId);
      const currentClaims = user.customClaims || {};

      const subscriptionId = (
        currentClaims.subscription as { subscriptionId?: string } | undefined
      )?.subscriptionId;
      if (!subscriptionId) {
        throw new Error('No active subscription found');
      }

      const subscription = (await stripe.subscriptions.retrieve(
        subscriptionId
      )) as Stripe.Subscription;

      // Update claims via auth provider
      const updatedClaims = {
        ...currentClaims,
        subscription: {
          ...(currentClaims.subscription as Record<string, unknown>),
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

      await authProvider.setCustomUserClaims(data.userId, updatedClaims);

      return {
        success: true,
        userId: data.userId,
        status: subscription.status,
        currentPeriodEnd: new Date(
          (subscription as any).current_period_end * 1000
        ).toISOString(),
        cancelAtPeriodEnd: (subscription as any).cancel_at_period_end,
      };
    }
  );
}

function getStripeKey(): string {
  const key = (
    typeof Deno !== 'undefined'
      ? Deno.env.get('STRIPE_SECRET_KEY')
      : process.env.STRIPE_SECRET_KEY
  ) as string | undefined;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
  return key;
}

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;
