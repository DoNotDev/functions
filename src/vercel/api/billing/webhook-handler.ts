// packages/functions/src/vercel/api/billing/webhook-handler.ts

/**
 * @fileoverview Stripe webhook handler API
 * @description Vercel API route for handling Stripe webhook events
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';

import type { StripeBackConfig } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { updateUserSubscription } from '../../../shared/billing/helpers/updateUserSubscription.js';
import { processWebhook } from '../../../shared/billing/webhookHandler.js';
import { stripe } from '../../../shared/utils.js';

import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Create Vercel webhook handler from billing config
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createStripeWebhook(billingConfig: StripeBackConfig) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const sig = req.headers['stripe-signature'];
      if (!sig || Array.isArray(sig)) {
        throw new Error('No Stripe signature found');
      }

      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        throw new Error('STRIPE_WEBHOOK_SECRET not configured');
      }

      // Content-Length pre-check before streaming body
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        res.status(413).json({ error: 'Payload too large' });
        return;
      }

      // Get raw body
      const rawBody = await getRawBody(req);

      // C5: Build a proper authProvider so subscription webhook events can activate.
      // null was previously passed which caused processWebhook to throw on every
      // checkout.session.completed / invoice.payment_succeeded event.
      const authProvider = {
        async getUser(userId: string) {
          return getFirebaseAdminAuth().getUser(userId);
        },
        async setCustomUserClaims(
          userId: string,
          claims: Record<string, unknown>
        ) {
          await getFirebaseAdminAuth().setCustomUserClaims(userId, claims);
        },
      };

      // Call shared algorithm
      await processWebhook(
        rawBody,
        sig,
        webhookSecret,
        stripe,
        billingConfig,
        updateUserSubscription,
        authProvider
      );

      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('Vercel webhook error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        error: 'Webhook processing failed',
      });
    }
  };
}

// W9: Cap raw-body reads at 1 MiB to prevent memory-exhaustion DoS.
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

async function getRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf =
      typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks as readonly Uint8Array[]);
}

/**
 * Next.js API route configuration
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const config = {
  api: { bodyParser: false },
};
