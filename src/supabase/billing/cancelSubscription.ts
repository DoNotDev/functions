// packages/functions/src/supabase/billing/cancelSubscription.ts

/**
 * @fileoverview Cancel Subscription — Supabase Edge Function
 * @description Wraps the shared `cancelUserSubscription` for Supabase.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { cancelUserSubscription } from '../../shared/billing/helpers/subscriptionManagement.js';
import { initStripe } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { createSupabaseAuthProvider } from '../helpers/authProvider.js';

// =============================================================================
// Schema
// =============================================================================

const cancelSubscriptionSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
});

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler for subscription cancellation.
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createCancelSubscription() {
  return createSupabaseHandler(
    'cancel-subscription',
    cancelSubscriptionSchema,
    async (data, ctx) => {
      initStripe(getStripeKey());
      const authProvider = createSupabaseAuthProvider(ctx.supabaseAdmin);
      return cancelUserSubscription(data.userId, authProvider);
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
