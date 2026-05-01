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

      const stripeProvider = {
        async createCheckoutSession(params: {
          priceId?: string;
          unitAmount?: number;
          productName?: string;
          currency?: string;
          customerEmail?: string;
          metadata: Record<string, string>;
          allowPromotionCodes: boolean;
          successUrl: string;
          cancelUrl: string;
          mode?: 'payment' | 'subscription';
        }) {
          const session = await stripe.checkout.sessions.create({
            mode: params.mode || 'payment',
            line_items: [
              params.priceId
                ? { price: params.priceId, quantity: 1 }
                : {
                    price_data: {
                      currency: params.currency || 'eur',
                      unit_amount: params.unitAmount!,
                      product_data: { name: params.productName! },
                    },
                    quantity: 1,
                  },
            ],
            customer_email: params.customerEmail || undefined,
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            allow_promotion_codes: params.allowPromotionCodes,
            metadata: params.metadata,
            ...(params.mode === 'subscription' && {
              subscription_data: { metadata: params.metadata },
            }),
          });
          return { id: session.id, url: session.url };
        },
      };

      return createCheckoutAlgorithm(
        data,
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
