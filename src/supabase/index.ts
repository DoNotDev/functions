// packages/functions/src/supabase/index.ts

/**
 * @fileoverview Supabase Edge Functions barrel exports
 * @description All Supabase Edge Function handlers for auth, billing, and OAuth.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

// Base
export { createSupabaseHandler } from './baseFunction.js';
export type { SupabaseHandlerContext } from './baseFunction.js';
export { createEdgeFunction } from './edgeFunction.js';
export type {
  EdgeFunctionContext,
  EdgeFunctionOptions,
} from './edgeFunction.js';

// Helpers
export { createSupabaseAuthProvider } from './helpers/authProvider.js';

// Auth
export { createDeleteAccount } from './auth/deleteAccount.js';
export type { DeleteAccountOptions } from './auth/deleteAccount.js';
export { createSetCustomClaims } from './auth/setCustomClaims.js';
export type { SetCustomClaimsOptions } from './auth/setCustomClaims.js';
export { createGetCustomClaims } from './auth/getCustomClaims.js';
export { createRemoveCustomClaims } from './auth/removeCustomClaims.js';
export { createGetUserAuthStatus } from './auth/getUserAuthStatus.js';

// Billing
export { createCheckoutSession } from './billing/createCheckoutSession.js';
export { createStripeWebhook } from './billing/stripeWebhook.js';
export {
  createSupabaseIdempotencyStore,
  WEBHOOK_EVENTS_SQL,
} from '../shared/billing/supabaseIdempotency.js';
export { ReservationLostError } from '../shared/billing/idempotencyContract.js';
export type {
  IdempotencyStore,
  ReservationResult,
} from '../shared/billing/idempotencyContract.js';
// Custom StripeOrder entry points (app request shape, own StripeSessionProvider)
export { createCheckoutAlgorithm } from '../shared/billing/createCheckout.js';
export type { StripeSessionProvider } from '../shared/billing/createCheckout.js';
export { STRIPE_API_VERSION_PIN } from '../shared/billing/apiVersion.js';
export { createCancelSubscription } from './billing/cancelSubscription.js';
export { createChangePlan } from './billing/changePlan.js';
export { createCustomerPortal } from './billing/createCustomerPortal.js';
export { createRefreshSubscriptionStatus } from './billing/refreshSubscriptionStatus.js';

// OAuth
export {
  createExchangeToken,
  createDisconnect,
  createRefreshToken,
  createGetConnections,
} from './oauth/index.js';

// AI
export { createAIFunction } from './ai/createAIFunction.js';
export { resolveModelForTier } from '../shared/ai/resolveModelTier.js';
export {
  classifyAIError,
  mapClassifiedToHTTP,
} from '../shared/ai/classifyAIError.js';
export type {
  AIErrorCode,
  ClassifiedAIError,
} from '../shared/ai/classifyAIError.js';

// Email
export { createEmailFunction } from './email/createEmailFunction.js';
// Server-side sending from app functions (webhooks, jobs): same templates and provider
export {
  handleEmailRequest,
  createResendProvider,
} from '../shared/email/index.js';
export type { EmailProviderAdapter } from '../shared/email/index.js';

// CRUD
export {
  createSupabaseGetEntity,
  createSupabaseCreateEntity,
  createSupabaseUpdateEntity,
  createSupabaseDeleteEntity,
  createSupabaseListEntities,
  createSupabaseAggregateEntities,
  createEntityStore,
} from './crud/index.js';
export { createSupabaseCrudFunctions } from './registerCrudFunctions.js';
export type {
  GetEntityRequest,
  CreateEntityRequest,
  UpdateEntityRequest,
  DeleteEntityRequest,
  ListEntityRequest,
  AggregateEntityRequest,
  ReferenceMetadata,
  EntityStore,
  EntityStoreCondition,
  EntityStoreOperator,
  EntityStoreQuery,
  EntityStoreValues,
} from './crud/index.js';

// Utils
export {
  checkIdempotency,
  storeIdempotency,
  cleanupExpiredIdempotency,
} from './utils/idempotency.js';
export {
  checkRateLimitWithPostgres,
  DEFAULT_RATE_LIMITS,
} from './utils/rateLimiter.js';
export type { RateLimitConfig, RateLimitResult } from './utils/rateLimiter.js';
export {
  recordOperationMetrics,
  getFailureRate,
  getOperationCounts,
  getSlowOperations,
} from './utils/monitoring.js';
export type { OperationMetrics } from './utils/monitoring.js';
