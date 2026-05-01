// packages/functions/src/firebase/billing/createCustomerPortal.ts

/**
 * @fileoverview Create Customer Portal Function
 * @description Generates Stripe Customer Portal URL for payment method management
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../shared/errorHandling.js';
import {
  stripe,
  validateStripeEnvironment,
  initStripe,
} from '../../shared/utils.js'; // ✅ IMPORT INIT
import { createBaseFunction } from '../baseFunction.js';
import { STRIPE_CONFIG } from '../config/constants.js';
import { stripeSecretKey } from '../config/secrets.js'; // ✅ IMPORT SECRET

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

const customerPortalSchema = v.object({
  userId: v.string(),
  returnUrl: v.optional(v.pipe(v.string(), v.url())),
});

type CustomerPortalRequest = v.InferOutput<typeof customerPortalSchema>;

async function createCustomerPortalLogic(
  data: CustomerPortalRequest,
  context: { uid: string; request: CallableRequest<CustomerPortalRequest> }
) {
  // ✅ LATEST BEST PRACTICE: Init with secret value
  initStripe(stripeSecretKey.value());

  try {
    validateStripeEnvironment();
  } catch (error) {
    throw handleError(error);
  }

  // C8: Ignore client-supplied userId — always use the verified uid from the
  // auth context to prevent IDOR (any authenticated user opening another
  // user's billing portal).
  const userId = context.uid;
  const { returnUrl } = data;

  // Get customer ID from user claims
  const user = await getFirebaseAdminAuth().getUser(userId);
  // ... (rest of logic)
  const currentClaims = (user.customClaims || {}) as any;
  const customerId =
    currentClaims.subscription?.customerId ||
    user.customClaims?.stripeCustomerId;

  if (!customerId) {
    throw handleError(new Error('No Stripe customer ID found for user'));
  }

  // C8: Removed hardcoded 'https://donotdev.com/dashboard' fallback.
  // Use caller-supplied returnUrl or derive from FRONTEND_URL env var.
  const resolvedReturnUrl =
    returnUrl ??
    (process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/dashboard`
      : undefined);

  if (!resolvedReturnUrl) {
    throw handleError(
      new Error('returnUrl is required (or set FRONTEND_URL env var)')
    );
  }

  // Create portal session
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: resolvedReturnUrl,
  });

  return {
    url: session.url,
  };
}

export function createCustomerPortal(): CallableFunction<
  CustomerPortalRequest,
  Promise<{ url: string }>
> {
  return createBaseFunction<CustomerPortalRequest, { url: string }>(
    STRIPE_CONFIG,
    customerPortalSchema,
    'create_customer_portal',
    createCustomerPortalLogic
  );
}
