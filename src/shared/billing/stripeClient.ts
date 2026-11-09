// packages/functions/src/shared/billing/stripeClient.ts

/**
 * @fileoverview Stripe client for billing functions
 * @description Lazily initialized Stripe SDK instance shared by the Firebase,
 * Vercel and Supabase billing handlers. Kept apart from `shared/utils.ts` so
 * code that does not bill (CRUD, auth) never loads the Stripe SDK.
 *
 * @version 0.2.1
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import Stripe from 'stripe';

import { STRIPE_API_VERSION_PIN } from './apiVersion.js';

// Lazy initialization of Stripe
let _stripe: Stripe | null = null;

/**
 * Initialize Stripe explicitly (e.g. with a secret from defineSecret).
 * API version: `STRIPE_API_VERSION`, else {@link STRIPE_API_VERSION_PIN}.
 * @param apiKey - Stripe secret key
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function initStripe(apiKey: string) {
  if (!apiKey) throw new Error('Stripe API key is required');

  // Unset: the framework pin (pre-basil fields are still read by subscription handlers)
  const apiVersion = process.env.STRIPE_API_VERSION || STRIPE_API_VERSION_PIN;

  _stripe = new Stripe(apiKey, {
    apiVersion: apiVersion as any,
  });
  return _stripe;
}

/**
 * Get Stripe instance with lazy initialization
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    // Legacy/Vercel fallback: Try process.env
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (STRIPE_SECRET_KEY) {
      initStripe(STRIPE_SECRET_KEY);
    } else {
      throw new Error(
        'Stripe not initialized. Call initStripe() or set STRIPE_SECRET_KEY env var.'
      );
    }
  }
  // We know _stripe is set here or we threw
  return _stripe!;
}

/**
 * Lazy-initialized Stripe instance proxy
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const stripe = new Proxy({} as Stripe, {
  get(target, prop) {
    return getStripe()[prop as keyof Stripe];
  },
});

/**
 * Validates that required Stripe environment variables are set
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateStripeEnvironment(): void {
  // Functions v2 automatically injects secrets as process.env when declared in config
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY environment variable');
  }
}
