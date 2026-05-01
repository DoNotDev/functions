// packages/functions/src/firebase/billing/index.d.ts

/**
 * @fileoverview Firebase Billing Functions
 * @description Type definitions for Firebase Cloud Functions related to billing, payment processing, and subscription management.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Creates a Stripe checkout session
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { createCheckoutSession } from './createCheckoutSession.js';

/**
 * Handles Stripe webhook events
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { createStripeWebhook } from './webhookHandler.js';

/**
 * Billing helper functions (via shared)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from '../../shared/billing/helpers/index.js';

/**
 * Idempotency utilities for advanced users
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export {
  createIdempotencyStore,
  resetIdempotencyStore,
} from '../../shared/billing/idempotency.js';

/**
 * Firestore detection utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export {
  isFirestoreConfigured,
  isFirestoreAvailable,
} from '../../shared/utils/detectFirestore.js';

/**
 * Billing health check function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { billingHealth } from './healthCheck.js';

/**
 * Payment processing functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './refreshSubscriptionStatus.js';

/**
 * Cancels a subscription
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { cancelSubscription } from './cancelSubscription.js';

/**
 * Changes a subscription plan
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { changePlan } from './changePlan.js';

/**
 * Creates a Stripe customer portal session
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { createCustomerPortal } from './createCustomerPortal.js';
