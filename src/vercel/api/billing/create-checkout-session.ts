// packages/functions/src/vercel/api/billing/create-checkout-session.ts

/**
 * @fileoverview Create checkout session API handler
 * @description Vercel API route for creating Stripe checkout sessions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
} from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { createCheckoutAlgorithm } from '../../../shared/billing/createCheckout.js';
import {
  initStripe,
  stripe,
  validateStripeEnvironment,
} from '../../../shared/utils.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';
import type * as v from 'valibot';

/**
 * Business logic for creating checkout sessions
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function createCheckoutSessionLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: CreateCheckoutSessionRequest,
  context: { uid: string },
  billingConfig: StripeBackConfig
) {
  // Initialize Stripe with env var
  initStripe(process.env.STRIPE_SECRET_KEY || '');
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
        payment_method_types: ['card'],
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
        metadata: params.metadata,
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

  // Use shared algorithm
  const result = await createCheckoutAlgorithm(
    data,
    stripeProvider,
    authProvider,
    billingConfig
  );

  return res.status(200).json(result);
}

/**
 * Vercel API handler for creating checkout sessions
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
const createCheckoutSession = (
  billingConfig: StripeBackConfig,
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) => {
  const schema = customSchema || CreateCheckoutSessionRequestSchema;
  return createVercelBaseFunction(
    'POST',
    schema,
    'create_checkout_session',
    (req, res, data, context) =>
      createCheckoutSessionLogic(req, res, data, context, billingConfig)
  );
};

export default createCheckoutSession;
