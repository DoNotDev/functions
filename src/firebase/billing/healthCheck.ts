// packages/functions/src/firebase/billing/healthCheck.ts

/**
 * @fileoverview Billing Health Check
 * @description Comprehensive health check for billing system
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onRequest } from 'firebase-functions/v2/https';

import { isFirestoreConfigured } from '../../shared/utils/detectFirestore.js';
import { stripe } from '../../shared/utils.js';
import { STRIPE_CONFIG } from '../config/constants.js';

/**
 * Comprehensive health check for billing system
 * GET /billingHealth
 */
export const billingHealth = onRequest(STRIPE_CONFIG, async (req, res) => {
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Check Stripe connection
  try {
    await stripe.products.list({ limit: 1 });
  } catch {
    overallStatus = 'unhealthy';
  }

  // Check idempotency storage
  if (!isFirestoreConfigured()) {
    overallStatus = overallStatus === 'healthy' ? 'degraded' : overallStatus;
  }

  // Check environment variables (don't expose which ones)
  const requiredEnvVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_API_VERSION',
  ];
  if (requiredEnvVars.some((v) => !process.env[v])) {
    overallStatus = 'unhealthy';
  }

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json({
    status: overallStatus,
    timestamp: Date.now(),
  });
});
