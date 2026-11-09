// packages/functions/src/shared/billing/webhookHandler.ts

/**
 * @fileoverview Stripe webhook handler
 * @description Verifies, deduplicates and routes Stripe webhook events for
 * one-time payments, subscriptions (`tierWebhookEvents.ts`) and multi-line
 * orders (`orderWebhook.ts`).
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import { DoNotDevError, validateStripeBackConfig } from '@donotdev/core/server';
import type { BillingAuthProvider, StripeBackConfig, UpdateSubscriptionFn } from '@donotdev/core/server';

import { handleError } from '../errorHandling.js';
import { logger } from '../logger.js';
import { ReservationLostError } from './idempotencyContract.js';
import type { IdempotencyStore } from './idempotencyContract.js';
import { handleOrderSessionEvent } from './orderWebhook.js';
import type { OrderSessionEventType } from './orderWebhook.js';
import {
  handleInvoicePaymentSucceeded,
  handlePaymentFailed,
  handleSubscriptionDeleted,
  handleTierCheckoutEvent,
} from './tierWebhookEvents.js';

/** Attempts to record a processed event before answering non-2xx. */
const MARK_PROCESSED_ATTEMPTS = 3;

/** Backoff between markProcessed attempts (multiplied by the attempt number). */
const MARK_PROCESSED_BACKOFF_MS = 200;

/**
 * Verify, deduplicate and route one Stripe webhook event.
 *
 * Idempotency (at-least-once): the event is reserved before routing.
 * - Already processed → resolves "Event already processed" (answer 2xx).
 * - Another delivery holds a live lease → throws `unavailable` (answer non-2xx,
 *   Stripe retries later; an abandoned lease is retaken after it expires).
 * - Routing throws → the reservation is released and the error rethrown, so
 *   Stripe's retry is processed.
 * - Routing succeeds → the event is marked processed, retried a bounded number
 *   of times; if it still fails the error is rethrown WITHOUT releasing, so the
 *   event is re-run after the lease. Hooks must therefore be idempotent.
 *
 * @param rawBody - Raw request body
 * @param signature - Stripe signature
 * @param webhookSecret - Stripe webhook secret
 * @param stripe - Stripe instance
 * @param billingConfig - Billing configuration
 * @param updateSubscription - Function to update user subscription
 * @param authProvider - Auth provider for subscription claims (null: subscription events fail)
 * @param idempotencyStore - Durable store matching the backend
 *   (`createFirestoreIdempotencyStore` / `createSupabaseIdempotencyStore`). Required:
 *   shared logic never picks a backend.
 * @throws Any failure: the caller must answer non-2xx so Stripe retries
 *
 * @version 0.2.1
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function processWebhook(
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
  stripe: Stripe,
  billingConfig: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  authProvider: BillingAuthProvider | null,
  idempotencyStore: IdempotencyStore
): Promise<{ success: boolean; message: string }> {
  try {
    // Validate data fields only. Valibot strips unknown keys (the hooks) from its
    // output, so routing must use the original config object, never the parse result.
    validateStripeBackConfig(billingConfig);
    const config = billingConfig;

    // Verify webhook signature
    // Async variant: works on Node and on Web Crypto runtimes (Deno, Workers)
    const event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret
    );

    logger.info('[Webhook] Processing event', {
      eventType: event.type,
      eventId: event.id,
      operation: 'webhook_processing',
    });

    const reservation = await idempotencyStore.reserve(event.id);
    if (reservation.state === 'processed') {
      logger.info('[Webhook] Already processed', { eventId: event.id });
      return { success: true, message: 'Event already processed' };
    }
    if (reservation.state === 'in_progress') {
      logger.warn('[Webhook] Event in progress in another delivery', {
        eventId: event.id,
        eventType: event.type,
        operation: 'webhook_in_progress',
      });
      throw new DoNotDevError(
        `Stripe event ${event.id} is being processed by another delivery; answering non-2xx so Stripe retries it`,
        'unavailable',
        { details: { eventId: event.id, reason: 'webhook_event_in_progress' } }
      );
    }
    const { ownerToken } = reservation;

    // G59: Warn when authProvider is null — subscription update events will fail
    if (!authProvider) {
      logger.warn(
        '[Webhook] authProvider is null — subscription-related events will fail',
        {
          eventType: event.type,
          eventId: event.id,
        }
      );
    }

    // Route to handler. On failure, release the reservation so the retry runs.
    try {
      await routeEvent(event, config, updateSubscription, stripe, authProvider);
    } catch (routingError) {
      logger.error('[Webhook] Event processing failed, releasing reservation', {
        error:
          routingError instanceof Error
            ? routingError
            : new Error(String(routingError)),
        eventId: event.id,
        eventType: event.type,
        operation: 'webhook_routing',
      });
      await releaseReservation(idempotencyStore, event.id, ownerToken);
      throw routingError;
    }

    await markProcessedWithRetry(idempotencyStore, event.id, ownerToken);
    return { success: true, message: 'Webhook processed' };
  } catch (error) {
    throw handleError(error);
  }
}

/** Release after a routing failure. Never masks the routing error. */
async function releaseReservation(
  store: IdempotencyStore,
  eventId: string,
  ownerToken: string
): Promise<void> {
  try {
    if (!(await store.release(eventId, ownerToken))) {
      logger.warn('[Webhook] Reservation not released: no longer owned', {
        eventId,
        operation: 'idempotency_release_stale',
      });
    }
  } catch (releaseError) {
    logger.error('[Webhook] Failed to release idempotency reservation', {
      error:
        releaseError instanceof Error
          ? releaseError
          : new Error(String(releaseError)),
      eventId,
      operation: 'idempotency_release',
    });
  }
}

/**
 * Record a processed event. Transient store errors are retried; a lost
 * reservation is not (another delivery owns the event). The final error is
 * rethrown without releasing: Stripe retries after the lease and the event is
 * processed again (at-least-once).
 */
async function markProcessedWithRetry(
  store: IdempotencyStore,
  eventId: string,
  ownerToken: string
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.markProcessed(eventId, ownerToken);
      return;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (error instanceof ReservationLostError) {
        logger.error(
          '[Webhook] Event processed but its reservation was retaken by another delivery; hooks may run twice',
          { error: err, eventId, operation: 'idempotency_mark_processed_lost' }
        );
        throw error;
      }
      if (attempt >= MARK_PROCESSED_ATTEMPTS) {
        logger.error(
          '[Webhook] Event processed but not recorded; answering non-2xx, Stripe will redeliver after the lease and hooks re-run',
          {
            error: err,
            eventId,
            attempts: attempt,
            operation: 'idempotency_mark_processed_failed',
          }
        );
        throw error;
      }
      logger.warn('[Webhook] markProcessed failed, retrying', {
        eventId,
        attempt,
        error: err.message,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, MARK_PROCESSED_BACKOFF_MS * attempt)
      );
    }
  }
}

/**
 * Route events to appropriate handlers
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function routeEvent(
  event: Stripe.Event,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  stripe: Stripe,
  authProvider: BillingAuthProvider | null
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      await handleCheckoutSessionEvent(
        event.type,
        event.id,
        event.api_version,
        event.data.object,
        config,
        updateSubscription,
        stripe,
        authProvider
      );
      break;

    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(
        event.data.object as Stripe.Invoice,
        config,
        updateSubscription,
        stripe,
        authProvider
      );
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        config,
        updateSubscription,
        authProvider
      );
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.Invoice, config);
      break;

    default:
      // W23: Use structured logger instead of console.log in production
      logger.debug('[Webhook] Unhandled event type', { type: event.type });
  }
}

/**
 * Route Checkout Session events: StripeOrder items go to the order hooks,
 * StripePayment / StripeSubscription items to the tier handlers.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
async function handleCheckoutSessionEvent(
  eventType: OrderSessionEventType,
  eventId: string,
  apiVersion: string | null,
  session: Stripe.Checkout.Session,
  config: StripeBackConfig,
  updateSubscription: UpdateSubscriptionFn,
  stripe: Stripe,
  authProvider: BillingAuthProvider | null
): Promise<void> {
  const billingConfigKey = session.metadata?.billingConfigKey;
  const billingItem = billingConfigKey ? config[billingConfigKey] : undefined;

  if (billingConfigKey && billingItem?.type === 'StripeOrder') {
    await handleOrderSessionEvent(
      eventType,
      eventId,
      apiVersion,
      session,
      billingConfigKey,
      billingItem,
      stripe
    );
    return;
  }

  await handleTierCheckoutEvent(
    eventType,
    session,
    config,
    updateSubscription,
    authProvider
  );
}
