// packages/functions/src/firebase/billing/index.ts

/**
 * @fileoverview Firebase billing functions barrel exports
 * @description Centralized exports for Firebase billing functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// Checkout session creation
export { createCheckoutSession } from './createCheckoutSession.js';

// Webhook handler
export { createStripeWebhook } from './webhookHandler.js';

// Firebase-specific implementations
// Note: updateUserSubscription is now handled via shared helpers

// Helpers (via shared)
export * from '../../shared/billing/helpers/index.js';

// Idempotency utilities (for advanced users)
export {
  createIdempotencyStore,
  resetIdempotencyStore,
} from '../../shared/billing/idempotency.js';

// Detection utilities
export {
  isFirestoreConfigured,
  isFirestoreAvailable,
} from '../../shared/utils/detectFirestore.js';

// Health check
export { billingHealth } from './healthCheck.js';

// Payment processing functions
export * from './refreshSubscriptionStatus.js';

// NEW: Add subscription management exports
export { cancelSubscription } from './cancelSubscription.js';
export { changePlan } from './changePlan.js';
export { createCustomerPortal } from './createCustomerPortal.js';
