// packages/functions/src/shared/billing/orderWebhook.ts

/**
 * @fileoverview StripeOrder webhook handling
 * @description Maps Checkout Session events of one-time, multi-line orders to the
 * app's order hooks (`onOrderPaid`, `onOrderPaymentFailed`, `onOrderExpired`), and
 * `customer.tax_id.updated` to `onTaxIdUpdated`.
 * Hook errors propagate: the webhook answers non-2xx and Stripe retries.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import type {
  CheckoutAddress,
  CheckoutSessionSnapshot,
  OrderHookContext,
  PaidLineItem,
  StripeBackConfig,
  StripeOrderBackItem,
  TaxIdSnapshot,
} from '@donotdev/core/server';

import { logger } from '../logger.js';
import { STRIPE_API_VERSION_PIN } from './apiVersion.js';

/**
 * Checkout Session events that concern orders.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export type OrderSessionEventType =
  | 'checkout.session.completed'
  | 'checkout.session.async_payment_succeeded'
  | 'checkout.session.async_payment_failed'
  | 'checkout.session.expired';

/**
 * Oldest Stripe API version whose Checkout Session payload StripeOrder can read
 * (`collected_information` was added in 2025-02-24.acacia). Alias of
 * {@link STRIPE_API_VERSION_PIN}.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const MIN_ORDER_API_VERSION = STRIPE_API_VERSION_PIN;

/** Metadata key carrying the app order ID on the Checkout Session. */
export const ORDER_ID_METADATA_KEY = 'orderId';

/** Product metadata key carrying the app product ID on each line. */
export const PRODUCT_ID_METADATA_KEY = 'productId';

function idOf(value: string | { id: string } | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : value.id;
}

type StripeAddressFields = Pick<
  Stripe.Address,
  'line1' | 'line2' | 'postal_code' | 'city' | 'state' | 'country'
>;

function toAddress(address: StripeAddressFields): CheckoutAddress {
  return {
    line1: address.line1,
    line2: address.line2,
    postalCode: address.postal_code,
    city: address.city,
    state: address.state,
    country: address.country,
  };
}

/**
 * Map a Stripe Checkout Session to the provider-neutral snapshot given to order hooks.
 *
 * @param session - Checkout Session from a webhook event
 * @returns Snapshot (amounts in the smallest currency unit)
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function toCheckoutSessionSnapshot(
  session: Stripe.Checkout.Session
): CheckoutSessionSnapshot {
  const details = session.customer_details;
  const shipping = session.collected_information?.shipping_details ?? null;
  return {
    id: session.id,
    paymentStatus: session.payment_status,
    currency: session.currency,
    amountSubtotal: session.amount_subtotal,
    amountTax: session.total_details?.amount_tax ?? null,
    amountShipping: session.total_details?.amount_shipping ?? null,
    amountDiscount: session.total_details?.amount_discount ?? null,
    amountTotal: session.amount_total,
    customerId: idOf(session.customer),
    customer: details
      ? {
          email: details.email,
          name: details.name,
          phone: details.phone,
          businessName: details.business_name,
          address: details.address ? toAddress(details.address) : null,
          taxIds: (details.tax_ids ?? []).map((taxId) => ({
            type: taxId.type,
            value: taxId.value,
          })),
          taxExempt: details.tax_exempt,
        }
      : null,
    shipping: shipping
      ? { name: shipping.name, address: toAddress(shipping.address) }
      : null,
    invoiceId: idOf(session.invoice),
    paymentIntentId: idOf(session.payment_intent),
    metadata: session.metadata ?? {},
  };
}

/**
 * Read the charged lines of a session back from Stripe.
 *
 * @param stripe - Stripe client
 * @param sessionId - Checkout Session ID
 * @returns Lines with the app product ID and charged amounts
 * @throws When a line carries no app product ID (not created by the framework)
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export async function listPaidLineItems(
  stripe: Stripe,
  sessionId: string
): Promise<PaidLineItem[]> {
  const lines: PaidLineItem[] = [];
  for await (const item of stripe.checkout.sessions.listLineItems(sessionId, {
    limit: 100,
    expand: ['data.price.product'],
  })) {
    const product = item.price?.product;
    const productId =
      product && typeof product !== 'string' && !product.deleted
        ? product.metadata[PRODUCT_ID_METADATA_KEY]
        : undefined;
    if (!productId) {
      throw new Error(
        `Line item ${item.id} of session ${sessionId} has no ${PRODUCT_ID_METADATA_KEY} product metadata`
      );
    }
    lines.push({
      productId,
      name: item.description ?? '',
      quantity: item.quantity ?? 0,
      amountSubtotal: item.amount_subtotal,
      amountDiscount: item.amount_discount,
      amountTax: item.amount_tax,
      amountTotal: item.amount_total,
    });
  }
  return lines;
}

/**
 * Route one Checkout Session event of a StripeOrder item to the app hooks.
 *
 * - `completed` + `paid` / `no_payment_required` → `onOrderPaid`
 * - `completed` + `unpaid` (async method, e.g. SEPA debit) → wait for the async event
 * - `async_payment_succeeded` → `onOrderPaid`
 * - `async_payment_failed` → `onOrderPaymentFailed`
 * - `expired` → `onOrderExpired`
 *
 * @throws When the event API version is older than {@link MIN_ORDER_API_VERSION},
 * when metadata is incomplete, or when a hook throws
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export async function handleOrderSessionEvent(
  eventType: OrderSessionEventType,
  eventId: string,
  apiVersion: string | null,
  session: Stripe.Checkout.Session,
  billingConfigKey: string,
  orderItem: StripeOrderBackItem,
  stripe: Stripe
): Promise<void> {
  // API versions are date-prefixed (YYYY-MM-DD.name): compare the dates.
  // event.api_version is the webhook ENDPOINT's version, not STRIPE_API_VERSION.
  if (
    !apiVersion ||
    apiVersion.slice(0, 10) < MIN_ORDER_API_VERSION.slice(0, 10)
  ) {
    throw new Error(
      `Stripe event ${eventId} (order ${session.metadata?.[ORDER_ID_METADATA_KEY] ?? 'unknown'}) was rendered with API version ${apiVersion}; ` +
        `StripeOrder requires ${MIN_ORDER_API_VERSION} or later. Webhook payloads follow the webhook endpoint's API version, ` +
        `not STRIPE_API_VERSION, and an existing endpoint's version cannot be edited: create a new endpoint ` +
        `(POST /v1/webhook_endpoints with api_version=${MIN_ORDER_API_VERSION}), set STRIPE_WEBHOOK_SECRET to its signing secret, ` +
        `disable the old endpoint, then resend the failed events. Stripe retries this event for up to 3 days.`
    );
  }

  const metadata = session.metadata ?? {};
  const userId = metadata.userId;
  const orderId = metadata[ORDER_ID_METADATA_KEY];
  if (!userId || !orderId) {
    throw new Error(
      `Order session ${session.id} is missing metadata: userId=${userId}, orderId=${orderId}`
    );
  }

  const ctx: OrderHookContext = { userId, orderId, billingConfigKey, eventId };
  const snapshot = toCheckoutSessionSnapshot(session);

  const isPaidNow =
    eventType === 'checkout.session.async_payment_succeeded' ||
    (eventType === 'checkout.session.completed' &&
      session.payment_status !== 'unpaid');

  if (isPaidNow) {
    const lineItems = await listPaidLineItems(stripe, session.id);
    await orderItem.onOrderPaid(snapshot, lineItems, ctx);
    logger.info('[Webhook] Order paid', {
      orderId,
      billingConfigKey,
      operation: 'order_paid',
    });
    return;
  }

  switch (eventType) {
    case 'checkout.session.completed':
      logger.info('[Webhook] Order awaiting async payment', {
        orderId,
        billingConfigKey,
        operation: 'order_payment_pending',
      });
      return;
    case 'checkout.session.async_payment_failed':
      if (orderItem.onOrderPaymentFailed) {
        await orderItem.onOrderPaymentFailed(snapshot, ctx);
      }
      logger.warn('[Webhook] Order payment failed', {
        orderId,
        billingConfigKey,
        operation: 'order_payment_failed',
      });
      return;
    case 'checkout.session.expired':
      if (orderItem.onOrderExpired) {
        await orderItem.onOrderExpired(snapshot, ctx);
      }
      logger.info('[Webhook] Order checkout expired', {
        orderId,
        billingConfigKey,
        operation: 'order_expired',
      });
      return;
    default:
      return;
  }
}

/**
 * Map a Stripe TaxId to the provider-neutral snapshot given to `onTaxIdUpdated`.
 *
 * @param taxId - TaxId from a `customer.tax_id.updated` event
 * @returns Snapshot
 *
 * @version 0.2.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */
export function toTaxIdSnapshot(taxId: Stripe.TaxId): TaxIdSnapshot {
  return {
    id: taxId.id,
    customerId: idOf(taxId.customer),
    type: taxId.type,
    value: taxId.value,
    country: taxId.country,
    verification: taxId.verification && {
      status: taxId.verification.status,
      verifiedName: taxId.verification.verified_name,
      verifiedAddress: taxId.verification.verified_address,
    },
  };
}

/**
 * Handle `customer.tax_id.updated`: run `onTaxIdUpdated` of every StripeOrder item
 * that defines it, once per distinct function. Called by `processWebhook` after
 * signature verification and idempotency reservation (same path as order events).
 *
 * @param eventId - Stripe event ID
 * @param taxId - TaxId from the event
 * @param config - App back config
 * @throws When a hook throws (the webhook answers non-2xx and Stripe retries)
 *
 * @version 0.2.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */
export async function handleTaxIdUpdated(
  eventId: string,
  taxId: Stripe.TaxId,
  config: StripeBackConfig
): Promise<void> {
  const snapshot = toTaxIdSnapshot(taxId);
  const ran = new Set<StripeOrderBackItem['onTaxIdUpdated']>();
  for (const [billingConfigKey, item] of Object.entries(config)) {
    if (item.type !== 'StripeOrder' || !item.onTaxIdUpdated) continue;
    if (ran.has(item.onTaxIdUpdated)) continue;
    ran.add(item.onTaxIdUpdated);
    await item.onTaxIdUpdated(snapshot, { billingConfigKey, eventId });
    logger.info('[Webhook] Tax ID updated', {
      taxIdId: snapshot.id,
      status: snapshot.verification?.status ?? null,
      billingConfigKey,
      operation: 'tax_id_updated',
    });
  }
  if (ran.size === 0) {
    logger.debug('[Webhook] customer.tax_id.updated without onTaxIdUpdated hook', {
      eventId,
    });
  }
}
