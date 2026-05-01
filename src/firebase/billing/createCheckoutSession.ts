// packages/functions/src/firebase/billing/createCheckoutSession.ts

/**
 * @fileoverview Create checkout session Firebase function
 * @description Firebase callable function for creating Stripe checkout sessions.
 * Delegates to shared createCheckoutAlgorithm (SSOT).
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
} from '@donotdev/core/server';
import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { createCheckoutAlgorithm } from '../../shared/billing/createCheckout.js';
import {
  initStripe,
  stripe,
  validateStripeEnvironment,
} from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { STRIPE_CONFIG } from '../config/constants.js';
import { stripeSecretKey } from '../config/secrets.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

/**
 * Business logic for creating Stripe checkout session.
 * Uses shared algorithm - same as Supabase and Vercel handlers.
 */
async function createCheckoutSessionLogic(
  data: CreateCheckoutSessionRequest,
  context: {
    uid: string;
    request: CallableRequest<CreateCheckoutSessionRequest>;
  },
  billingConfig: StripeBackConfig
) {
  // Initialize Stripe with Firebase secret
  initStripe(stripeSecretKey.value());
  validateStripeEnvironment();

  // Create Stripe provider
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
        mode: params.mode || 'payment',
        allow_promotion_codes: params.allowPromotionCodes,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        customer_email: params.customerEmail,
        metadata: {
          ...params.metadata,
          firebaseUid: params.metadata.userId || '',
        },
        ...(params.mode === 'subscription' && {
          subscription_data: {
            metadata: {
              ...params.metadata,
              firebaseUid: params.metadata.userId || '',
            },
          },
        }),
      });
      return { id: session.id, url: session.url };
    },
  };

  // Create auth provider
  const authProvider = {
    async getUser(userId: string) {
      const user = await getFirebaseAdminAuth().getUser(userId);
      return { customClaims: user.customClaims };
    },
  };

  // Inject userId from authenticated context (not from client)
  const requestWithUserId = {
    ...data,
    userId: context.uid,
  };

  // Delegate to shared algorithm (SSOT)
  return createCheckoutAlgorithm(
    requestWithUserId,
    stripeProvider,
    authProvider,
    billingConfig
  );
}

/**
 * Create Firebase function for checkout session creation
 */
export function createCheckoutSession(
  billingConfig: StripeBackConfig
): CallableFunction<
  CreateCheckoutSessionRequest,
  Promise<{ sessionId: string; sessionUrl: string | null }>
> {
  return createBaseFunction<
    CreateCheckoutSessionRequest,
    { sessionId: string; sessionUrl: string | null }
  >(
    STRIPE_CONFIG,
    CreateCheckoutSessionRequestSchema,
    'create_checkout_session',
    (data, context) => createCheckoutSessionLogic(data, context, billingConfig)
  );
}
