/**
 * Read-only StripeOrder verification for an authenticated return-page handler.
 * Persisted app binding is mandatory; Stripe metadata is corroboration, not authority.
 */
import type Stripe from 'stripe';

import {
  validateVerifyOrderCheckoutRequest,
  validateVerifyOrderCheckoutResult,
} from '@donotdev/core/server';
import type {
  StripeBackConfig,
  VerifyOrderCheckoutRequest,
  VerifyOrderCheckoutResult,
} from '@donotdev/core/server';

import { logger } from '../logger.js';
import { ORDER_ID_METADATA_KEY } from './orderWebhook.js';

/** App-owned persisted association, read from authoritative storage (never request metadata). */
export interface OrderCheckoutBinding {
  orderId: string;
  userId: string;
  sessionId: string;
  billingConfigKey: string;
}

/**
 * Read dependencies only. Separate from StripeSessionProvider so existing checkout
 * providers remain compatible. userId must come from verified handler context.
 */
export interface VerifyOrderCheckoutDependencies {
  userId: string;
  billingConfig: StripeBackConfig;
  /** Retrieve from Stripe using server credentials; no browser-supplied session objects. */
  retrieveStripeSession(sessionId: string): Promise<Pick<
    Stripe.Checkout.Session,
    'id' | 'mode' | 'status' | 'payment_status' | 'metadata'
  >>;
  /**
   * Read the persisted order/session binding, scoped to the authenticated owner
   * and config. Return absence if not authorized/found; never infer it from Stripe.
   * The algorithm independently checks every returned binding field.
   */
  resolveOrderBinding(
    request: VerifyOrderCheckoutRequest & { userId: string }
  ): Promise<OrderCheckoutBinding | null | undefined>;
}

/**
 * Verify an owner's StripeOrder session against server config and persisted binding.
 * All validation, authorization and dependency failures expose the same safe error.
 * Server diagnostics contain fixed stage/category labels only, never dependency
 * errors or request/customer data. Logging failure cannot replace the public error.
 * No writes, checkout hooks or fulfillment hooks run. A successful read reports
 * payment state only: complete/unpaid is pending; paid/no_payment_required does not
 * prove onOrderPaid has run. Existing webhook fulfillment remains authoritative.
 *
 * @example
 * ```typescript
 * // Inside createSupabaseHandler(..., v.unknown(), (data, ctx) => ...)
 * // The algorithm performs mandatory request validation itself.
 * return verifyOrderCheckoutAlgorithm(data, {
 *   userId: ctx.uid,
 *   billingConfig,
 *   retrieveStripeSession: (id) => stripe.checkout.sessions.retrieve(id),
 *   resolveOrderBinding, // app-owned authoritative, read-only resolver
 * });
 * ```
 */
export async function verifyOrderCheckoutAlgorithm(
  input: unknown,
  dependencies: VerifyOrderCheckoutDependencies
): Promise<VerifyOrderCheckoutResult> {
  let stage: 'validation' | 'auth' | 'config' | 'binding' | 'provider' | 'response' = 'validation';
  let category: 'invalid' | 'rejected' | 'unavailable' = 'invalid';
  try {
    const validation = validateVerifyOrderCheckoutRequest(input);
    if (!validation.success) throw new Error();
    const request = validation.output;
    const { userId, billingConfig } = dependencies;
    stage = 'auth';
    category = 'rejected';
    if (typeof userId !== 'string' || !userId.trim()) throw new Error();

    stage = 'config';
    category = 'invalid';
    if (
      !Object.hasOwn(billingConfig, request.billingConfigKey) ||
      billingConfig[request.billingConfigKey]?.type !== 'StripeOrder'
    ) throw new Error();

    stage = 'binding';
    category = 'unavailable';
    const binding = await dependencies.resolveOrderBinding({ ...request, userId });
    category = 'rejected';
    if (
      !binding ||
      binding.userId !== userId ||
      binding.sessionId !== request.sessionId ||
      binding.billingConfigKey !== request.billingConfigKey ||
      typeof binding.orderId !== 'string' || !binding.orderId.trim()
    ) throw new Error();

    stage = 'provider';
    category = 'unavailable';
    const session = await dependencies.retrieveStripeSession(request.sessionId);
    stage = 'response';
    category = 'rejected';
    if (
      session.id !== request.sessionId ||
      session.mode !== 'payment' ||
      session.metadata?.userId !== userId ||
      session.metadata?.billingConfigKey !== request.billingConfigKey ||
      session.metadata?.[ORDER_ID_METADATA_KEY] !== binding.orderId
    ) throw new Error();

    // Do not map the webhook snapshot: it includes buyer details and arbitrary
    // metadata and has no session status. Only these allowlisted fields leave here.
    category = 'invalid';
    const result = validateVerifyOrderCheckoutResult({
      sessionId: session.id,
      orderId: binding.orderId,
      billingConfigKey: request.billingConfigKey,
      sessionStatus: session.status,
      paymentStatus: session.payment_status,
    });
    if (!result.success) throw new Error();
    return result.output;
  } catch {
    try {
      // Only code-owned labels: never log the caught error, IDs or metadata.
      // Await also contains a rejected promise if the logging backend changes.
      await logger.warn('[Checkout verification] Failed', { stage, category });
    } catch {
      // Diagnostics must never change the fail-closed public contract.
    }
    // Same message/status through existing handler error mapping; no IDs, cause,
    // provider details or distinctions between missing and foreign bindings.
    throw new Error('Checkout verification denied');
  }
}
