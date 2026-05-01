// packages/functions/src/vercel/api/billing/customer-portal.ts

/**
 * @fileoverview Vercel Customer Portal Handler
 * @description Next.js API route wrapper for createCustomerPortal
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import { stripe, validateStripeEnvironment } from '../../../shared/utils.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';

const customerPortalSchema = v.object({
  userId: v.string(),
  returnUrl: v.optional(v.pipe(v.string(), v.url())),
});

async function createCustomerPortalLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: { userId: string; returnUrl?: string },
  context: { uid: string }
) {
  validateStripeEnvironment();

  // W6: Ignore client-supplied userId — use the verified uid from auth context
  // to prevent IDOR (any authenticated user opening any user's billing portal).
  const userId = context.uid;
  const { returnUrl } = data;

  // Get customer ID
  const user = await getFirebaseAdminAuth().getUser(userId);
  const customerId = user.customClaims?.subscription?.customerId;

  if (!customerId) {
    throw handleError(new Error('No customer found'));
  }

  // Create portal session
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || `${process.env.FRONTEND_URL}/billing`,
  });

  return res.status(200).json({ url: session.url });
}

const createCustomerPortal = () => {
  return createVercelBaseFunction(
    'POST',
    customerPortalSchema,
    'create_customer_portal',
    createCustomerPortalLogic
  );
};

export default createCustomerPortal;
