// packages/functions/src/firebase/billing/createCheckoutSession.ts

/**
 * @fileoverview Create checkout session Firebase function
 * @description Firebase callable function for creating Stripe checkout sessions.
 * Delegates to shared createCheckoutAlgorithm (SSOT).
 *
 * @version 0.3.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';
import type Stripe from 'stripe';

import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
} from '@donotdev/core/server';
import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { assertCheckoutSessionMetadata } from '../../shared/billing/checkoutValidation.js';
import { createCheckoutAlgorithm } from '../../shared/billing/createCheckout.js';
import type { StripeSessionProvider } from '../../shared/billing/createCheckout.js';
import {
  initStripe,
  stripe,
  validateStripeEnvironment,
} from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { STRIPE_CONFIG } from '../config/constants.js';
import { stripeSecretKey } from '../config/secrets.js';

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

  const stripeProvider: StripeSessionProvider = {
    async createStripeSession(params) {
      // 0.1.x Firebase sessions carry firebaseUid alongside userId
      /** @grill-refuted Firebase-only by design (0.1.x parity); nothing reads firebaseUid, userId is the cross-provider key. */
      const firebaseUid = context.uid;
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        ...params,
        metadata: { ...params.metadata, firebaseUid },
        ...(params.subscription_data && {
          subscription_data: {
            ...params.subscription_data,
            metadata: { ...params.subscription_data.metadata, firebaseUid },
          },
        }),
      };
      assertCheckoutSessionMetadata(sessionParams);
      const session = await stripe.checkout.sessions.create(sessionParams);
      return { id: session.id, url: session.url };
    },
    async retrieveTaxRate(id) {
      const rate = await stripe.taxRates.retrieve(id);
      return { id: rate.id, inclusive: rate.inclusive };
    },
  };

  // Create auth provider
  const authProvider = {
    async getUser(userId: string) {
      const user = await getFirebaseAdminAuth().getUser(userId);
      return { customClaims: user.customClaims };
    },
  };

  // userId comes from the authenticated context, never from the client
  return createCheckoutAlgorithm(
    data,
    context.uid,
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
