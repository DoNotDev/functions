// packages/functions/src/firebase/billing/webhookHandler.ts

/**
 * @fileoverview Stripe webhook handler Firebase function
 * @description Firebase HTTP function for handling Stripe webhook events
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';

import type { StripeBackConfig } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { updateUserSubscription } from '../../shared/billing/helpers/updateUserSubscription.js';
import { processWebhook } from '../../shared/billing/webhookHandler.js';
import { handleError } from '../../shared/errorHandling.js';
import {
  stripe,
  validateStripeEnvironment,
  initStripe,
} from '../../shared/utils.js'; // ✅ IMPORT INIT
import { STRIPE_CONFIG } from '../config/constants.js';
import { stripeSecretKey, stripeWebhookSecret } from '../config/secrets.js'; // ✅ IMPORT SECRETS

import type { HttpsFunction } from 'firebase-functions/v2/https';

/**
 * Read raw body from request stream
 */
async function getRawBody(req: any): Promise<Buffer> {
  // If rawBody is already available, use it
  if ((req as any).rawBody && Buffer.isBuffer((req as any).rawBody)) {
    return (req as any).rawBody;
  }

  // Otherwise, read from stream
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    );
  }
  return Buffer.concat(chunks);
}

/**
 * Create Firebase webhook handler from billing config
 */
export function createStripeWebhook(
  billingConfig: StripeBackConfig
): HttpsFunction {
  return onRequest(STRIPE_CONFIG, async (req, res) => {
    // ✅ LATEST BEST PRACTICE: Init with secret value
    initStripe(stripeSecretKey.value());

    try {
      // validateStripeEnvironment(); // initStripe handles this now

      const sig = req.headers['stripe-signature'];
      if (!sig || Array.isArray(sig)) {
        const error = new Error('No Stripe signature found');
        logger.error('[Webhook] Missing signature', {
          error,
          operation: 'webhook_signature_validation',
        });
        throw handleError(error);
      }

      // ✅ LATEST BEST PRACTICE: Use defineSecret value
      const webhookSecret = stripeWebhookSecret.value();

      if (!webhookSecret) {
        const error = new Error('STRIPE_WEBHOOK_SECRET not configured');
        logger.error('[Webhook] Missing webhook secret', {
          error,
          operation: 'webhook_configuration',
        });
        throw handleError(error);
      }

      // Get raw body - read from request stream
      // Firebase Functions v2 doesn't automatically provide req.rawBody
      const rawBody = await getRawBody(req);

      if (!rawBody || rawBody.length === 0) {
        const error = new Error('Missing or empty request body');
        logger.error('[Webhook] Invalid body', {
          error,
          operation: 'webhook_raw_body',
        });
        throw handleError(error);
      }

      // C11: Build a proper authProvider so subscription webhook events can
      // update custom claims (same pattern as the Vercel webhook handler).
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
      const result = await processWebhook(
        rawBody,
        sig,
        webhookSecret,
        stripe,
        billingConfig,
        updateUserSubscription,
        authProvider
      );

      logger.info('[Firebase Webhook] Success', result);
      res.status(200).json({ received: true });
    } catch (error) {
      logger.error('[Firebase Webhook] Error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw handleError(error);
    }
  });
}
