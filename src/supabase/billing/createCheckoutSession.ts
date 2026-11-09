// packages/functions/src/supabase/billing/createCheckoutSession.ts

/**
 * @fileoverview Create Checkout Session — Supabase Edge Function
 * @description Wraps the shared `createCheckoutAlgorithm` for Supabase.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import type { StripeBackConfig } from '@donotdev/core/server';
import type { CreateCheckoutSessionRequest } from '@donotdev/core/server';

import { createCheckoutAlgorithm } from '../../shared/billing/createCheckout.js';
import type { StripeSessionProvider } from '../../shared/billing/createCheckout.js';
import {
  initStripe,
  stripe,
  validateStripeEnvironment,
} from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { createSupabaseAuthProvider } from '../helpers/authProvider.js';

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler for Stripe checkout session creation.
 *
 * @param billingConfig - Billing configuration with product definitions
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createCheckoutSession(billingConfig: StripeBackConfig) {
  return createSupabaseHandler(
    'create-checkout-session',
    CreateCheckoutSessionRequestSchema,
    async (data: CreateCheckoutSessionRequest, ctx) => {
      initStripe(getStripeKey());
      validateStripeEnvironment();

      const authProvider = createSupabaseAuthProvider(ctx.supabaseAdmin);

      const stripeProvider: StripeSessionProvider = {
        async createStripeSession(params) {
          const session = await stripe.checkout.sessions.create(params);
          return { id: session.id, url: session.url };
        },
        async retrieveTaxRate(id) {
          const rate = await stripe.taxRates.retrieve(id);
          return { id: rate.id, inclusive: rate.inclusive };
        },
      };

      // userId comes from the verified JWT, never from the client
      return createCheckoutAlgorithm(
        data,
        ctx.uid,
        stripeProvider,
        authProvider,
        billingConfig
      );
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
