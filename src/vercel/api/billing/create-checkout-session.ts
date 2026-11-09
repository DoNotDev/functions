// packages/functions/src/vercel/api/billing/create-checkout-session.ts

/**
 * @fileoverview Create checkout session API handler
 * @description Vercel API route for creating Stripe checkout sessions.
 * Delegates to the shared createCheckoutAlgorithm (SSOT).
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
} from '@donotdev/core/server';

import { resolveBillingBackend } from './backend.js';
import type { VercelBillingOptions } from './backend.js';
import { createCheckoutAlgorithm } from '../../../shared/billing/createCheckout.js';
import type { StripeSessionProvider } from '../../../shared/billing/createCheckout.js';
import {
  initStripe,
  stripe,
  validateStripeEnvironment,
} from '../../../shared/utils.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

/**
 * Business logic for creating checkout sessions
 * Base function handles: validation, auth, rate limiting, monitoring
 */
async function createCheckoutSessionLogic(
  res: NextApiResponse,
  data: CreateCheckoutSessionRequest,
  context: { uid: string },
  billingConfig: StripeBackConfig,
  options: VercelBillingOptions
) {
  initStripe(process.env.STRIPE_SECRET_KEY || '');
  validateStripeEnvironment();

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

  const { authProvider } = await resolveBillingBackend(options.backend);

  // userId comes from the verified token, never from the client
  const result = await createCheckoutAlgorithm(
    data,
    context.uid,
    stripeProvider,
    authProvider,
    billingConfig
  );

  return res.status(200).json(result);
}

/**
 * Vercel API handler for creating checkout sessions
 *
 * @example
 * ```typescript
 * // api/billing/create-checkout-session.ts
 * import { createCheckoutSession } from '@donotdev/functions/vercel';
 * import { billingConfig } from '../../config/billing';
 *
 * export default createCheckoutSession(billingConfig, { backend: 'supabase' });
 * ```
 *
 * @param billingConfig - App back config
 * @param options - Backend of the app (token verification, rate limiting, user lookup)
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createCheckoutSession(
  billingConfig: StripeBackConfig,
  options: VercelBillingOptions
) {
  return createVercelBaseFunction(
    'POST',
    CreateCheckoutSessionRequestSchema,
    'create_checkout_session',
    (_req: NextApiRequest, res, data, context) =>
      createCheckoutSessionLogic(res, data, context, billingConfig, options),
    undefined,
    options.backend
  );
}
